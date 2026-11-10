import test from "node:test";
import assert from "node:assert/strict";
import { createProgress } from "../extensions/swarm/progress.mjs";
import { registerMainTools, swarmSummary } from "../extensions/swarm/main-tools.mjs";

function fixture(t) {
	const snapshot = { run: { objective: "Fixture objective", status: "running", revision: 1, cycle: 1,
		workers: [{ id: "planner" }], tasks: [], sessions: { turns: [] }, workspace: { operations: [] } }, pendingApproval: false };
	const listeners = new Set(); const messages = []; const notifications = []; const statuses = [];
	let current = true;
	const context = { hasUI: true, ui: { setStatus: (...args) => statuses.push(args), notify: (...args) => notifications.push(args) } };
	const pi = { sendMessage: (...args) => messages.push(args) };
	const host = { snapshot: () => structuredClone(snapshot), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
	const progress = createProgress(pi, () => current ? context : undefined);
	progress.bind(host);
	t.after(() => progress.dispose());
	return { snapshot, messages, notifications, statuses, listeners, progress, invalidate: () => { current = false; },
		update: () => { for (const listener of listeners) listener("fixture"); } };
}

const delay = () => new Promise(resolve => setTimeout(resolve, 800));

test("routine progress produces no status row, transcript or model messages", async t => {
	const f = fixture(t); f.progress.launched();
	for (let i = 0; i < 40; i++) f.update();
	f.snapshot.run.tasks.push({ id: "task", title: "Task", status: "done", assignment: null });
	f.update(); f.update();
	f.snapshot.run.status = "completed"; f.update(); f.update();
	await delay();
	assert.deepEqual(f.messages, []);
	assert.deepEqual(f.notifications, []);
	assert.deepEqual(f.statuses, []);
});

test("important errors and stops remain notifications; approval/Safety surfaces are not replaced", async t => {
	const f = fixture(t); f.progress.launched();
	f.snapshot.pendingApproval = true; f.update();
	f.snapshot.errors = ["PRIVATE_PROVIDER_DIAGNOSTIC"]; f.update(); f.update();
	f.snapshot.run.status = "failed"; f.update(); f.update();
	f.snapshot.run.status = "stopped"; f.update(); f.update();
	assert.equal(f.notifications.length, 3);
	assert.deepEqual(f.notifications.map(([, level]) => level), ["error", "error", "warning"]);
	assert.doesNotMatch(JSON.stringify(f.notifications), /PRIVATE_/);
	f.progress.dispose();
	assert.equal(f.listeners.size, 0);
	await delay(); assert.deepEqual(f.messages, []);
});

test("inspection/restoration and stale owner context do not generate chat or model activity", async t => {
	const f = fixture(t);
	f.update(); await delay(); assert.equal(f.messages.length, 0);
	f.progress.launched(); f.invalidate();
	const notifications = f.notifications.length;
	f.snapshot.run.status = "stopped"; f.update();
	await delay(); assert.equal(f.messages.length, 0);
	assert.equal(f.notifications.length, notifications);
});

test("status bounds large boards, counts all tasks, and omits private host fields", () => {
	const snapshot = { errors: ["PRIVATE_ERROR"], run: { objective: "界".repeat(10000), status: "running", cycle: 1, revision: 1,
		workspaceRoot: "PRIVATE_HOST_PATH", ownerSessionId: "PRIVATE_OWNER", hostApprovals: [{ provider: "PRIVATE_PROVIDER" }],
		workers: [{ id: "planner" }], tasks: Array.from({ length: 500 }, (_, i) => ({ id: `task${i}`, title: "界".repeat(300), status: "blocked", blocker: "blocked", assignment: null })),
		sessions: { turns: [{ workerId: "planner" }] }, workspace: { operations: [] } } };
	const summary = swarmSummary(snapshot);
	assert.equal(summary.tasks.length, 10); assert.equal(summary.tasksTruncated, true);
	assert.equal(summary.progress.total, 500); assert.equal(summary.progress.blocked, 500);
	assert.equal(summary.objective.length, 512); assert.equal(summary.objectiveTruncated, true);
	assert.equal(summary.errorsPresent, true);
	assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_/);
});

test("main history pages preserve positions and omit provider diagnostics, signatures and host metadata", async () => {
	const tools = new Map();
	const entries = Array.from({ length: 31 }, (_, i) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(i === 0 ? 3000 : 4), textSignature: "PRIVATE_SIGNATURE" }], errorMessage: "PRIVATE_ERROR", responseId: "PRIVATE_RESPONSE" } }));
	registerMainTools({ registerTool: tool => tools.set(tool.name, tool) }, { inspect: () => ({ status: "paused" }), history: () => entries });
	const result = await tools.get("swarm_history").execute("id", { workerId: "planner", offset: 0, limit: 20 }, undefined, undefined, {});
	assert.equal(result.details.total, 31); assert.equal(result.details.nextOffset, 20);
	assert.equal(result.details.entries[0].truncated, true);
	assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
	const next = await tools.get("swarm_history").execute("id", { workerId: "planner", offset: 20, limit: 20 }, undefined, undefined, {});
	assert.equal(next.details.entries.length, 11); assert.equal(next.details.nextOffset, null);
	assert.equal(entries.length, 31);
});

test("proposal bookkeeping survives content-only native tool serialization but never grants approval", async () => {
	const tools = new Map();
	const proposalId = "11111111-2222-4333-8444-555555555555";
	registerMainTools({ registerTool: tool => tools.set(tool.name, tool) }, { chatControl: async () => ({
		awaitingConfirmation: true, proposalId, agreement: "Complete inspected agreement", confirmationPrompt: "Owner confirmation required",
	}) });
	const result = await tools.get("swarm_start").execute("proposal", { objective: "Goal" }, undefined, undefined, {});
	const contentOnly = result.content.map(part => part.text).join("\n");
	assert.match(contentOnly, new RegExp(`Proposal ID: ${proposalId}`));
	assert.match(contentOnly, /bookkeeping only; not approval/);
	assert.match(contentOnly, /No execution authorized/);
	assert.match(contentOnly, /no time limit; workspace and policy are revalidated/);
	assert.doesNotMatch(contentOnly, /expires at|Invalid Date/);
	assert.equal(result.details.awaitingConfirmation, true);
	assert.equal(Object.hasOwn(result.details, "expiresAt"), false);
});

test("main coordination status bounds entries and allowlists IDs, purposes and stages", () => {
	const valid = { owner: "1:0:0:assignment", workerId: "builder", taskId: "task", id: 1, kind: "exclusive", purpose: "shell", stage: "approval", cancellationRequested: true };
	const snapshot = { run: { workers: [], tasks: [], objective: "Goal" }, workspace: { coordinationStatus: {
		active: [valid, { ...valid, owner: "/private/path", workerId: "echo secret", taskId: "C:\\private", purpose: "private command", stage: "raw exception", command: "private command", paths: ["/private/path"] }],
		pending: Array.from({ length: 100 }, () => valid), counts: { active: 2, pending: 100, claims: 0 },
	} } };
	const summary = swarmSummary(snapshot);
	assert.equal(summary.coordination.pending.length, 32);
	assert.equal(summary.coordination.counts.pending, 100);
	assert.equal(summary.coordination.active[0].stage, "approval");
	assert.equal(summary.coordination.active[1].workerId, null);
	assert.doesNotMatch(JSON.stringify(summary.coordination), /private|secret|exception/);
});


test("usage warnings are bounded UI transitions without model wakeups or repeated chatter", t => {
	const f = fixture(t);
	f.snapshot.run.limits = { modelRequests: 10 };
	f.snapshot.run.sessions.usage = [{ workerId: "planner", requests: 8, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unknownResponses: 0, pending: [], completed: [] }];
	f.update(); f.update();
	assert.equal(f.notifications.length, 1); assert.match(f.notifications[0][0], /modelRequests allowance near/);
	f.snapshot.run.sessions.usage[0].requests = 10; f.update(); f.update();
	assert.equal(f.notifications.length, 2); assert.match(f.notifications[1][0], /exhausted/);
	assert.deepEqual(f.messages, []); assert.deepEqual(f.statuses, []);
});
