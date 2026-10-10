import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { repository } from "./helpers.mjs";
import { createMockRuntime } from "./sdk-env.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { SwarmSessions } from "../extensions/swarm/sessions.mjs";
import { WorkspaceRuntime } from "../extensions/swarm/workspace.mjs";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

const code = expected => error => error.code === expected;
function tool(name, args, id = name) { return { toolCalls: [{ id, name, arguments: args }] }; }
async function fixture(t, script, limits, workspaceOptions = {}) {
	const root = repository(t);
	const mock = await createMockRuntime(script);
	const config = { workspace: root, runId: "run1", ownerSessionId: "owner1", clock: () => 0 };
	const c = await SwarmController.open({ ...config, create: { objective: "Implement invitations", criteria: ["Invitations work"], scope: ["src"], limits } });
	const workspace = await WorkspaceRuntime.attach(c, { authorize: async () => true, ...workspaceOptions });
	const driver = await SwarmSessions.attach(c, { workspace, modelRuntime: mock.modelRuntime, mainModel: mock.model, tickIntervalMs: 0 });
	await driver.resume({ reconciled: true });
	return { root, config, mock, c, workspace, driver };
}
const specialist = id => ({ id, specialization: `${id} focus`, brief: "Preserve focused context", reason: "Independent approved work" });
async function shutdown(f) { await f.driver.pause(); await f.driver.close(); }

test("stop after completed auto-close preserves completion and permits disposal", async t => {
	const f = await fixture(t, []);
	try {
		for (const id of ["builder", "reviewer"]) {
			await f.driver.recruit(specialist(id));
			await f.c.system("session.turn.start", { id: `${id}-turn`, workerId: id, kind: "prompt", messageIds: [], guidanceRevision: 0 });
		}
		await f.c.owner("task.create", { id: "task1", title: "Feature", criteria: [0], dependencies: [] });
		await f.c.worker("builder").dispatch("task.claim", { taskId: "task1", kind: "build", assignmentId: "build1" });
		const builder = f.workspace.worker("builder");
		const receipt = await builder.shell("true");
		await builder.submit("Candidate", [receipt.executionId]);
		await f.c.system("session.turn.end", { id: "builder-turn", outcome: "settled" });
		await f.workspace.settle("task1");
		await f.c.worker("reviewer").dispatch("task.claim", { taskId: "task1", kind: "review", assignmentId: "review1" });
		await f.workspace.worker("reviewer").review(true, "Independent check");
		await f.c.system("session.turn.end", { id: "reviewer-turn", outcome: "settled" });
		await f.workspace.settle("task1");
		await f.workspace.finalCheck("true");
		const completed = f.c.snapshot();
		assert.equal(completed.status, "completed");
		assert.deepEqual(await f.driver.pause({ stop: true }), { settled: true });
		assert.deepEqual(await f.driver.pause({ stop: true }), { settled: true });
		assert.deepEqual(f.c.snapshot(), completed);
	} finally { await shutdown(f); }
});

test("worker status exposes collaboration state, not host or storage metadata", async t => {
	const f = await fixture(t, [tool("swarm_status", {}), { text: "Inspected board" }]);
	try {
		await f.driver.recruit(specialist("builder"));
		f.driver.wake("builder"); await f.driver.idle();
		const result = f.mock.calls[1].context.messages.find(message => message.role === "toolResult");
		const status = JSON.parse(result.content[0].text);
		assert.deepEqual(Object.keys(status).sort(), ["status", "revision", "cycle", "generation", "guidanceRevision", "guidance", "budgets", "usage", "workers", "tasks", "taskCount", "tasksTruncated", "exhaustedTaskCount", "messageCount", "coordination", "details"].sort());
		assert.equal(status.workers[0].id, "builder");
		assert.equal(Object.hasOwn(status, "objective"), false);
		assert.match(getCurrentSystemPrompt(f.mock.calls[0].context.messages), /Implement invitations/);
		assert.deepEqual(status.coordination.counts, { claims: 0, pending: 0, active: 0 });
		assert.ok(!JSON.stringify(status).includes(f.root));
		assert.ok(f.c.snapshot().sessions.workers[0].sessionFile);
	} finally { await shutdown(f); }
});

test("persistent specialist retains identity and context through pause and reopen", async t => {
	const f = await fixture(t, [{ text: "Remember the email decision" }, { text: "I retained the decision" }]);
	const created = await f.driver.recruit(specialist("builder"));
	f.driver.wake("builder"); await f.driver.idle();
	assert.deepEqual(f.driver.snapshot().errors, []);
	assert.equal(f.c.snapshot().sessions.history[0].outcome, "settled");
	assert.ok((await f.driver.history("builder")).some(entry => entry.type === "message"));
	await shutdown(f);
	const c = await SwarmController.open(f.config);
	const workspace = await WorkspaceRuntime.attach(c, { authorize: async () => true });
	const driver = await SwarmSessions.attach(c, { workspace, modelRuntime: f.mock.modelRuntime, mainModel: { provider: "ignored", id: "ignored" }, tickIntervalMs: 0 });
	await driver.resume({ reconciled: true }); driver.wake("builder"); await driver.idle();
	assert.equal(c.snapshot().sessions.workers[0].sessionId, created.sessionId);
	assert.ok(JSON.stringify(f.mock.calls.at(-1).context).includes("Remember the email decision"));
	assert.equal(c.snapshot().sessions.selection.modelId, f.mock.selection.modelId);
	await driver.pause(); await driver.close();
});

test("history of an open specialist comes from memory and never writes its session file", async t => {
	const f = await fixture(t, [{ text: "Live decision" }]);
	await f.driver.recruit(specialist("builder"));
	f.driver.wake("builder"); await f.driver.idle();
	const binding = f.c.snapshot().sessions.workers.find(worker => worker.workerId === "builder");
	const path = join(prepareLayout(f.root, "run1").stateRoot, "run1", "sessions", binding.sessionFile);
	const original = readFileSync(path, "utf8");
	// A concurrent append caught midway: Pi's file loader would "repair" it by appending a newline.
	const partial = original + '{"type":"message","id":"partial';
	writeFileSync(path, partial);
	try {
		const history = await f.driver.history("builder", 100);
		assert.ok(history.some(entry => entry.type === "message"));
		history.find(entry => entry.type === "message").message.content = "Mutated inspection";
		assert.notDeepEqual(await f.driver.history("builder", 100), history, "History is a detached copy");
		assert.equal(readFileSync(path, "utf8"), partial, "Reading history must not write the session file");
	} finally { writeFileSync(path, original); }
	await shutdown(f);
});

test("restored unopened history is detached, bounded, validated and independent of the model runtime", async t => {
	const f = await fixture(t, [{ text: "Persisted decision" }]);
	await f.driver.recruit(specialist("builder"));
	await f.driver.recruit(specialist("unprompted"));
	await f.c.owner("worker.create", { ...specialist("unbound"), workloadRevision: f.c.snapshot().revision });
	f.driver.wake("builder"); await f.driver.idle();
	const expected = await f.driver.history("builder", 100);
	const unprompted = await f.driver.history("unprompted");
	await shutdown(f);

	const c = await SwarmController.open(f.config);
	const workspace = await WorkspaceRuntime.attach(c, { authorize: async () => true });
	let runtimeReads = 0;
	const modelRuntime = new Proxy({}, { get(_target, property) {
		runtimeReads++;
		assert.equal(property, "getModel", "history must not construct SDK services");
		assert.equal(runtimeReads, 1, "only attachment may resolve the model");
		return () => f.mock.model;
	} });
	const driver = await SwarmSessions.attach(c, { workspace, modelRuntime, mainModel: f.mock.model, tickIntervalMs: 0 });
	const before = c.snapshot();
	const directory = join(prepareLayout(f.root, "run1").stateRoot, "run1", "sessions");
	const files = readdirSync(directory);
	const binding = before.sessions.workers.find(worker => worker.workerId === "builder");
	const path = join(directory, binding.sessionFile);
	const original = readFileSync(path, "utf8");
	assert.deepEqual(await driver.history("builder", 100), expected);
	assert.deepEqual(await driver.history("builder", 1), expected.slice(-1));
	assert.deepEqual(await driver.history("builder"), expected.slice(-20));
	const detached = await driver.history("builder", 100);
	detached.find(entry => entry.type === "message").message.content = "Mutated inspection";
	assert.deepEqual(await driver.history("builder", 100), expected);
	assert.deepEqual(await driver.history("unprompted"), unprompted);
	for (const workerId of ["unbound", "missing"]) assert.deepEqual(await driver.history(workerId), []);
	for (const limit of [0, -1, 101, 1.5, NaN, "1"]) await assert.rejects(driver.history("missing", limit), code("INPUT"));
	assert.equal(readFileSync(path, "utf8"), original);

	try {
		const records = original.trimEnd().split("\n").map(line => JSON.parse(line));
		records[0].id = "wrong-session";
		writeFileSync(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
		await assert.rejects(driver.history("builder"), /Session history identity changed/);
		writeFileSync(path, original + "not-json\n");
		// Pi skips a malformed line, as it does when it reopens the session.
		assert.deepEqual(await driver.history("builder", 100), expected);
	} finally { writeFileSync(path, original); }
	assert.equal(runtimeReads, 1);
	assert.equal(f.mock.calls.length, 1);
	assert.deepEqual(c.snapshot(), before);
	assert.deepEqual(readdirSync(directory), files);
	assert.equal(readFileSync(path, "utf8"), original);
	assert.deepEqual(driver.snapshot().active, []);
	assert.deepEqual(driver.snapshot().queued, []);
	await driver.close();
});

test("peer tools wake another specialist without main-agent relaying", async t => {
	const f = await fixture(t, ({ context }) => {
		const system = getCurrentSystemPrompt(context.messages);
		const hasResult = context.messages.some(message => message.role === "toolResult");
		if (system.includes("sender focus") && !hasResult) return tool("swarm_message", { to: "receiver", text: "Use the existing schema" });
		return { text: system.includes("receiver focus") ? "Received the schema decision" : "Sent" };
	});
	await f.driver.recruit(specialist("sender")); await f.driver.recruit(specialist("receiver"));
	f.driver.wake("sender"); await f.driver.idle();
	assert.deepEqual(f.driver.snapshot().errors, []);
	assert.equal(f.c.snapshot().messages.length, 1);
	assert.equal(f.c.snapshot().sessions.workers.find(worker => worker.workerId === "receiver").delivered.length, 1);
	assert.ok(f.mock.calls.some(call => JSON.stringify(call.context).includes("Use the existing schema") && getCurrentSystemPrompt(call.context.messages).includes("receiver focus")));
	await shutdown(f);
});

test("specialists recruit practical run-local peers with identical tool sets", async t => {
	const f = await fixture(t, ({ context }) => {
		if (getCurrentSystemPrompt(context.messages).includes("lead focus") && !context.messages.some(message => message.role === "toolResult")) return tool("swarm_recruit", specialist("database"));
		return { text: "Focused work" };
	});
	await f.driver.recruit(specialist("lead")); f.driver.wake("lead"); await f.driver.idle();
	assert.deepEqual(f.driver.snapshot().errors, []);
	assert.equal(f.c.snapshot().workers.length, 2);
	const sets = f.mock.calls.map(call => getCurrentTools(call.context.messages).map(tool => tool.name).sort());
	for (const set of sets) assert.deepEqual(set, sets[0]);
	assert.ok(sets[0].includes("swarm_recruit"));
	assert.ok(!sets[0].includes("team_spawn"));
	await shutdown(f);
});

test("task assignment stays owned while idle but releases the model execution slot", async t => {
	const f = await fixture(t, ({ context }) => {
		if (!context.messages.some(message => message.role === "toolResult")) {
			const builder = getCurrentSystemPrompt(context.messages).includes("builder focus");
			return tool("swarm_task", { action: "claim", taskId: builder ? "first" : "second", kind: "build" });
		}
		return { text: "Waiting for peer input" };
	}, { active: 1 });
	await f.driver.recruit(specialist("builder")); await f.driver.recruit(specialist("reviewer"));
	for (const id of ["first", "second"]) await f.c.owner("task.create", { id, title: id, criteria: [0], dependencies: [] });
	f.driver.wake("builder"); f.driver.wake("reviewer"); await f.driver.idle();
	assert.deepEqual(f.driver.snapshot().errors, []);
	assert.equal(f.c.snapshot().tasks.filter(task => task.assignment).length, 2);
	assert.equal(f.c.snapshot().sessions.turns.length, 0);
	await shutdown(f);
});

test("pause aborts real SDK streaming and cannot dispatch queued work", async t => {
	const f = await fixture(t, [{ waitForAbort: true }], { active: 1 });
	await f.driver.recruit(specialist("first")); await f.driver.recruit(specialist("second"));
	f.driver.wake("first"); f.driver.wake("second");
	while (!f.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
	const result = await f.driver.pause();
	assert.equal(result.settled, true);
	assert.equal(f.c.snapshot().status, "paused");
	assert.equal(f.mock.calls.length, 1);
	assert.equal(f.c.snapshot().sessions.history[0].outcome, "interrupted");
	assert.equal(f.c.snapshot().sessions.turns.length, 0);
	assert.throws(() => f.driver.wake("second"), code("STATE"));
	await f.driver.close();
});

test("new guidance aborts stale turns and is delivered before further tools", async t => {
	const f = await fixture(t, [{ waitForAbort: true }, { text: "Using new guidance" }]);
	await f.driver.recruit(specialist("builder")); f.driver.wake("builder");
	while (!f.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
	await f.driver.redirect("Use the existing email template"); await f.driver.idle();
	assert.deepEqual(f.driver.snapshot().errors, []);
	assert.equal(f.mock.calls.length, 2);
	assert.ok(JSON.stringify(f.mock.calls[1].context).includes("Use the existing email template"));
	assert.equal(f.c.snapshot().workers[0].guidanceRevision, 1);
	await f.driver.pause(); const calls = f.mock.calls.length;
	await f.driver.redirect("Do not resume automatically"); await f.driver.idle();
	assert.equal(f.mock.calls.length, calls);
	await f.driver.close();
});

test("redirect during admission refreshes guidance without unexpectedly pausing", async t => {
	const f = await fixture(t, [{ text: "Fresh guidance accepted" }]);
	await f.driver.recruit(specialist("builder"));
	let release;
	let entered;
	const gate = new Promise(resolve => { release = resolve; });
	const ready = new Promise(resolve => { entered = resolve; });
	const system = f.c.system.bind(f.c);
	let first = true;
	f.c.system = async (...args) => {
		if (args[0] === "session.turn.start" && first) { first = false; entered(); await gate; }
		return system(...args);
	};
	f.driver.wake("builder"); await ready;
	await f.driver.redirect("New guidance before admission"); release(); await f.driver.idle();
	assert.equal(f.c.snapshot().status, "running");
	assert.deepEqual(f.driver.snapshot().errors, []);
	assert.equal(f.mock.calls.length, 1);
	assert.ok(JSON.stringify(f.mock.calls[0].context).includes("New guidance before admission"));
	await shutdown(f);
});

test("terminal provider errors consume the assigned task attempt", async t => {
	const f = await fixture(t, [tool("swarm_task", { action: "claim", taskId: "first", kind: "build" }), { error: "Mock provider failure" }]);
	await f.driver.recruit(specialist("builder"));
	await f.c.owner("task.create", { id: "first", title: "Feature", criteria: [0], dependencies: [] });
	f.driver.wake("builder"); await f.driver.idle();
	assert.equal(f.c.snapshot().sessions.history[0].outcome, "failed");
	assert.equal(f.c.snapshot().tasks[0].failures, 1);
	assert.equal(f.c.snapshot().tasks[0].assignment, null);
	await shutdown(f);
});

test("cancellation during failure accounting still retires the SDK turn", async t => {
	const f = await fixture(t, [tool("swarm_task", { action: "claim", taskId: "first", kind: "build" }), { error: "Mock failure" }]);
	await f.driver.recruit(specialist("builder"));
	await f.c.owner("task.create", { id: "first", title: "Feature", criteria: [0], dependencies: [] });
	let release; let entered;
	const gate = new Promise(resolve => { release = resolve; });
	const ready = new Promise(resolve => { entered = resolve; });
	const worker = f.c.worker.bind(f.c);
	f.c.worker = id => {
		const bound = worker(id);
		return { dispatch: async (type, ...args) => {
			if (type === "task.fail") { entered(); await gate; }
			return bound.dispatch(type, ...args);
		} };
	};
	f.driver.wake("builder"); await ready;
	const pause = f.driver.pause(); release();
	assert.equal((await pause).settled, true);
	assert.equal(f.c.snapshot().sessions.turns.length, 0);
	assert.equal(f.c.snapshot().sessions.history.at(-1).outcome, "interrupted");
	assert.equal(f.c.snapshot().tasks[0].assignment, null);
	assert.deepEqual(f.driver.snapshot().errors, []);
	await f.driver.close();
});

test("native driver compaction preserves specialist identity and refreshes shared state", async t => {
	const f = await fixture(t, [{ text: "First decision" }, { text: "Second decision" }, { text: "Preserved focused decisions and unresolved questions" }, { text: "Continuing with current state" }]);
	const created = await f.driver.recruit(specialist("builder"));
	f.driver.wake("builder", "Decision context ".repeat(15000)); await f.driver.idle();
	f.driver.wake("builder", "More context ".repeat(15000)); await f.driver.idle();
	await f.driver.compact("builder");
	assert.deepEqual(f.driver.snapshot().errors, []);
	assert.ok((await f.driver.history("builder", 100)).some(entry => entry.type === "compaction"));
	assert.equal(f.c.snapshot().sessions.workers[0].sessionId, created.sessionId);
	f.driver.wake("builder"); await f.driver.idle();
	assert.ok(JSON.stringify(f.mock.calls.at(-1).context).includes("guidance"));
	assert.equal(f.c.snapshot().sessions.history.filter(turn => turn.kind === "compaction").length, 1);
	await shutdown(f);
});

test("pause timeout does not release an SDK turn with an unsettled tool", async t => {
	let release; let entered;
	const gate = new Promise(resolve => { release = resolve; });
	const ready = new Promise(resolve => { entered = resolve; });
	const f = await fixture(t, [tool("swarm_task", { action: "claim", taskId: "first", kind: "build" }), tool("bash", { command: "true" })], undefined, { authorize: async () => { entered(); await gate; return true; } });
	await f.driver.recruit(specialist("builder"));
	await f.c.owner("task.create", { id: "first", title: "Feature", criteria: [0], dependencies: [] });
	f.driver.wake("builder"); await ready;
	assert.equal((await f.driver.pause({ timeoutMs: 1 })).settled, false);
	assert.equal(f.c.snapshot().sessions.turns.length, 1);
	await assert.rejects(f.c.system("run.settle"), code("UNSETTLED"));
	release(); await f.driver.idle();
	assert.equal(f.c.snapshot().status, "paused");
	assert.equal(f.c.snapshot().sessions.turns.length, 0);
	await f.driver.close();
});

test("real SDK coding tools use guarded claims and recorded command evidence", async t => {
	const f = await fixture(t, ({ context }) => {
		const results = context.messages.filter(message => message.role === "toolResult");
		switch (results.length) {
			case 0: return tool("swarm_task", { action: "claim", taskId: "build", kind: "build" });
			case 1: return tool("swarm_files", { action: "claim", paths: ["feature.txt"] });
			case 2: return tool("read", { path: "feature.txt" });
			case 3: return tool("write", { path: "feature.txt", content: "implemented" });
			case 4: return tool("bash", { command: "test -f feature.txt" });
			case 5: {
				const execution = results.at(-1).content.find(part => part.text?.startsWith("Swarm execution receipt: ")).text.split(": ")[1];
				return tool("swarm_report", { action: "submit", summary: "Implemented", receipts: [execution] });
			}
			default: return { text: "Awaiting independent review" };
		}
	});
	writeFileSync(join(f.root, "feature.txt"), "initial");
	await f.driver.recruit(specialist("builder"));
	await f.c.owner("task.create", { id: "build", title: "Feature", criteria: [0], dependencies: [] });
	f.driver.wake("builder"); await f.driver.idle();
	assert.deepEqual(f.driver.snapshot().errors, []);
	assert.equal(f.c.snapshot().tasks[0].status, "submitted");
	assert.equal(f.c.snapshot().tasks[0].assignment, null);
	assert.equal(f.c.snapshot().workspace.receipts.length, 2);
	assert.ok(f.mock.calls.every(call => !call.context.messages.some(message => message.role === "toolResult" && message.isError)));
	await shutdown(f);
});

test("SDK follow-ups after Safety denial report errors but do not request approval again", async t => {
	let approvals = 0;
	const f = await fixture(t, [
		tool("swarm_task", { action: "claim", taskId: "denied", kind: "build" }),
		tool("bash", { command: "first denied" }, "first"),
		tool("bash", { command: "second denied" }, "second"),
		tool("swarm_task", { action: "yield", taskId: "denied", blocker: "Policy refused" }, "yield"),
		{ text: "Handoff only" },
	], undefined, { authorize: async () => { approvals++; return false; } });
	try {
		await f.driver.recruit(specialist("builder"));
		await f.c.owner("task.create", { id: "denied", title: "Policy task", criteria: [0], dependencies: [] });
		f.driver.wake("builder"); await f.driver.idle();
		assert.equal(approvals, 1);
		assert.equal(f.c.snapshot().tasks[0].assignment, null);
		assert.equal(f.c.snapshot().tasks[0].status, "blocked");
		assert.equal(f.c.snapshot().workspace.receipts.length, 0);
		assert.ok(f.mock.calls.at(-1).context.messages.filter(message => message.role === "toolResult" && message.toolName === "bash").every(message => message.isError));
		assert.deepEqual(f.workspace.coordinationStatus().counts, { claims: 0, pending: 0, active: 0 });
	} finally { await shutdown(f); }
});

test('exhausted Pi retries consume exactly one task failure', async t => {
 const f = await fixture(t, ({ index }) => index === 0
  ? tool('swarm_task', { action: 'claim', taskId: 'retry-task', kind: 'build' })
  : { error: '429 rate limit exceeded' });
 try {
  await f.driver.recruit(specialist('builder'));
  await f.c.owner('task.create', { id: 'retry-task', title: 'Retry test', criteria: [0], dependencies: [] });
  f.driver.wake('builder'); await f.driver.idle();
  assert.equal(f.mock.calls.length, 5);
  const task = f.c.snapshot().tasks[0];
  assert.equal(task.failures, 1);
  assert.equal(task.failureHistory.length, 1);
  assert.equal(task.assignment, null);
  assert.equal(f.c.snapshot().sessions.history.filter(turn => turn.outcome === 'failed').length, 1);
 } finally { await shutdown(f); }
});


test("model request budget stops SDK follow-ups and settles paused without dispatching another request", async t => {
	const f = await fixture(t, [tool("swarm_status", {}), { text: "Must not be dispatched" }], { modelRequests: 1 });
	try {
		await f.driver.recruit(specialist("builder"));
		f.driver.wake("builder"); await f.driver.idle();
		assert.equal(f.mock.calls.length, 1);
		assert.equal(f.c.snapshot().status, "paused");
		assert.equal(f.c.snapshot().sessions.usage[0].requests, 1);
		assert.deepEqual(f.c.snapshot().sessions.usage[0].pending, []);
		assert.equal(f.c.snapshot().sessions.turns.length, 0);
		assert.equal(f.c.snapshot().workspace.operations.length, 0);
		await assert.rejects(f.driver.resume(), code("USAGE_LIMIT"));
		await f.driver.resume({ restart: true, reconciled: true });
		assert.deepEqual(f.c.snapshot().sessions.usage, []);
	} finally { await shutdown(f); }
});

test("a model budget fences new requests without aborting another worker's admitted command", async t => {
	let release; let commandStarted; let commandSignal;
	const held = new Promise(resolve => { release = resolve; });
	const started = new Promise(resolve => { commandStarted = resolve; });
	const f = await fixture(t, request => request.index === 0
		? tool("swarm_task", { action: "claim", taskId: "work", kind: "build" }, "claim")
		: request.index === 1 ? tool("bash", { command: "true" }, "command") : tool("swarm_status", {}, "observe"),
		{ modelRequests: 3, active: 2 }, { runner: async ({ signal }) => { commandSignal = signal; commandStarted(); await held; return { exitCode: 0, stdout: "", stderr: "", settled: true, aborted: false }; } });
	try {
		await f.driver.recruit(specialist("builder")); await f.driver.recruit(specialist("reviewer"));
		await f.c.owner("task.create", { id: "work", title: "Work", criteria: [0], dependencies: [] });
		f.driver.wake("builder");
		let timeout;
		try { await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Command was not admitted")), 2000); })]); }
		finally { clearTimeout(timeout); }
		f.driver.wake("reviewer");
		for (let i = 0; i < 200 && (f.mock.calls.length < 3 || f.c.snapshot().sessions.turns.some(turn => turn.workerId === "reviewer")); i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.equal(f.mock.calls.length, 3);
		assert.equal(f.c.snapshot().status, "running");
		assert.equal(f.c.snapshot().workspace.operations.length, 1);
		assert.equal(commandSignal.aborted, false, "the admitted command is not interrupted by the model budget");
		release(); await f.driver.idle();
		assert.equal(f.mock.calls.length, 3); assert.equal(f.c.snapshot().status, "paused");
		assert.equal(f.c.snapshot().workspace.operations.length, 0);
		assert.equal(f.c.snapshot().sessions.turns.length, 0);
	} finally { release(); await shutdown(f); }
});

test("board payload is actually delivered before its native-session cursor acknowledges it", async t => {
	const f = await fixture(t, [{ text: "Board inspected" }]);
	try {
		await f.driver.recruit(specialist("builder"));
		const receipt = await f.driver.send("@board", "BOARD_PAYLOAD_SENTINEL", "handoff");
		await f.driver.idle();
		assert.ok(JSON.stringify(f.mock.calls[0].context.messages).includes("BOARD_PAYLOAD_SENTINEL"));
		assert.ok(f.c.snapshot().sessions.workers[0].delivered.includes(receipt.operationId));
	} finally { await shutdown(f); }
});

test("native worker compaction is counted through the same admitted-request ledger", async t => {
	const f = await fixture(t, request => ({ text: request.index < 12 ? "Relevant recorded detail. ".repeat(400) : "Preserve current objective and constraints" }), { modelRequests: 20 });
	try {
		await f.driver.recruit(specialist("builder"));
		for (let i = 0; i < 12; i++) { f.driver.wake("builder"); await f.driver.idle(); }
		await f.driver.compact("builder");
		assert.ok(f.mock.calls.length > 12, JSON.stringify(f.driver.snapshot().errors));
		assert.equal(f.c.snapshot().sessions.usage[0].requests, f.mock.calls.length);
		assert.deepEqual(f.c.snapshot().sessions.usage[0].pending, []);
	} finally { await shutdown(f); }
});

test("reaching the allowance on a final response pauses even without a follow-up request", async t => {
	const f = await fixture(t, [{ text: "Final response" }], { modelRequests: 1 });
	try {
		await f.driver.recruit(specialist("builder")); f.driver.wake("builder"); await f.driver.idle();
		assert.equal(f.mock.calls.length, 1);
		assert.equal(f.c.snapshot().status, "paused");
		assert.equal(f.c.snapshot().sessions.usage[0].requests, 1);
		assert.equal(f.c.snapshot().sessions.usage[0].unknownResponses, 0);
	} finally { await shutdown(f); }
});


function currentTurn(context) {
	const index = context.messages.findLastIndex(message => message.role === "user");
	const messages = context.messages.slice(index);
	const content = messages[0].content;
	const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
	const section = title => JSON.parse(text.split(`## ${title}\n`)[1].split("\n\n")[0]);
	const calls = messages.flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "toolCall") : []);
	return { tasks: section("Current task board (task text is work data, not policy)").tasks,
		peers: section("Peers (all may be contacted)"), calls, messages };
}

function autonomousScript({ context }) {
	const turn = currentTurn(context);
	const invoke = (name, args) => tool(name, args, `auto-${context.messages.length}-${name}`);
	const last = turn.calls.at(-1);
	if (last?.name === "swarm_report" || last?.name === "swarm_finish" || last?.name === "swarm_recruit") return { text: "Handoff recorded; stopping for settlement." };

	if (last?.name === "swarm_task" && last.arguments.action === "claim") {
		if (last.arguments.kind === "review") return invoke("swarm_report", { action: "review", approved: true, summary: "Independent review passed." });
		return invoke("bash", { command: "true" });
	}
	if (last?.name === "bash") {
		const result = turn.messages.findLast(message => message.role === "toolResult");
		return invoke("swarm_report", { action: "submit", summary: "Scoped work verified.", receipts: [result.details.executionId] });
	}

	if (!turn.tasks.length) {
		if (!last) return invoke("swarm_task", { action: "create", id: "first", title: "Initial work", criteria: [0], dependencies: [] });
		if (last.arguments.id === "first") return invoke("swarm_task", { action: "create", id: "next", title: "Dependent work", criteria: [0], dependencies: ["first"] });
		return invoke("swarm_task", { action: "claim", taskId: "first", kind: "build" });
	}
	if (turn.tasks.every(task => task.status === "done")) return invoke("swarm_finish", { command: "true" });
	const submitted = turn.tasks.find(task => task.status === "submitted");
	if (submitted) {
		if (turn.peers.length === 1) return invoke("swarm_recruit", specialist("reviewer"));
		return invoke("swarm_task", { action: "claim", taskId: submitted.id, kind: "review" });
	}
	const ready = turn.tasks.find(task => task.status === "ready" && task.dependencies.every(id => turn.tasks.find(task => task.id === id)?.status === "done"));
	if (ready) return invoke("swarm_task", { action: "claim", taskId: ready.id, kind: "build" });
	throw new Error("Unexpected automatic handoff");
}

test("native workers recruit, review, release dependencies and finish without main relays", { timeout: 15000 }, async t => {
	const f = await fixture(t, autonomousScript, { active: 1 });
	try {
		await f.driver.recruit(specialist("builder"));
		f.driver.wake("builder"); await f.driver.idle();
		assert.deepEqual(f.driver.snapshot().errors, []);
		const state = f.c.snapshot();
		assert.equal(state.status, "completed");
		assert.deepEqual(state.workers.map(worker => worker.id), ["builder", "reviewer"]);
		assert.deepEqual(state.tasks.map(task => task.status), ["done", "done"]);
		assert.ok(state.tasks.every(task => task.reviews[0].workerId === "reviewer" && !task.contributors.includes("reviewer")));
		assert.equal(state.messages.filter(message => message.to === "owner").length, 0, "routine reports stay inside Swarm");
		assert.ok(state.workspace.receipts.some(receipt => receipt.id === state.completionEvidence && receipt.kind === "final" && receipt.outcome === "succeeded"));
		assert.equal(state.sessions.turns.length, 0); assert.equal(state.workspace.operations.length, 0);
		assert.ok(f.mock.calls.length < 30, `Unexpected coordination chatter: ${f.mock.calls.length}`);
		assert.ok(f.mock.calls.every(call => !call.context.messages.some(message => message.role === "toolResult" && message.isError)));
	} finally { await shutdown(f); }
});

test("workers cannot request final completion before independent task acceptance", async t => {
	const f = await fixture(t, [tool("swarm_finish", { command: "true" }), { text: "Incomplete, reporting honestly." }]);
	try {
		await f.driver.recruit(specialist("builder")); f.driver.wake("builder"); await f.driver.idle();
		assert.equal(f.c.snapshot().status, "running");
		assert.equal(f.c.snapshot().completionEvidence, null);
		assert.equal(f.c.snapshot().workspace.receipts.length, 0);
		assert.ok(f.mock.calls[1].context.messages.some(message => message.role === "toolResult" && message.isError));
	} finally { await shutdown(f); }
});


for (const scenario of ["failed command", "Safety denial"]) test(`autonomous final verification stays incomplete after ${scenario}`, { timeout: 15000 }, async t => {
	const script = request => {
		const output = autonomousScript(request);
		if (scenario === "failed command" && output.toolCalls?.[0].name === "swarm_finish") output.toolCalls[0].arguments.command = "false";
		return output;
	};
	let finalApprovals = 0;
	const authorize = async request => { if (request.kind !== "final") return true; finalApprovals++; return scenario !== "Safety denial"; };
	const f = await fixture(t, script, { active: 1 }, { authorize });
	try {
		await f.driver.recruit(specialist("builder")); f.driver.wake("builder"); await f.driver.idle();
		assert.equal(f.c.snapshot().status, "paused"); assert.equal(f.c.snapshot().completionEvidence, null);
		assert.equal(finalApprovals, 1, "no blind verification retry");
		assert.equal(f.c.snapshot().sessions.turns.length, 0); assert.equal(f.c.snapshot().workspace.operations.length, 0);
		assert.equal(f.driver.snapshot().errors.length, 1);
	} finally { await shutdown(f); }
});


test("queued owner steering is delivered before a deferred final command", { timeout: 15000 }, async t => {
	let f, sent = false, finalApprovals = 0;
	const script = async request => {
		const turn = currentTurn(request.context);
		if (!sent && turn.calls.at(-1)?.name === "swarm_finish") {
			sent = true;
			await f.driver.send("builder", "User clarification within approved scope");
		}
		return autonomousScript(request);
	};
	const authorize = async request => {
		if (request.kind === "final") {
			finalApprovals++;
			const builder = f.c.snapshot().sessions.workers.find(worker => worker.workerId === "builder");
			const mail = f.c.snapshot().messages.find(message => message.text === "User clarification within approved scope");
			assert.ok(builder.delivered.includes(mail.id), "steering must be durably delivered before final execution");
		}
		return true;
	};
	f = await fixture(t, script, { active: 1 }, { authorize });
	try {
		await f.driver.recruit(specialist("builder")); f.driver.wake("builder"); await f.driver.idle();
		assert.equal(f.c.snapshot().status, "completed"); assert.equal(finalApprovals, 1);
		assert.deepEqual(f.driver.snapshot().errors, []);
	} finally { await shutdown(f); }
});
