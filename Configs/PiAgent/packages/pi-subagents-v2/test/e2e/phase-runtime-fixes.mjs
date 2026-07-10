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

// ---------------------------------------------------------------------------
// (5) Main-mail durability (core level): crash-before-host-append re-delivers;
//     verified append finalizes exactly once. (Closes the old documented
//     DEVIATION: drainMainMail used to markDone at digest-compose time, so a
//     crash between compose and the host's JSONL append LOST the mail — worst
//     case a dropped escalation stranding its subagent in `waiting` forever.)
// ---------------------------------------------------------------------------
console.log("(5) main-mail durability (core):");
{
	const { createCore, reconcileMainMailFor } = await jiti.import(join(EXT, "core.ts"));
	const projectM = join(scratch, "project-mainmail");
	mkdirSync(projectM, { recursive: true });
	const layoutM = createLayout(projectM, { home });
	// The "main session JSONL" the host owns; the extension only reads it.
	const sessionFile = join(home, ".pi", "agent", "sessions", "fake-main-session.jsonl");
	mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	// What the host would durably append for an injected digest message.
	const hostAppend = (customType, content) => {
		writeFileSync(sessionFile, `${JSON.stringify({ type: "custom-message", customType, content })}\n`, { flag: "a" });
	};

	// --- crash path: composed, parked, never appended → re-delivered ---------
	const esc = makeEnvelope({
		from: "worker/alpha", to: "main", type: "escalation",
		text: "Blocked: need human approval for `rm -rf build/` ESC_MARKER",
	});
	mailbox.writeEnvelope(layoutM.mainMailboxDir, esc);
	const core1 = createCore({ cwd: projectM, home, settings: {} });
	const digest1 = core1.drainMainMail(sessionFile);
	assert.ok(digest1.includes("ESC_MARKER") && digest1.includes(esc.id), "digest composed with the envelope id embedded");
	assert.equal(mailbox.pendingCount(layoutM.mainMailboxDir), 0, "drained mail no longer pending");
	assert.ok(!existsSync(join(layoutM.mainMailboxDoneDir, `${esc.id}.json`)), "NOT finalized at compose time");
	assert.ok(existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json`)), "parked in .delivering/ awaiting the host append");
	assert.ok(existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json.meta`)), "target session file on record");
	ok("drain parks envelopes in .delivering/ instead of finalizing (host append unverified)");

	// In the SAME process an unverified envelope is in flight, never re-queued —
	// a drain loop can't double-deliver it (and can't double-charge the D21 pool).
	assert.equal(core1.drainMainMail(sessionFile), null, "no re-delivery while the injection may be in flight");
	assert.ok(existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json`)), "still parked");
	ok("in-process re-drain leaves in-flight envelopes alone (no double delivery)");

	// CRASH: host dies before appending the injected digest. Restart:
	await core1.dispose();
	const rec = reconcileMainMailFor(projectM, home);
	assert.deepEqual(rec, { finalized: [], requeued: [esc.id], inFlight: [] }, "session_start reconcile detects the loss");
	assert.equal(mailbox.pendingCount(layoutM.mainMailboxDir), 1, "escalation back in the pending mailbox");
	const core2 = createCore({ cwd: projectM, home, settings: {} });
	const digest2 = core2.drainMainMail(sessionFile);
	assert.ok(digest2.includes("ESC_MARKER"), "escalation re-delivered after the crash (was: silently lost)");
	assert.match(digest2, /re-delivered: an earlier delivery attempt did not complete/, "re-delivery labeled in the digest");
	ok("crash before the host append RE-DELIVERS the escalation on restart (at-least-once)");

	// --- no-crash path: host appends → next opportunity finalizes exactly once
	hostAppend("subagent-mail", digest2);
	assert.equal(core2.drainMainMail(sessionFile), null, "nothing pending after the verified delivery");
	assert.ok(existsSync(join(layoutM.mainMailboxDoneDir, `${esc.id}.json`)), "finalized to .done/ once verified in the JSONL");
	assert.ok(!existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json`)), ".delivering/ cleared");
	assert.equal(mailbox.pendingCount(layoutM.mainMailboxDir), 0);
	// Idempotent: neither reconcile flavor resurrects mail the agent has seen.
	assert.deepEqual(reconcileMainMailFor(projectM, home), { finalized: [], requeued: [], inFlight: [] });
	assert.equal(core2.drainMainMail(sessionFile), null, "finalized exactly once — never re-delivered");
	ok("verified host append finalizes exactly once; reconciliation never resurrects seen mail");

	// --- no verifiable target (stub host / non-persisted session) ------------
	const plain = makeEnvelope({ from: "worker/alpha", to: "main", type: "report", text: "PLAIN_MARKER" });
	mailbox.writeEnvelope(layoutM.mainMailboxDir, plain);
	const digest3 = core2.drainMainMail(null);
	assert.ok(digest3.includes("PLAIN_MARKER"));
	assert.ok(existsSync(join(layoutM.mainMailboxDoneDir, `${plain.id}.json`)), "no session file → finalize at compose time (old behavior)");
	ok("null session file falls back to compose-time finalize (nothing durable to verify against)");
	await core2.dispose();
}

// ---------------------------------------------------------------------------
// (6) Main-mail durability (index.ts wiring): the session file reaches drains
//     via ctx.sessionManager.getSessionFile(); session_start reconciles and
//     re-auto-wakes crash-lost wake-worthy mail; no wake loop afterwards.
// ---------------------------------------------------------------------------
console.log("(6) main-mail durability (host wiring):");
{
	const extensionFactory = (await jiti.import(join(EXT, "index.ts"))).default ?? (await jiti.import(join(EXT, "index.ts")));
	const projectW = join(scratch, "project-mainmail-wiring");
	mkdirSync(projectW, { recursive: true });
	const layoutW = createLayout(projectW, { home });
	const sessionFile = join(home, ".pi", "agent", "sessions", "fake-wiring-session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	const prevHome = process.env.HOME;
	process.env.HOME = home; // index.ts derives the layout home from os.homedir()

	const handlers = {};
	const sentMessages = [];
	const stubPi = {
		isStreaming: false,
		on: (event, handler) => (handlers[event] ??= []).push(handler),
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		sendMessage: (message, options) => {
			const mode =
				options?.deliverAs === "nextTurn" ? "nextTurn"
				: stubPi.isStreaming ? (options?.deliverAs === "followUp" ? "followUp" : "steer")
				: options?.triggerTurn ? "newTurn"
				: "append";
			sentMessages.push({ message, options, mode });
		},
	};
	extensionFactory(stubPi);
	// hasUI so session_start builds the core (widget install path) — the
	// crash-requeued wake-worthy mail must get its D16 auto-wake back.
	const ctx = {
		cwd: projectW,
		modelRegistry,
		hasUI: true,
		ui: { setWidget: () => {}, notify: () => {} },
		sessionManager: { getSessionFile: () => sessionFile },
	};
	const fire = async (event) => {
		for (const h of handlers[event] ?? []) await h({ type: event }, ctx);
	};
	const hostAppend = (message) => {
		writeFileSync(sessionFile, `${JSON.stringify({ type: "custom-message", customType: message.customType, content: message.content })}\n`, { flag: "a" });
	};

	await fire("session_start"); // clean start — nothing to reconcile
	assert.equal(sentMessages.length, 0);

	// A subagent escalation lands; a real user turn drains it into the digest.
	const esc = makeEnvelope({ from: "worker/alpha", to: "main", type: "escalation", text: "approve the deploy? WIRE_ESC_MARKER" });
	mailbox.writeEnvelope(layoutW.mainMailboxDir, esc);
	const injected = await handlers.before_agent_start[0]({ type: "before_agent_start" }, ctx);
	assert.match(injected.message.content, /WIRE_ESC_MARKER/, "user-turn digest drained the escalation");
	assert.ok(existsSync(join(layoutW.mainMailboxDeliveringDir, `${esc.id}.json`)), "parked against the ACTIVE session file (ctx.sessionManager)");
	// CRASH before the host appended `injected.message` — nothing written.
	await fire("session_shutdown");

	// Restart: session_start reconciles, requeues, and re-auto-wakes (D16).
	await fire("session_start");
	assert.equal(sentMessages.length, 1, "crash-lost escalation re-auto-woken at session_start");
	const wake = sentMessages[0];
	assert.equal(wake.mode, "newTurn");
	assert.equal(wake.options.triggerTurn, true);
	assert.match(wake.message.customType, /subagent-mail/);
	assert.match(wake.message.content, /WIRE_ESC_MARKER/, "fresh digest carries the escalation");
	assert.match(wake.message.content, /re-delivered: an earlier delivery attempt did not complete/, "labeled as a re-delivery");
	ok("crash-lost escalation is re-delivered AND re-auto-woken on restart (was: lost, subagent stranded)");

	// No wake loop while the new injection is unverified: boundary re-checks
	// find nothing pending (envelope is in .delivering) → no extra pool charge.
	await fire("agent_settled");
	await fire("agent_settled");
	assert.equal(sentMessages.length, 1, "no self-wake loop / no repeated pool charge while in flight");
	ok("unverified re-delivery never re-wakes in-process (D21 pool charged once per actual wake)");

	// The host now durably appends the wake message; the next user turn
	// finalizes — exactly once, no duplicate digest.
	hostAppend(wake.message);
	const second = await handlers.before_agent_start[0]({ type: "before_agent_start" }, ctx);
	assert.equal(second, undefined, "no duplicate delivery once the append is verified");
	assert.ok(existsSync(join(layoutW.mainMailboxDoneDir, `${esc.id}.json`)), "finalized to .done/");
	assert.ok(!existsSync(join(layoutW.mainMailboxDeliveringDir, `${esc.id}.json`)));
	assert.equal(mailbox.pendingCount(layoutW.mainMailboxDir), 0);
	// And another restart resurrects nothing.
	await fire("session_shutdown");
	await fire("session_start");
	assert.equal(sentMessages.length, 1, "restart after verified delivery re-delivers nothing");
	ok("verified delivery finalizes exactly once; restarts never resurrect seen mail");

	await fire("session_shutdown");
	process.env.HOME = prevHome;
}

console.log(`\nall ${passed} runtime-fixes regression tests passed`);
process.exit(0);
