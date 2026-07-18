/**
 * Phase-5 auto-wake e2e: the wake pump policy (idle gating, flip-before-inject,
 * commit-after-accept, shutdown), the REAL WAKE_DELIVERY shape exported by
 * index.ts, per-finish wakes through a real core, and digest-commit closing
 * open tasks on final reports / fatal errors.
 *
 * Run: node phase5-wake.mjs
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, test, summary, until } from "./harness.mjs";

const { createWakePump } = await jiti.import(join(EXT, "mail/wake-pump.ts"));
const { WAKE_DELIVERY } = await jiti.import(join(EXT, "index.ts"));
const { readPending, writeEnvelope } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { readOpenTasks, recordOpenTask } = await jiti.import(join(EXT, "store/open-tasks.ts"));

console.log("wake pump (pure policy):");
await test("mail arriving mid-turn waits for settle; drained exactly once", () => {
	const injected = [];
	let commits = 0;
	let queue = null;
	const pump = createWakePump({
		takeDigest: () => (queue ? { digest: queue, commit: () => { commits++; queue = null; } } : null),
		inject: (digest) => injected.push(digest),
	});
	pump.onBeforeAgentStart(); // host busy
	queue = "digest-1";
	pump.onMailArrived();
	assert.equal(injected.length, 0, "mid-turn mail not injected");
	pump.onSettled();
	assert.deepEqual(injected, ["digest-1"]);
	assert.equal(commits, 1, "committed after inject");
	pump.onMailArrived();
	assert.equal(injected.length, 1, "the injected turn is not idle — no re-drain");
});
await test("shutdown stops all draining; user input flips busy", () => {
	const injected = [];
	let queue = "digest-2";
	const pump = createWakePump({ takeDigest: () => (queue ? { digest: queue, commit: () => { queue = null; } } : null), inject: (d) => injected.push(d) });
	pump.onSettled();
	assert.deepEqual(injected, ["digest-2"]);
	queue = "digest-3";
	pump.onInput();
	pump.onMailArrived();
	assert.equal(injected.length, 1, "typing user = busy host");
	pump.shutdown();
	pump.onSettled();
	assert.equal(injected.length, 1, "nothing after shutdown — mail survives for next session");
	assert.equal(queue, "digest-3", "uncommitted");
});

console.log("wake delivery shape:");
await test("index.ts injects with followUp + triggerTurn (the idle auto-wake)", () => {
	assert.deepEqual(WAKE_DELIVERY, { deliverAs: "followUp", triggerTurn: true });
});

console.log("per-finish wake through a real core:");
const world = await makeWorld("phase5");
world.writeDef("worker", "You are WORKER.");
const layout = world.makeLayout("sess-5");
const core = world.makeCore(layout, { maxConcurrent: 4 });

await test("each finishing agent fires the wake signal; digest carries its report", async () => {
	const wakes = [];
	core.onEvent((event) => {
		if (event.type === "turn-finished" || event.type === "agent-retired") wakes.push(event.type);
	});
	world.scripts.push({ match: (c) => c.address === "worker/w1", reply: () => ({ delayMs: 40, tools: [{ name: "report", args: { text: "w1 done", final: true } }] }) });
	world.scripts.push({ match: (c) => c.address === "worker/w2", reply: () => ({ delayMs: 200, tools: [{ name: "report", args: { text: "w2 done", final: true } }] }) });
	await core.spawn({ type: "worker", id: "w1", task: "T1." });
	await core.spawn({ type: "worker", id: "w2", task: "T2." });
	await until(() => wakes.length >= 1, 2000);
	// First finish fires while the second still runs — per-finish, not coalesced.
	const drained1 = core.takeMainMailDigest();
	assert.ok(drained1, "digest available on first finish");
	assert.ok(drained1.digest.includes("w1 done"));
	assert.ok(!drained1.digest.includes("w2 done"), "second agent's report not in the first digest");
	drained1.commit();
	await core.whenIdle();
	const drained2 = core.takeMainMailDigest();
	assert.ok(drained2.digest.includes("w2 done"));
	drained2.commit();
	assert.equal(core.takeMainMailDigest(), null, "nothing pending after both commits");
});

await test("digest commit closes open tasks for final reports and fatal errors", async () => {
	// Manufacture a pending final report + error and matching open tasks.
	const report = makeEnvelope({ from: "worker/w1", to: "main", type: "report", text: "late final", final: true, correlationId: "msg_00000000000000000000000001", terminalAnchors: ["msg_00000000000000000000000001"] });
	const error = makeEnvelope({ from: "worker/w2", to: "main", type: "error", text: "Turn failed: x", terminalAnchors: ["msg_00000000000000000000000002"] });
	writeEnvelope(layout.mainMailboxDir, report);
	writeEnvelope(layout.mainMailboxDir, error);
	recordOpenTask(layout.openTasksFile, "msg_00000000000000000000000001", { to: "worker/w1", snippet: "s", openedAt: new Date().toISOString() });
	recordOpenTask(layout.openTasksFile, "msg_00000000000000000000000002", { to: "worker/w2", snippet: "s", openedAt: new Date().toISOString() });
	const drained = core.takeMainMailDigest();
	assert.ok(drained.digest.includes("(FINAL)"), "finality labeled in the digest");
	drained.commit();
	assert.deepEqual(readOpenTasks(layout.openTasksFile), {}, "both agents' tasks closed on commit");
	assert.equal(readPending(layout.mainMailboxDir).length, 0);
});

await core.dispose();
summary("Phase 5");
