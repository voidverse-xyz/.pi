/**
 * Regression tests for the runtime concurrency/lifecycle review fixes.
 *
 * (1) C1 — a corrupt/invalid envelope file must NOT hang the host: readPending
 *     quarantines it to mailbox/.corrupt/ so pendingCount agrees, and the
 *     end-of-turn drain never loops (previously a pure-microtask reschedule
 *     loop starved the event loop at 100% CPU).
 * (2) C2 — startup reconciliation: a registry record stranded running/queued/
 *     waiting by a crash or mid-turn quit is reset to dormant on runtime
 *     construction, and mailboxes with pending envelopes get a digest turn
 *     (previously all future mail routed "held" forever).
 * (3) M5 — retire (the oneshot funeral path runs through the same retire())
 *     bounces every unprocessed pending envelope back to its sender as an
 *     error before the mailbox is archived (senders were told delivery
 *     succeeded — burying their mail would strand them dormant forever).
 * (4) m2 — the autonomy-resume drain only schedules turns for DORMANT agents;
 *     it must never stamp `queued` over a waiting/running agent.
 *
 * Harness: jiti-alias pattern + text-only mock provider (see env.mjs and
 * phase3-mail.mjs). Run: node test/e2e/phase-runtime-fixes.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readRegistry, updateRegistry, getAgent } = await jiti.import(join(EXT, "store/registry.ts"));
const { InProcessRuntime } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const { AutonomyBudget } = await jiti.import(join(EXT, "rails/autonomy.ts"));
const { makeEnvelope, ulid } = await jiti.import(join(EXT, "mail/envelope.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));

// ---------------------------------------------------------------------------
// World + mock provider
// ---------------------------------------------------------------------------
const scratch = join(WORLDS, "runtime-fixes-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
writeFileSync(
	join(project, ".pi", "subagents", "worker.md"),
	["---", "name: worker", "description: fixes-test worker", "model: mock/mock-1", "projectContext: false", "---", "You are a worker.", ""].join("\n"),
);

function mockStream(model) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
		const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), content: [{ type: "text", text: "ok" }], stopReason: "stop" };
		stream.push({ type: "start", partial: output });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: output });
		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	})();
	return stream;
}
const authStorage = piSdk.AuthStorage.create(join(home, ".pi", "agent", "auth.json"));
const modelRegistry = piSdk.ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider("mock", {
	baseUrl: "http://mock.invalid", apiKey: "k", api: "mock-api", streamSimple: mockStream,
	models: [{ id: "mock-1", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
});
const layout = createLayout(project, { home });
const settingsManager = piSdk.SettingsManager.create(project, join(home, ".pi", "agent"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name) {
	passed++;
	console.log(`  ok  ${name}`);
}

// Watchdog: if a regression re-introduces the C1 microtask loop, timers starve
// and this file would hang silently — die loudly instead. (unref'd: never
// holds a healthy run open.)
const watchdog = setTimeout(() => {
	console.error("WATCHDOG: test file exceeded 120s — event loop starved or test wedged");
	process.exit(2);
}, 120_000);
watchdog.unref?.();

// ---------------------------------------------------------------------------
// (1) C1 — corrupt envelope: quarantined, no reschedule loop, no hang
// ---------------------------------------------------------------------------
console.log("(1) corrupt-envelope quarantine (C1):");
{
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	const events = [];
	runtime.onEvent((e) => events.push(e));

	await runtime.spawn({ type: "worker", id: "loopy", task: "hello" });
	for (let i = 0; i < 400 && !events.some((e) => e.type === "turn-finished"); i++) await sleep(15);
	assert.ok(events.some((e) => e.type === "turn-finished"), "task turn ran");

	const box = layout.mailboxDir("worker", "loopy");
	// One unparsable file and one parsable-but-invalid envelope.
	const corruptName = `msg_${ulid()}.json`;
	writeFileSync(join(box, corruptName), "{ this is not json", "utf8");
	const invalidName = `msg_${ulid()}.json`;
	writeFileSync(join(box, invalidName), JSON.stringify({ id: "nope" }), "utf8");

	// readPending quarantines both; pendingCount then agrees (count = readable).
	assert.equal(mailbox.readPending(box).length, 0);
	assert.equal(mailbox.pendingCount(box), 0);
	const corruptDir = join(box, ".corrupt");
	assert.ok(existsSync(join(corruptDir, corruptName)), "unparsable file preserved in .corrupt/");
	assert.ok(existsSync(join(corruptDir, invalidName)), "invalid envelope preserved in .corrupt/");
	ok("readPending quarantines corrupt + invalid envelopes to mailbox/.corrupt/ (kept for debugging)");

	// A fresh corrupt file arriving before a wake: the turn must settle, not loop.
	writeFileSync(join(box, `msg_${ulid()}.json`), "also not json", "utf8");
	const before = events.length;
	await runtime.send({ to: "worker/loopy", text: "one more" });
	await sleep(1500);
	const queuedFlips = events.slice(before).filter((e) => e.type === "state-changed" && e.state === "queued").length;
	assert.ok(queuedFlips <= 3, `no reschedule loop (got ${queuedFlips} queued flips, loop was >100)`);
	assert.equal(mailbox.pendingCount(box), 0, "mailbox fully drained");
	assert.equal(getAgent(readRegistry(layout.registryFile), "worker/loopy")?.state, "dormant");
	ok("corrupt envelope no longer causes the end-of-turn drain to loop (event loop stays healthy)");
	await runtime.dispose();
}

// ---------------------------------------------------------------------------
// (2) C2 — startup reconciliation rescues stranded state + mail
// ---------------------------------------------------------------------------
console.log("(2) startup reconciliation (C2):");
{
	// Simulate a crash mid-turn: record left `running`, one envelope pending.
	updateRegistry(layout.registryFile, (reg) => {
		getAgent(reg, "worker/loopy").state = "running";
	});
	const box = layout.mailboxDir("worker", "loopy");
	mailbox.writeEnvelope(box, makeEnvelope({ from: "main", to: "worker/loopy", type: "message", text: "left behind by the crash" }));

	// "Restart": a new runtime must reconcile WITHOUT any send/spawn nudging it.
	const runtime2 = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	const events2 = [];
	runtime2.onEvent((e) => events2.push(e));
	for (let i = 0; i < 400 && !events2.some((e) => e.type === "turn-finished"); i++) await sleep(15);
	assert.ok(events2.some((e) => e.type === "turn-started"), "reconciliation scheduled a digest turn");
	assert.equal(mailbox.pendingCount(box), 0, "stranded envelope was consumed");
	assert.equal(getAgent(readRegistry(layout.registryFile), "worker/loopy")?.state, "dormant");
	ok("stale `running` record reset to dormant on construction; stranded mail drained");

	// Fresh sends route normally again (previously: held forever).
	const res = await runtime2.send({ to: "worker/loopy", text: "are you alive?" });
	assert.equal(res.delivery, "delivered");
	for (let i = 0; i < 400 && mailbox.pendingCount(box) > 0; i++) await sleep(15);
	assert.equal(mailbox.pendingCount(box), 0);
	ok("post-restart send wakes the agent (delivery no longer strands as held)");
	await runtime2.dispose();
	assert.equal(getAgent(readRegistry(layout.registryFile), "worker/loopy")?.state, "dormant");
	ok("dispose leaves the record dormant (clean-quit half: in-flight chains awaited)");
}

// ---------------------------------------------------------------------------
// (3) M5 — retire/funeral bounces unprocessed pending mail to senders
// ---------------------------------------------------------------------------
console.log("(3) funeral bounce (M5):");
{
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	await runtime.spawn({ type: "worker", id: "asker", team: "t" });
	await runtime.spawn({ type: "worker", id: "doomed", team: "t" });

	// A peer question sits UNPROCESSED in doomed's mailbox (written directly —
	// delivery-level write, no wake — modeling mail that arrived mid-turn just
	// before the oneshot funeral / an explicit retire).
	const question = makeEnvelope({
		from: "worker/asker", to: "worker/doomed", type: "question", team: "t",
		text: "did the migration finish?",
	});
	mailbox.writeEnvelope(layout.mailboxDir("worker", "doomed"), question);

	const result = await runtime.retire("worker/doomed");
	assert.ok(result.retired);

	// The asker must get an error bounce correlated to its buried question.
	const askerBox = layout.mailboxDir("worker", "asker");
	const bounced = [
		...mailbox.readPending(askerBox).map((p) => p.envelope),
		...readDoneEnvelopes(askerBox),
	].find((e) => e.type === "error" && e.correlationId === question.id);
	assert.ok(bounced, "asker received an error envelope correlated to the unprocessed question");
	assert.match(bounced.payload.text, /retired/);
	assert.match(bounced.payload.text, /did the migration finish\?/);
	ok("retire bounces unprocessed pending mail back to the sender (asker never strands)");

	// The archived mailbox keeps the original (funeral loses nothing on disk).
	await sleep(400); // let the asker's bounce-wake turn settle before dispose
	await runtime.dispose();
}

function readDoneEnvelopes(box) {
	const done = join(box, ".done");
	if (!existsSync(done)) return [];
	return readdirSync(done)
		.filter((n) => n.endsWith(".json"))
		.map((n) => JSON.parse(readFileSync(join(done, n), "utf8")));
}

// ---------------------------------------------------------------------------
// (4) m2 — autonomy-resume drain never clobbers waiting/running state
// ---------------------------------------------------------------------------
console.log("(4) resume drain respects lifecycle state (m2):");
{
	const autonomy = new AutonomyBudget({ autonomousTurns: 10_000, autonomousTokens: 10_000_000 });
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2, autonomy });
	const events = [];
	runtime.onEvent((e) => events.push(e));
	await runtime.spawn({ type: "worker", id: "waiter" });
	await runtime.spawn({ type: "worker", id: "sleeper" });
	await sleep(100);

	// waiter: blocked on a (simulated) human escalation, mail queued behind it.
	// sleeper: plain dormant agent with queued mail — the drain's real target.
	updateRegistry(layout.registryFile, (reg) => {
		getAgent(reg, "worker/waiter").state = "waiting";
	});
	mailbox.writeEnvelope(layout.mailboxDir("worker", "waiter"), makeEnvelope({ from: "main", to: "worker/waiter", type: "message", text: "queued behind the escalation" }));
	mailbox.writeEnvelope(layout.mailboxDir("worker", "sleeper"), makeEnvelope({ from: "main", to: "worker/sleeper", type: "message", text: "queued while paused" }));

	// Trip the pause, then resume → the runtime's drain fires.
	autonomy.noteTokens(20_000_000);
	assert.ok(autonomy.paused);
	const before = events.length;
	autonomy.resume();
	for (let i = 0; i < 400 && mailbox.pendingCount(layout.mailboxDir("worker", "sleeper")) > 0; i++) await sleep(15);

	assert.equal(mailbox.pendingCount(layout.mailboxDir("worker", "sleeper")), 0, "dormant agent drained");
	assert.equal(getAgent(readRegistry(layout.registryFile), "worker/waiter")?.state, "waiting", "waiting state NOT clobbered to queued");
	assert.equal(mailbox.pendingCount(layout.mailboxDir("worker", "waiter")), 1, "waiter's mail stays queued for its own turn boundary");
	const waiterFlips = events.slice(before).filter((e) => e.type === "state-changed" && e.address === "worker/waiter");
	assert.equal(waiterFlips.length, 0, "no state events for the waiting agent");
	ok("autonomy resume drains dormant agents only; `waiting` survives the drain");

	// Cleanup so a stale `waiting` record never leaks into other test worlds.
	updateRegistry(layout.registryFile, (reg) => {
		getAgent(reg, "worker/waiter").state = "dormant";
	});
	await runtime.dispose();
}

console.log(`\nall ${passed} runtime-fixes regression tests passed`);
process.exit(0);
