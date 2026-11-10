import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureWorkerContext, seedWorkerSession, assertWorkerContextReady, selectWorkerContext, validateWorkerContext, workerSessionStats } from "../extensions/subagents/context/fork.mjs";

function parentContext(percent) {
	const manager = SessionManager.inMemory("/fixture");
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Remember the green schema." }], timestamp: 1 });
	return { sessionManager: manager, getContextUsage: () => ({ percent }) };
}
function assistant(content) {
	return { role: "assistant", content, api: "fixture", provider: "fixture", model: "fixture", timestamp: 2, stopReason: "stop",
		usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: 160, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 } } };
}

for (const [percent, expected] of [[0, "fork"], [29.99, "fork"], [30, "focus"], [90, "focus"], [null, "focus"], [undefined, "focus"], [-1, "focus"], [101, "focus"]]) {
	test(`auto context at ${percent} selects ${expected}`, () => assert.equal(captureWorkerContext(parentContext(percent)).mode, expected));
}

test("main overrides the preference in either direction, including unknown usage", () => {
	assert.equal(captureWorkerContext(parentContext(90), "fork").mode, "fork");
	assert.equal(captureWorkerContext(parentContext(10), "focus").mode, "focus");
	assert.equal(captureWorkerContext(parentContext(null), "fork").mode, "fork");
	assert.throws(() => captureWorkerContext(parentContext(10), "invalid"), /contextMode/);
	assert.throws(() => captureWorkerContext({}, "fork"), /unavailable/);
	assert.equal(captureWorkerContext({ getContextUsage: () => ({ percent: 10 }) }).mode, "focus");
});

test("active branch and context edits are copied without inactive or removed content", () => {
	const ctx = parentContext(10), manager = ctx.sessionManager;
	const root = manager.getLeafId();
	manager.appendMessage({ role: "user", content: "Inactive branch secret", timestamp: 2 });
	manager.branch(root);
	const edited = manager.appendMessage({ role: "user", content: "Removed content", timestamp: 3 });
	manager.appendContextEdit(edited, null);
	const seed = captureWorkerContext(ctx);
	assert.match(JSON.stringify(seed.messages), /green schema/);
	assert.doesNotMatch(JSON.stringify(seed.messages), /Inactive branch secret|Removed content/);
	manager.appendMessage({ role: "user", content: "Later message", timestamp: 4 });
	assert.doesNotMatch(JSON.stringify(seed.messages), /Later message/);
});

test("completed tool pairs remain historical and unfinished calls are excluded", () => {
	const ctx = parentContext(10);
	ctx.sessionManager.appendMessage(assistant([{ type: "toolCall", id: "old", name: "read", arguments: { path: "fixture.txt" } }]));
	ctx.sessionManager.appendMessage({ role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "text", text: "Historical result" }], isError: false, timestamp: 3 });
	ctx.sessionManager.appendMessage(assistant([{ type: "text", text: "Starting worker" }, { type: "toolCall", id: "pending", name: "subagent_spawn", arguments: {} }]));
	const seed = captureWorkerContext(ctx);
	assert.match(JSON.stringify(seed.messages), /Historical result|Starting worker/);
	assert.doesNotMatch(JSON.stringify(seed.messages), /subagent_spawn|pending/);
	const worker = SessionManager.inMemory("/worker");
	seedWorkerSession(worker, seed);
	const count = worker.getEntries().length;
	seedWorkerSession(worker, seed);
	assert.equal(worker.getEntries().length, count, "a fork is seeded once");
	assert.match(JSON.stringify(worker.buildSessionContext().messages), /independent worker/);
	assert.notEqual(worker.getSessionId(), ctx.sessionManager.getSessionId());
	assert.doesNotMatch(JSON.stringify(worker.getEntries()), /model_change|thinking_level_change/);
});

test("focus copies no history, snapshots are integrity checked, incomplete copies fence reuse", () => {
	const ctx = parentContext(10), seed = captureWorkerContext(ctx);
	const worker = SessionManager.inMemory("/worker");
	seedWorkerSession(worker, captureWorkerContext(ctx, "focus"));
	assert.equal(worker.getEntries().length, 0);
	const changed = structuredClone(seed); changed.messages[0].content[0].text = "Changed";
	assert.throws(() => validateWorkerContext(changed), /changed/);
	worker.appendCustomEntry("worker-context", { status: "copying" });
	assert.throws(() => assertWorkerContextReady(worker), /did not finish/);
});

test("per-worker overrides use the approved retained snapshot", () => {
	const seed = captureWorkerContext(parentContext(80), "focus", true);
	assert.equal(seed.mode, "focus");
	assert.equal(selectWorkerContext(seed, "fork").messages.length, 1);
	assert.equal(selectWorkerContext(seed, "fork").mode, "fork");
	assert.equal(selectWorkerContext(captureWorkerContext(parentContext(10)), "focus").mode, "focus");
});

test("worker accounting excludes inherited usage while keeping native context estimates", () => {
	const ctx = parentContext(10);
	ctx.sessionManager.appendMessage(assistant([{ type: "text", text: "Parent response" }]));
	const worker = SessionManager.inMemory("/worker"); seedWorkerSession(worker, captureWorkerContext(ctx));
	const session = { sessionManager: worker, getSessionStats: () => ({ tokens: { input: 102, output: 11, cacheRead: 50, cacheWrite: 0, total: 163 }, cost: 3.1, assistantMessages: 2, contextUsage: { percent: 20 } }) };
	const stats = workerSessionStats(session);
	assert.equal(stats.tokens.total, 3); assert.equal(stats.assistantMessages, 1);
	assert.ok(Math.abs(stats.cost - 0.1) < 1e-9); assert.equal(stats.contextUsage.percent, 20);
});


test("fork copies the compaction-aware conversation instead of expanding old history", () => {
	const ctx = parentContext(10);
	ctx.sessionManager.appendMessage(assistant([{ type: "text", text: "Old detail omitted by compaction" }]));
	const kept = ctx.sessionManager.appendMessage({ role: "user", content: "Kept recent message", timestamp: 4 });
	ctx.sessionManager.appendCompaction("Retained compacted context", kept, 1000);
	const seed = captureWorkerContext(ctx);
	assert.match(JSON.stringify(seed.messages), /Retained compacted context|Kept recent message/);
	assert.doesNotMatch(JSON.stringify(seed.messages), /Old detail omitted by compaction/);
});


test("a reused tool-call ID does not make a new unfinished call look settled", () => {
	const ctx = parentContext(10);
	ctx.sessionManager.appendMessage(assistant([{ type: "toolCall", id: "same", name: "read", arguments: { path: "older.txt" } }]));
	ctx.sessionManager.appendMessage({ role: "toolResult", toolCallId: "same", toolName: "read", content: [{ type: "text", text: "Old settled result" }], isError: false, timestamp: 3 });
	ctx.sessionManager.appendMessage(assistant([{ type: "toolCall", id: "same", name: "write", arguments: { path: "new-unsettled.txt", content: "must not replay" } }]));
	const seed = captureWorkerContext(ctx);
	assert.match(JSON.stringify(seed.messages), /older.txt|Old settled result/);
	assert.doesNotMatch(JSON.stringify(seed.messages), /new-unsettled.txt|must not replay/);
});
