/**
 * Phase-4 await e2e: single/multi-target joins, any/all modes, timeout with
 * partial results, error + retired terminal outcomes, the
 * exact per-turn terminal-anchor accounting, and open-task hygiene.
 *
 * Run: node phase4-await.mjs
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, test, summary, until } from "./harness.mjs";

const { markDone, readPending, writeEnvelope } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { closeOpenTask, readOpenTasks, recordOpenTask } = await jiti.import(join(EXT, "store/open-tasks.ts"));

const world = await makeWorld("phase4");
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

await test("await coalesces superseded progress so no stale wake follows the final", async () => {
	world.scripts.push({
		match: (c) => c.address === "worker/progress",
		reply: () => ({
			tools: [
				{ name: "report", args: { text: "Starting review; next: inspect files." } },
				{ name: "report", args: { text: "Review complete.", final: true } },
			],
		}),
	});
	const spawn = await core.spawn({ type: "worker", id: "progress", task: "Review this change." });
	assert.ok(await until(() => readPending(layout.mainMailboxDir).some((p) => p.envelope.payload.final === true), 2000));
	const before = readPending(layout.mainMailboxDir);
	const progress = before.find((p) => p.envelope.payload.final !== true);
	assert.equal(progress?.envelope.correlationId, spawn.taskEnvelopeId, "progress carries its task correlation");
	const result = await core.awaitResults({
		targets: [{ to: "worker/progress", anchorId: spawn.taskEnvelopeId }],
		mode: "all",
		timeoutSeconds: 10,
	});
	assert.equal(result.outcomes[0].status, "completed");
	assert.ok(result.outcomes[0].report.text.includes("Review complete"), "await returns only the terminal report");
	assert.equal(readPending(layout.mainMailboxDir).length, 0, "progress and final consumed together");
	assert.equal(core.takeMainMailDigest(), null, "idle wake has no stale progress left to deliver");
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
	// can't crash a turn): correlated progress followed by a task-scoped error.
	writeEnvelope(layout.mainMailboxDir, makeEnvelope({
		from: "worker/b",
		to: "main",
		type: "report",
		text: "Partial work before failure.",
		correlationId: send.envelopeId,
		hops: 1,
	}));
	writeEnvelope(layout.mainMailboxDir, makeEnvelope({
		from: "worker/b",
		to: "main",
		type: "error",
		text: "Turn failed: boom",
		terminalAnchors: [send.envelopeId],
		hops: 1,
	}));
	const result = await core.awaitResults({ targets: [{ to: "worker/b", anchorId: send.envelopeId }], mode: "all", timeoutSeconds: 5 });
	assert.equal(result.outcomes[0].status, "error");
	assert.ok(result.outcomes[0].error.text.includes("boom"));
	assert.ok(!readOpenTasks(layout.openTasksFile)[send.envelopeId], "task closed on error");
	assert.equal(readPending(layout.mainMailboxDir).length, 0, "superseded progress consumed with the fatal outcome");
	await core.whenIdle();
});
await test("an explicit empty error snapshot resolves nothing; a legacy unscoped error retains sender-wide fallback", async () => {
	await core.spawn({ type: "worker", id: "error-scope" });
	const modernTask = makeEnvelope({ from: "main", to: "worker/error-scope", type: "message", text: "Modern task." });
	recordOpenTask(layout.openTasksFile, modernTask.id, { to: "worker/error-scope", snippet: modernTask.payload.text, openedAt: new Date().toISOString() });
	const modernError = makeEnvelope({
		from: "worker/error-scope",
		to: "main",
		type: "error",
		text: "Modern empty snapshot",
		terminalAnchors: [],
		hops: 1,
	});
	writeEnvelope(layout.mainMailboxDir, modernError);
	const modernResult = await core.awaitResults({
		targets: [{ to: "worker/error-scope", anchorId: modernTask.id }],
		mode: "all",
		timeoutSeconds: 0.05,
	});
	assert.equal(modernResult.status, "timeout");
	assert.equal(modernResult.outcomes.length, 0, "explicit empty snapshot does not resolve an unstamped target");
	assert.equal(modernResult.pending[0].anchorId, modernTask.id);
	markDone(layout.mainMailboxDir, modernError.id);
	closeOpenTask(layout.openTasksFile, modernTask.id);

	const legacyTask = makeEnvelope({ from: "main", to: "worker/error-scope", type: "message", text: "Legacy task." });
	recordOpenTask(layout.openTasksFile, legacyTask.id, { to: "worker/error-scope", snippet: legacyTask.payload.text, openedAt: new Date().toISOString() });
	writeEnvelope(layout.mainMailboxDir, makeEnvelope({
		from: "worker/error-scope",
		to: "main",
		type: "error",
		text: "Legacy unscoped failure",
		hops: 1,
	}));
	const legacyResult = await core.awaitResults({
		targets: [{ to: "worker/error-scope", anchorId: legacyTask.id }],
		mode: "all",
		timeoutSeconds: 5,
	});
	assert.equal(legacyResult.outcomes[0].status, "error");
	assert.ok(!readOpenTasks(layout.openTasksFile)[legacyTask.id], "legacy unscoped error closes sender task");
});
await test("a retired target resolves as retired (unmatched anchor)", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/gone", reply: () => ({ tools: [{ name: "report", args: { text: "irrelevant", final: true } }] }) });
	await core.spawn({ type: "worker", id: "gone", task: "Do a thing." });
	await core.whenIdle();
	await core.retire("worker/gone");
	const result = await core.awaitResults({ targets: [{ to: "worker/gone", anchorId: "msg_00000000000000000000000000" }], mode: "all", timeoutSeconds: 5 });
	assert.equal(result.outcomes[0].status, "retired");
});

console.log("one final closes its drained snapshot:");
await test("multiple tasks drained into one turn: the single final report resolves exactly that snapshot", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/c", reply: () => ({ tools: [{ name: "report", args: { text: "batch handled", final: true } }] }) });
	await core.spawn({ type: "worker", id: "c" });
	// Park two tasks without waking, then use a normal third send as the wake. The
	// mail-turn snapshot deterministically contains all three anchors.
	const e1 = makeEnvelope({ from: "main", to: "worker/c", type: "message", text: "Task one." });
	const e2 = makeEnvelope({ from: "main", to: "worker/c", type: "message", text: "Task two." });
	for (const envelope of [e1, e2]) {
		writeEnvelope(layout.mailboxDir("worker", "c"), envelope);
		recordOpenTask(layout.openTasksFile, envelope.id, { to: "worker/c", snippet: envelope.payload.text, openedAt: new Date().toISOString() });
	}
	const s3 = await core.send({ to: "worker/c", text: "Task three." });
	const targets = [e1.id, e2.id, s3.envelopeId].map((anchorId) => ({ to: "worker/c", anchorId }));
	const result = await core.awaitResults({ targets, mode: "all", timeoutSeconds: 10 });
	assert.equal(result.status, "completed");
	assert.equal(result.outcomes.length, 3, "all snapshot anchors resolved by the one final report");
	assert.ok(result.outcomes.every((o) => o.status === "completed"));
	assert.equal(new Set(result.outcomes.map((o) => o.report.id)).size, 1, "one report resolved the whole drained batch");
	assert.deepEqual(readOpenTasks(layout.openTasksFile), {}, "all snapshot anchors closed");
});

console.log("held mail is not completed early:");
await test("a final report resolves only tasks drained into its turn, not mail held for the next turn", async () => {
	await core.spawn({ type: "worker", id: "held" });
	world.scripts.push({ match: (c) => c.address === "worker/held" && c.lastUserText.includes("Task A"), reply: () => ({ delayMs: 150, tools: [{ name: "report", args: { text: "A done", final: true } }] }) });
	world.scripts.push({ match: (c) => c.address === "worker/held" && c.lastUserText.includes("Task B"), reply: () => ({ tools: [{ name: "report", args: { text: "B done", final: true } }] }) });
	const a = await core.send({ to: "worker/held", text: "Task A." });
	assert.ok(await until(async () => (await core.status()).find((r) => r.address === "worker/held")?.state === "running", 2000));
	const b = await core.send({ to: "worker/held", text: "Task B." });
	assert.equal(b.disposition, "held", "B arrived during A and was held for the next turn");
	const result = await core.awaitResults({
		targets: [
			{ to: "worker/held", anchorId: a.envelopeId },
			{ to: "worker/held", anchorId: b.envelopeId },
		],
		mode: "all",
		timeoutSeconds: 10,
	});
	const byAnchor = new Map(result.outcomes.map((outcome) => [outcome.anchorId, outcome]));
	assert.ok(byAnchor.get(a.envelopeId)?.report?.text.includes("A done"));
	assert.ok(byAnchor.get(b.envelopeId)?.report?.text.includes("B done"));
	assert.notEqual(byAnchor.get(a.envelopeId)?.report?.id, byAnchor.get(b.envelopeId)?.report?.id, "each turn produced its own terminal report");
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
