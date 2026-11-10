import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repository } from "./helpers.mjs";
import { SwarmSessions } from "../extensions/swarm/sessions.mjs";
import { budgetStatus, failureAllowance } from "../extensions/swarm/status.mjs";
import { swarmSummary, registerMainTools } from "../extensions/swarm/main-tools.mjs";

const snapshot = status => ({ ownershipHeld: true, run: { runId: "run", objective: "test", status, cycle: 1, revision: 4, elapsedMs: 800, lastAtMs: 1000, limits: { agents: 3, active: 2, tasks: 4, attempts: 3, durationMs: 1000 }, workers: [{ id: "worker" }], tasksCreated: 4, tasks: [{ id: "task", title: "Task", status: "ready", failures: 0, dependencies: [], criteria: [0], assignment: { workerId: "worker", kind: "build" } }], messages: [{ text: "private history" }], sessions: { turns: [], selection: {}, workerModels: [] }, workspace: { operations: [], receipts: [] } } });

test("durable sends do not claim enqueue when pause or stop interleaves after persistence", async t => {
	for (const status of ["pausing", "stopping", "paused", "stopped"]) {
		for (const to of ["worker", "@board"]) {
			const state = { status: "running", workers: [{ id: "worker" }], sessions: { turns: [] } };
			let releasePersistence;
			const persisted = new Promise(resolve => { releasePersistence = resolve; });
			const controller = { layout: { sessionDir: join(repository(t), "sessions") }, snapshot: () => state,
				owner: async (type, payload) => { assert.equal(type, "message.send"); assert.equal(payload.to, to); await persisted; return { operationId: "mail-receipt", revision: 7 }; } };
			const driver = new SwarmSessions(controller, {}, {}, 0);
			const sending = driver.send(to, "message", to === "@board" ? "topic" : undefined);
			state.status = status;
			releasePersistence();
			const receipt = await sending;
			assert.equal(receipt.persisted, true);
			assert.equal(receipt.operationId, "mail-receipt");
			assert.equal(receipt.dispatch, "not-enqueued");
			assert.equal(receipt.enqueuedRecipients, 0);
			assert.equal(receipt.acknowledged, false);
			assert.deepEqual(driver.snapshot().queued, []);
		}
	}
});

test("budgets use persisted active-time samples, not wall-clock guesses", () => {
	for (const status of ["paused", "running", "pausing", "stopped"]) {
		const state = snapshot(status), before = structuredClone(state);
		const budgets = budgetStatus(state);
		assert.equal(budgets.duration.remaining, 200);
		assert.equal(budgets.duration.deadline, null);
		assert.equal(budgets.duration.advancing, ["running", "pausing"].includes(status));
		assert.equal(budgets.nativeTurns.used, 0);
		assert.equal(budgets.assignedTasks, 1);
		assert.equal(budgets.queuedWorkers, null);
		assert.equal(budgets.taskCreations.blocks, "new tasks");
		assert.deepEqual(state, before);
	}
	const state = snapshot("running"); state.run.elapsedMs = 1100; state.driver = { queued: ["worker"] };
	assert.equal(budgetStatus(state).duration.state, "exhausted");
	assert.equal(budgetStatus(state).queuedWorkers, 1);
});

test("warnings are bounded presentation settings and failures are not assignments", () => {
	assert.equal(budgetStatus(snapshot("paused"), 0).duration.state, "available");
	assert.equal(budgetStatus(snapshot("paused"), 0.5).duration.state, "near");
	for (const value of [-1, 0.6, NaN, "0.2"]) assert.throws(() => budgetStatus(snapshot("paused"), value));
	assert.deepEqual(failureAllowance({ failures: 0, pending: { kind: "submit" } }, 3), { used: 0, allowed: 3, remaining: 3, state: "available", pendingSettlement: true, blockedAdmission: false });
	assert.equal(failureAllowance({ failures: 3 }, 3).blockedAdmission, true);
	const old = snapshot("paused"); delete old.run.tasksCreated; delete old.run.sessions;
	assert.equal(budgetStatus(old).taskCreations.used, null);
	assert.equal(budgetStatus(old).nativeTurns.used, null);
});

test("compact status omits mail and signals caps and unknown outcomes", () => {
	const state = snapshot("paused");
	state.run.tasks = Array.from({ length: 51 }, (_, index) => ({ ...state.run.tasks[0], id: `task${index}` }));
	state.run.tasks[50].failures = 3;
	state.driver = { errors: [{ message: "PRIVATE_ERROR" }] };
	state.run.workspace.receipts = [{ outcome: "unknown" }];
	const summary = swarmSummary(state);
	assert.equal(summary.tasksTruncated, true);
	assert.deepEqual(summary.exhaustedTasks.ids, ["task50"]);
	assert.equal(summary.errorsPresent, true);
	assert.equal(JSON.stringify(summary).includes("PRIVATE_ERROR"), false);
	assert.equal(summary.workers[0].taskIdsTruncated, true);
	assert.equal(summary.messageCount, 1);
	assert.equal(summary.unknownEffects.recorded, 1);
	assert.equal(JSON.stringify(summary).includes("private history"), false);
});

test("invalid warning settings reject before status restore/control", async () => {
	const tools = new Map(); let controls = 0;
	registerMainTools({ registerTool: tool => tools.set(tool.name, tool) }, { inspect: () => ({}), control: () => controls++ });
	const result = await tools.get("swarm_status").execute("id", { warningThreshold: 0.6 }, null, null, {});
	assert.equal(result.isError, true); assert.equal(controls, 0);
});

test("explicit task and message pages reach beyond compact caps without dispatch", async () => {
	const tools = new Map(), state = snapshot("paused");
	const tasks = Array.from({ length: 55 }, (_, index) => ({ ...state.run.tasks[0], id: `task${index}` }));
	registerMainTools({ registerTool: tool => tools.set(tool.name, tool) }, { inspect: () => swarmSummary(state), tasks: () => tasks, messages: () => state.run.messages, history: () => [], control: () => { throw Error("must not dispatch"); } });
	const invoke = args => tools.get("swarm_history").execute("id", args, null, null, {});
	const page = (await invoke({ channel: "tasks", offset: 50, limit: 2 })).details;
	assert.equal(page.tasks[0].id, "task50"); assert.equal(page.nextOffset, 52);
	assert.equal((await invoke({ channel: "tasks", taskId: "task54" })).details.tasks[0].id, "task54");
	assert.equal((await invoke({ channel: "messages" })).details.messages[0].text, "private history");
});


test("worker cap is reported separately from aggregate exhaustion", () => {
	const state = snapshot("running");
	state.run.limits.modelRequests = 4; state.run.limits.workerModelRequests = 2;
	state.run.sessions.usage = [{ workerId: "worker", requests: 2, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unknownResponses: 0, pending: [], completed: [] }];
	assert.equal(budgetStatus(state).usageBlocker, null);
	assert.deepEqual(budgetStatus(state).workerUsageBlockers, [{ workerId: "worker", reason: "worker: workerModelRequests" }]);
	state.run.limits.modelRequests = 2;
	assert.equal(budgetStatus(state).usageBlocker, "modelRequests");
});
