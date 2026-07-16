/**
 * Phase-4 await e2e: single/multi-target joins, any/all modes, timeout with
 * partial results, error + retired terminal outcomes, the
 * one-final-report-closes-all-anchors rule, and open-task hygiene.
 *
 * Run: node phase4-await.mjs
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, test, summary } from "./harness.mjs";

const { readPending, writeEnvelope } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { readOpenTasks } = await jiti.import(join(EXT, "store/open-tasks.ts"));

const world = makeWorld("phase4");
world.writeDef("worker", "You are WORKER.");
const layout = world.makeLayout("sess-4");
const core = world.makeCore(layout, { maxConcurrent: 4 });

console.log("await single:");
await test("await blocks until the final report and consumes exactly it", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/a" && c.lastUserText.includes("Task A"), reply: () => ({ delayMs: 120, tools: [{ name: "report", args: { text: "A done.", final: true } }] }) });
	const spawn = await core.spawn({ type: "worker", id: "a", task: "Task A." });
	const result = await core.awaitResults({ targets: [{ to: "worker/a", anchorId: spawn.taskEnvelopeId }], mode: "all", timeoutSeconds: 10 });
	assert.equal(result.status, "completed");
	assert.equal(result.outcomes.length, 1);
	assert.equal(result.outcomes[0].status, "completed");
	assert.ok(result.outcomes[0].report.text.includes("A done"));
	assert.equal(readPending(layout.mainMailboxDir).length, 0, "report consumed");
	assert.deepEqual(readOpenTasks(layout.openTasksFile), {}, "open task closed");
});

console.log("await any/all:");
await test("mode any returns the fast agent; slow one stays pending, then all completes", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/fast", reply: () => ({ delayMs: 50, tools: [{ name: "report", args: { text: "fast done", final: true } }] }) });
	world.scripts.push({ match: (c) => c.address === "worker/slow", reply: () => ({ delayMs: 600, tools: [{ name: "report", args: { text: "slow done", final: true } }] }) });
	const fast = await core.spawn({ type: "worker", id: "fast", task: "Race." });
	const slow = await core.spawn({ type: "worker", id: "slow", task: "Race." });
	const targets = [
		{ to: "worker/fast", anchorId: fast.taskEnvelopeId },
		{ to: "worker/slow", anchorId: slow.taskEnvelopeId },
	];
	const any = await core.awaitResults({ targets, mode: "any", timeoutSeconds: 10 });
	assert.equal(any.status, "completed");
	assert.equal(any.outcomes.length, 1);
	assert.equal(any.outcomes[0].to, "worker/fast");
	assert.equal(any.pending.length, 1);
	assert.equal(any.pending[0].to, "worker/slow");
	const rest = await core.awaitResults({ targets: any.pending, mode: "all", timeoutSeconds: 10 });
	assert.equal(rest.status, "completed");
	assert.ok(rest.outcomes[0].report.text.includes("slow done"));
});

console.log("await timeout:");
await test("timeout returns partials + pending, consumes nothing for pending", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/glacial", reply: () => ({ delayMs: 1500, tools: [{ name: "report", args: { text: "eventually", final: true } }] }) });
	const spawn = await core.spawn({ type: "worker", id: "glacial", task: "Take forever." });
	const result = await core.awaitResults({ targets: [{ to: "worker/glacial", anchorId: spawn.taskEnvelopeId }], mode: "all", timeoutSeconds: 1 });
	assert.equal(result.status, "timeout");
	assert.equal(result.outcomes.length, 0);
	assert.equal(result.pending.length, 1);
	assert.ok(readOpenTasks(layout.openTasksFile)[spawn.taskEnvelopeId], "open task NOT closed on timeout");
	await core.whenIdle(); // let it finish
	const late = await core.awaitResults({ targets: [{ to: "worker/glacial", anchorId: spawn.taskEnvelopeId }], mode: "all", timeoutSeconds: 5 });
	assert.equal(late.status, "completed", "a timed-out task is still joinable once it finishes");
	assert.ok(late.outcomes[0].report.text.includes("eventually"));
});

console.log("terminal outcomes:");
await test("a fatal error envelope resolves the target as error and closes its tasks", async () => {
	await core.spawn({ type: "worker", id: "b" }); // dormant, no task yet
	const send = await core.send({ to: "worker/b", text: "Doomed task." });
	// Manufacture the runtime's fatal-error envelope shape directly (the mock LLM
	// can't crash a turn): error from the agent's address into the main mailbox.
	writeEnvelope(layout.mainMailboxDir, makeEnvelope({ from: "worker/b", to: "main", type: "error", text: "Turn failed: boom" }));
	const result = await core.awaitResults({ targets: [{ to: "worker/b", anchorId: send.envelopeId }], mode: "all", timeoutSeconds: 5 });
	assert.equal(result.outcomes[0].status, "error");
	assert.ok(result.outcomes[0].error.text.includes("boom"));
	assert.ok(!readOpenTasks(layout.openTasksFile)[send.envelopeId], "task closed on error");
	await core.whenIdle();
});
await test("a retired target resolves as retired (unmatched anchor)", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/gone", reply: () => ({ tools: [{ name: "report", args: { text: "irrelevant", final: true } }] }) });
	await core.spawn({ type: "worker", id: "gone", task: "Do a thing." });
	await core.whenIdle();
	await core.retire("worker/gone");
	const result = await core.awaitResults({ targets: [{ to: "worker/gone", anchorId: "msg_00000000000000000000000000" }], mode: "all", timeoutSeconds: 5 });
	assert.equal(result.outcomes[0].status, "retired");
});

console.log("one final closes all anchors:");
await test("two tasks drained into one turn: the single final report resolves both targets", async () => {
	await core.cancel("worker/c"); // no-op guard; ensure clean
	// Park two messages while the agent has no handle yet: spawn without task,
	// then send twice before the first wake can drain (sends are sync writes; the
	// wake turn drains both).
	world.scripts.push({ match: (c) => c.address === "worker/c", reply: () => ({ tools: [{ name: "report", args: { text: "both handled", final: true } }] }) });
	await core.spawn({ type: "worker", id: "c" });
	const s1 = await core.send({ to: "worker/c", text: "Task one." });
	const s2 = await core.send({ to: "worker/c", text: "Task two." });
	const result = await core.awaitResults({
		targets: [
			{ to: "worker/c", anchorId: s1.envelopeId },
			{ to: "worker/c", anchorId: s2.envelopeId },
		],
		mode: "all",
		timeoutSeconds: 10,
	});
	assert.equal(result.status, "completed");
	assert.equal(result.outcomes.length, 2, "both targets resolved by the one final report");
	assert.ok(result.outcomes.every((o) => o.status === "completed"));
	assert.deepEqual(readOpenTasks(layout.openTasksFile), {}, "all anchors closed");
});

console.log("empty + openTasks default:");
await test("no targets → empty; openTasks() reflects live anchors and prunes stale ones", async () => {
	const empty = await core.awaitResults({ targets: [], mode: "all" });
	assert.equal(empty.status, "empty");
	const send = await core.send({ to: "worker/a", text: "Another." });
	world.scripts.push({ match: (c) => c.address === "worker/a", reply: () => ({ tools: [{ name: "report", args: { text: "again done", final: true } }] }) });
	const open = core.runtime.openTasks();
	assert.ok(open.some((t) => t.anchorId === send.envelopeId));
	await core.whenIdle();
	const result = await core.awaitResults({ targets: [{ to: "worker/a", anchorId: send.envelopeId }], mode: "all", timeoutSeconds: 5 });
	assert.equal(result.status, "completed");
});

await core.dispose();
summary("Phase 4");
