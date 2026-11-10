import test from "node:test";
import assert from "node:assert/strict";
import { reduceSession } from "../extensions/swarm/session-state.mjs";
import { usageTotals, usageLimitReason, aggregateUsageLimitReason, workerUsageLimitReason, measuredUsage } from "../extensions/swarm/usage.mjs";
import { workerStatus, incomingMessages } from "../extensions/swarm/worker-context.mjs";
import { buildTurnPrompt } from "../extensions/swarm/specializations.mjs";
import { machine } from "./helpers.mjs";

const sample = { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 };
const state = (limits = {}) => ({ status: "running", limits, workers: [{ id: "one" }, { id: "two" }], sessions: { turns: [{ workerId: "one" }, { workerId: "two" }], usage: [] } });
function apply(run, type, payload) {
	reduceSession(run, { type, payload, actor: "system" });
}

test("usage ledger counts retries independently, measures once and preserves missing usage", () => {
	const run = state();
	apply(run, "session.request", { id: "request-1", workerId: "one" });
	assert.equal(usageTotals(run).total.pendingResponses, 1);
	apply(run, "session.usage", { id: "request-1", workerId: "one", usage: sample });
	assert.throws(() => apply(run, "session.usage", { id: "request-1", workerId: "one", usage: sample }));
	apply(run, "session.request", { id: "request-2", workerId: "one" });
	apply(run, "session.usage", { id: "request-2", workerId: "one", usage: null });
	const total = usageTotals(run).total;
	assert.equal(total.requests, 2); assert.equal(total.input, 100); assert.equal(total.cacheRead, 900);
	assert.equal(total.output, 50); assert.equal(total.unknownResponses, 1);
	assert.doesNotMatch(JSON.stringify(usageTotals(run)), /request-1|request-2/);
	assert.equal(measuredUsage({ usage: { ...sample, reasoning: 20 } }).output, 50);
	assert.equal(measuredUsage({ usage: { input: 5 } }), null);
});

test("request limits are exact; token limits check measured completion and fence unresolved results", () => {
	const run = state({ modelRequests: 2, uncachedInputTokens: 200 });
	apply(run, "session.request", { id: "one", workerId: "one" });
	apply(run, "session.request", { id: "two", workerId: "two" });
	assert.equal(usageLimitReason(run), "modelRequests");
	assert.throws(() => apply(run, "session.request", { id: "third", workerId: "one" }), error => error.code === "USAGE_LIMIT");
	const tokenRun = state({ uncachedInputTokens: 200 });
	apply(tokenRun, "session.request", { id: "one", workerId: "one" });
	assert.equal(usageLimitReason(tokenRun), null, "concurrent live responses are allowed within active slots");
	tokenRun.sessions.turns = [];
	assert.equal(usageLimitReason(tokenRun), "unmeasured response", "recovered unknown effects are never assumed zero");
	apply(tokenRun, "session.usage", { id: "one", workerId: "one", usage: { ...sample, input: 250 } });
	assert.equal(usageLimitReason(tokenRun), "uncachedInputTokens");
});

test("optional usage limits are validated in durable run creation and old journals remain readable", () => {
	assert.equal(machine().state.limits.modelRequests, undefined);
	assert.equal(machine({ modelRequests: 10, uncachedInputTokens: 1000, outputTokens: 100 }).state.limits.outputTokens, 100);
	for (const limits of [{ modelRequests: 0 }, { outputTokens: -1 }, { arbitrary: 1 }]) assert.throws(() => machine(limits));
});

test("worker status is bounded without replaying conversations, candidate receipts or old reviews", () => {
	const run = { ...state(), tasks: Array.from({ length: 80 }, (_, i) => ({ id: `task-${i}`, title: "Task", status: "ready", failures: 0, dependencies: [], criteria: [0], candidate: { huge: "PRIVATE_RECEIPT" }, reviews: [{ summary: "PRIVATE_REVIEW" }] })), messages: [{ text: "PRIVATE_HISTORY" }], guidance: [], guidanceRevision: 0 };
	const summary = workerStatus(run, "one", {});
	assert.equal(summary.tasks.length, 20); assert.equal(summary.tasksTruncated, true);
	assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_/);
});

test("board messages admitted by pendingMail appear in the worker turn instead of disappearing", () => {
	const run = { ...state(), objective: "Work", criteria: ["Done"], scope: ["src"], tasks: [], guidance: [], revision: 1, guidanceRevision: 0, cycle: 1, generation: 0 };
	const messages = [{ id: "board", to: "@board", from: "two", topic: "task", text: "Owner constraint is data, not new authority", cycle: 1 }, { id: "peer", to: "one", from: "two", text: "Direct", cycle: 1 }, { id: "other", to: "two", from: "one", text: "UNRELATED", cycle: 1 }];
	assert.deepEqual(incomingMessages(run, "one", messages).map(message => message.id), ["board", "peer"]);
	const prompt = buildTurnPrompt(run, { id: "one" }, { messages });
	assert.match(prompt, /Owner constraint is data/); assert.doesNotMatch(prompt, /UNRELATED/);
});

test("per-worker allowances remain separate and an exhausted role cannot borrow another role's budget", () => {
	const run = state({ workerModelRequests: 2, workerOutputTokens: 100 });
	apply(run, "session.request", { id: "a", workerId: "one" }); apply(run, "session.usage", { id: "a", workerId: "one", usage: sample });
	apply(run, "session.request", { id: "b", workerId: "two" }); apply(run, "session.usage", { id: "b", workerId: "two", usage: sample });
	assert.equal(usageLimitReason(run), null);
	apply(run, "session.request", { id: "c", workerId: "one" }); apply(run, "session.usage", { id: "c", workerId: "one", usage: sample });
	assert.match(usageLimitReason(run), /one: workerModelRequests/);
	const workers = usageTotals(run).workers;
	assert.equal(workers[0].budgets.modelRequests.remaining, 0); assert.equal(workers[1].budgets.modelRequests.remaining, 1);
	assert.throws(() => apply(run, "session.request", { id: "d", workerId: "one" }), error => error.code === "USAGE_LIMIT");
	apply(run, "session.request", { id: "peer-second", workerId: "two" });
	assert.equal(usageTotals(run).workers[1].requests, 2);
	assert.throws(() => machine({ workerModelRequests: 0 }));
});

test("synthetic error/abort zero counters never establish measured zero token usage", () => {
	assert.equal(measuredUsage({ stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), null);
	assert.equal(measuredUsage({ stopReason: "aborted", usage: sample }), null);
});

for (const limits of [{ modelRequests: 2 }, { uncachedInputTokens: 200 }, { outputTokens: 100 }]) test(`aggregate admission remains global for ${JSON.stringify(limits)}`, () => {
	const run = state({ ...limits, workerModelRequests: 1 });
	apply(run, "session.request", { id: "first", workerId: "one" });
	apply(run, "session.usage", { id: "first", workerId: "one", usage: sample });
	assert.equal(aggregateUsageLimitReason(run), null);
	assert.equal(workerUsageLimitReason(run, "one"), "one: workerModelRequests");
	assert.equal(workerUsageLimitReason(run, "two"), null);
	run.sessions.usage.push({ ...structuredClone(run.sessions.usage[0]), workerId: "two", pending: [], completed: [] });
	assert.ok(aggregateUsageLimitReason(run));
	assert.throws(() => apply(run, "session.request", { id: "third", workerId: "two" }), error => error.code === "USAGE_LIMIT");
});

test("aggregate unknown response fencing is independent of worker identity", () => {
	const run = state({ outputTokens: 100 });
	apply(run, "session.request", { id: "unknown", workerId: "one" });
	apply(run, "session.usage", { id: "unknown", workerId: "one", usage: null });
	assert.equal(aggregateUsageLimitReason(run), "unmeasured response");
	assert.throws(() => apply(run, "session.request", { id: "peer", workerId: "two" }), error => error.code === "USAGE_LIMIT");
});

for (const [key, expected] of [["workerUncachedInputTokens", "workerUncachedInputTokens"], ["workerOutputTokens", "workerOutputTokens"]]) test(`unmeasured and exhausted ${key} fence only the affected worker`, () => {
	const run = state({ [key]: 50 });
	apply(run, "session.request", { id: "limited", workerId: "one" });
	apply(run, "session.usage", { id: "limited", workerId: "one", usage: sample });
	assert.equal(workerUsageLimitReason(run, "one"), `one: ${expected}`);
	assert.equal(aggregateUsageLimitReason(run), null);
	apply(run, "session.request", { id: "peer", workerId: "two" });
	assert.throws(() => apply(run, "session.request", { id: "blocked", workerId: "one" }), error => error.code === "USAGE_LIMIT");
	const unknown = state({ [key]: 50 });
	apply(unknown, "session.request", { id: "unknown", workerId: "one" });
	apply(unknown, "session.usage", { id: "unknown", workerId: "one", usage: null });
	assert.equal(workerUsageLimitReason(unknown, "one"), "one: unmeasured response");
	assert.equal(aggregateUsageLimitReason(unknown), null);
	apply(unknown, "session.request", { id: "peer", workerId: "two" });
});
