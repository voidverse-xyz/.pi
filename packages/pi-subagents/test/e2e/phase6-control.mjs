/**
 * Phase-6 control e2e: steer mid-turn, cancel (streaming + queued, mail stays
 * pending, resume after), cancelAllWorking (the stop brake), retire semantics
 * (archive + address bounce), and sendAsUser transparency.
 *
 * Run: node phase6-control.mjs
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, test, summary, until } from "./harness.mjs";

const { readPending } = await jiti.import(join(EXT, "mail/mailbox.ts"));

const world = await makeWorld("phase6");
world.writeDef("worker", "You are WORKER.");
const layout = world.makeLayout("sess-6");
const core = world.makeCore(layout, { maxConcurrent: 1 }); // cap 1 makes queueing deterministic

console.log("steer:");
await test("steer lands only while streaming", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/st" && c.lastUserText.includes("Long think"), reply: () => ({ delayMs: 400, text: "thought" }) });
	await core.spawn({ type: "worker", id: "st", task: "Long think." });
	const streaming = await until(async () => (await core.status()).find((r) => r.address === "worker/st")?.state === "running", 2000);
	assert.ok(streaming, "agent reached running");
	// The mock stream is mid-delay right now — the session is streaming.
	const steered = await core.steer("worker/st", "Change course.");
	assert.equal(steered.steered, true);
	await core.whenIdle();
	const idle = await core.steer("worker/st", "Too late.");
	assert.equal(idle.steered, false, "steer is mid-turn-only");
});

console.log("cancel:");
await test("cancel a streaming turn: mail stays pending, agent dormant, resumable", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/ca" && c.lastUserText.includes("Doomed"), reply: () => ({ delayMs: 800, text: "should not finish" }) });
	await core.spawn({ type: "worker", id: "ca", task: "Doomed work." });
	await until(async () => (await core.status()).find((r) => r.address === "worker/ca")?.state === "running", 2000);
	const cancelled = await core.cancel("worker/ca");
	assert.equal(cancelled.cancelled, true);
	await core.whenIdle();
	const box = layout.mailboxDir("worker", "ca");
	const pending = readPending(box);
	assert.equal(pending.length, 1, "triggering mail stays pending");
	assert.equal(pending[0].redelivered, true, "labeled as an incomplete delivery attempt");
	assert.equal((await core.status()).find((r) => r.address === "worker/ca").state, "dormant");
	// Resume: a new send wakes it and the pending mail redelivers alongside.
	world.scripts.push({ match: (c) => c.address === "worker/ca" && c.lastUserText.includes("Try again"), reply: (c) => ({ text: c.lastUserText.includes("Doomed") ? "resumed with both" : "resumed" }) });
	await core.send({ to: "worker/ca", text: "Try again." });
	await core.whenIdle();
	assert.equal(readPending(box).length, 0, "resumed turn consumed the parked mail");
});
await test("cancel a QUEUED agent stands its turn down before it streams", async () => {
	// cap 1: block the slot with a slow agent, then queue another and cancel it.
	world.scripts.push({ match: (c) => c.address === "worker/slot", reply: () => ({ delayMs: 500, text: "hog" }) });
	await core.spawn({ type: "worker", id: "slot", task: "Hog the slot." });
	await core.spawn({ type: "worker", id: "qd", task: "Queued task." });
	await until(async () => (await core.status()).find((r) => r.address === "worker/qd")?.state === "queued", 2000);
	const cancelled = await core.cancel("worker/qd");
	assert.equal(cancelled.cancelled, true, "queued cancel records intent");
	await core.whenIdle();
	assert.equal(readPending(layout.mailboxDir("worker", "qd")).length, 1, "queued agent's mail stays pending");
	assert.equal((await core.status()).find((r) => r.address === "worker/qd").state, "dormant");
	const missing = await core.cancel("worker/nope");
	assert.equal(missing.cancelled, false);
});

console.log("stop brake:");
await test("cancelAllWorking stops the whole working set, dormant agents untouched", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/b1", reply: () => ({ delayMs: 800, text: "x" }) });
	world.scripts.push({ match: (c) => c.address === "worker/b2", reply: () => ({ delayMs: 800, text: "x" }) });
	await core.spawn({ type: "worker", id: "b1", task: "Brake me." });
	await core.spawn({ type: "worker", id: "b2", task: "Brake me too." });
	await until(async () => {
		const roster = await core.status();
		return ["b1", "b2"].every((id) => ["running", "queued"].includes(roster.find((r) => r.address === `worker/${id}`)?.state));
	}, 2000);
	const { stopped, failed } = await core.cancelAllWorking();
	assert.equal(failed.length, 0);
	assert.ok(stopped.includes("worker/b1") && stopped.includes("worker/b2"));
	await core.whenIdle();
	const roster = await core.status();
	assert.ok(["b1", "b2"].every((id) => roster.find((r) => r.address === `worker/${id}`).state === "dormant"));
});

console.log("retire:");
await test("retire archives the dir and the address bounces afterward", async () => {
	const result = await core.retire("worker/ca");
	assert.equal(result.retired, true);
	assert.ok(result.archiveDir?.includes(".archive"));
	const send = await core.send({ to: "worker/ca", text: "anyone home?" });
	assert.equal(send.disposition, "bounced");
	assert.ok(send.bounceReason.includes("no such agent"));
	const again = await core.retire("worker/ca");
	assert.equal(again.retired, true, "idempotent");
	assert.equal(again.archiveDir, null);
});

console.log("sendAsUser:");
await test("user send delivers and drops an FYI report to main", async () => {
	world.scripts.push({ match: (c) => c.address === "worker/st" && c.lastUserText.includes("From the human"), reply: () => ({ text: "ack" }) });
	const result = await core.sendAsUser({ to: "worker/st", text: "From the human." });
	assert.equal(result.delivery, "delivered");
	const fyi = readPending(layout.mainMailboxDir).find((p) => p.envelope.type === "report" && p.envelope.from === "worker/st");
	assert.ok(fyi, "FYI report to main");
	assert.ok(fyi.envelope.payload.text.includes("direct message"));
	await core.whenIdle();
});

await core.dispose();
summary("Phase 6");
