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
 * (4) Warning-only autonomy thresholds never gate work or mutate unrelated
 *     waiting/running lifecycle state.
 *
 * Harness: jiti-alias pattern + text-only mock provider (see env.mjs and
 * phase3-mail.mjs). Run: node test/e2e/phase-runtime-fixes.mjs
 */
import { strict as assert } from "node:assert";
import { spawn as spawnChild } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readRegistry, updateRegistry, getAgent } = await jiti.import(join(EXT, "store/registry.ts"));
const { InProcessRuntime } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const { createSubagentTools } = await jiti.import(join(EXT, "tools/sub-agent.ts"));
const { AutonomyBudget } = await jiti.import(join(EXT, "rails/autonomy.ts"));
const { makeEnvelope, ulid } = await jiti.import(join(EXT, "mail/envelope.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { readTeams } = await jiti.import(join(EXT, "store/teams.ts"));
const { readSettingsFile, loadSettings, applySettingsInto, defaultSettings } = await jiti.import(join(EXT, "store/settings.ts"));

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

// When > 0, the mock holds the turn `streaming` for this long before finishing
// — long enough for a test to interrupt() it mid-flight (the turn still settles
// on its own so abort()/waitForIdle never deadlocks).
let streamDelayMs = 0;
function mockStream(model) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
		const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), content: [{ type: "text", text: "ok" }], stopReason: "stop" };
		stream.push({ type: "start", partial: output });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		if (streamDelayMs > 0) await new Promise((r) => setTimeout(r, streamDelayMs));
		try {
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch {
			// The consumer is gone (aborted) — nothing to push.
		}
	})();
	return stream;
}
const authStorage = piSdk.AuthStorage.create(join(home, ".pi", "agent", "auth.json"));
const modelRegistry = piSdk.ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider("mock", {
	baseUrl: "http://mock.invalid", apiKey: "k", api: "mock-api", streamSimple: mockStream,
	models: [{ id: "mock-1", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
});
const layout = createLayout(project, { home, sessionId: "test-session" });
const settingsManager = piSdk.SettingsManager.create(project, join(home, ".pi", "agent"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh, isolated project world with the mock worker type (empty registry). */
function makeWorld(name) {
	const proj = join(scratch, name);
	mkdirSync(join(proj, ".pi", "subagents"), { recursive: true });
	writeFileSync(
		join(proj, ".pi", "subagents", "worker.md"),
		["---", "name: worker", "description: iso worker", "model: mock/mock-1", "projectContext: false", "---", "You are a worker.", ""].join("\n"),
	);
	return createLayout(proj, { home, sessionId: "test-session" });
}

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

	// An operational read failure is not evidence of corrupt contents. Keep the
	// exact envelope pathname durable and propagate so the runtime retry path
	// can try again instead of quarantining valid-but-temporarily-unreadable mail.
	const loopTarget = join(box, "io-loop");
	const operationalName = `msg_${ulid()}.json`;
	symlinkSync("io-loop", loopTarget);
	symlinkSync("io-loop", join(box, operationalName));
	assert.throws(() => mailbox.readPending(box), /ELOOP/);
	assert.ok(lstatSync(join(box, operationalName)).isSymbolicLink(), "operational failure left envelope in place");
	rmSync(join(box, operationalName), { force: true });
	rmSync(loopTarget, { force: true });
	ok("operational envelope read failures propagate without quarantine/mail loss");

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
		hops: 8, // at the normal cap: funeral errors must bypass the hops guard
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

	// A transient bounce-route failure must abort before archive/removal. The
	// acknowledged inbound envelope remains retryable instead of being buried.
	await runtime.spawn({ type: "worker", id: "bounce-failure-target" });
	const bounceFailureBox = layout.mailboxDir("worker", "bounce-failure-target");
	const mustBounce = makeEnvelope({
		from: "worker/asker",
		to: "worker/bounce-failure-target",
		type: "question",
		text: "this acknowledged question must not be buried",
	});
	mailbox.writeEnvelope(bounceFailureBox, mustBounce);
	const realBounce = runtime._deliverer.bounceUndelivered.bind(runtime._deliverer);
	runtime._deliverer.bounceUndelivered = () => { throw new Error("synthetic bounce I/O failure"); };
	await assert.rejects(() => runtime.retire("worker/bounce-failure-target"), /synthetic bounce I\/O failure/);
	assert.ok(getAgent(readRegistry(layout.registryFile), "worker/bounce-failure-target"), "failed funeral did not publish registry removal");
	assert.equal(mailbox.pendingCount(bounceFailureBox), 1, "failed funeral kept inbound mail pending");
	runtime._deliverer.bounceUndelivered = realBounce;
	await runtime.retire("worker/bounce-failure-target");
	ok("bounce write failure aborts retirement before acknowledged mail can be archived");

	// Automatic oneshot retirement is different from an explicit owner funeral:
	// main/user mail racing the final report was not the retirement command and
	// must fail visibly instead of being quietly buried.
	const auto = await runtime.spawn({ type: "worker", lifetime: "oneshot" });
	const [autoType, autoId] = auto.address.split("/");
	const beforeFinal = makeEnvelope({
		from: "main",
		to: auto.address,
		type: "message",
		text: "queued just before the final report",
	});
	mailbox.writeEnvelope(layout.mailboxDir(autoType, autoId), beforeFinal);
	runtime._mailPort.noteFinalReport(auto.address);
	await assert.rejects(
		() => runtime.send({ to: auto.address, text: "raced just after the final report" }),
		/No agent/,
		"post-final inbound mail bounces immediately",
	);
	await runtime._startRetire(auto.address, true);
	const mainMail = [
		...mailbox.readPending(layout.mainMailboxDir).map((p) => p.envelope),
		...readDoneEnvelopes(layout.mainMailboxDir),
	];
	assert.ok(
		mainMail.some((envelope) => envelope.type === "error" && envelope.correlationId === beforeFinal.id),
		"pre-final held main mail receives a funeral failure during auto-retire",
	);
	ok("oneshot final report closes inbound delivery and bounces already-held owner mail");

	const duplicateFinal = await runtime.spawn({ type: "worker", lifetime: "oneshot" });
	const reportTool = createSubagentTools(duplicateFinal.address, runtime._mailPort).find((tool) => tool.name === "report");
	assert.ok(reportTool);
	const firstFinal = await reportTool.execute("final-1", { text: "the actual final", final: true });
	assert.equal(firstFinal.isError, undefined);
	const firstEvidence = runtime._handles.get(duplicateFinal.address)?.retirementEvidenceId;
	assert.ok(firstEvidence);
	const rejectedSecond = await reportTool.execute("final-2", {
		text: "x".repeat(20_000),
		final: true,
	});
	assert.equal(rejectedSecond.isError, true);
	assert.match(rejectedSecond.content[0].text, /already delivered|already in flight/);
	assert.equal(runtime._handles.get(duplicateFinal.address)?.retirementEvidenceId, firstEvidence);
	assert.equal(runtime._handles.get(duplicateFinal.address)?.retireAfterTurn, true);
	await runtime._startRetire(duplicateFinal.address, true);
	ok("a failed duplicate final report cannot cancel the first final's retirement");

	// The archived mailbox keeps the original (funeral loses nothing on disk).
	await sleep(400); // let bounce-wake turns settle before dispose
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
// (4) Warning-only autonomy accounting never mutates lifecycle state
// ---------------------------------------------------------------------------
console.log("(4) warning thresholds preserve lifecycle state:");
{
	const autonomy = new AutonomyBudget({ autonomousTurns: 10_000, autonomousTokens: 10 });
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2, autonomy });
	await runtime.spawn({ type: "worker", id: "waiter" });
	await runtime.spawn({ type: "worker", id: "sleeper" });
	await sleep(100);
	updateRegistry(layout.registryFile, (reg) => {
		getAgent(reg, "worker/waiter").state = "waiting";
	});
	mailbox.writeEnvelope(layout.mailboxDir("worker", "waiter"), makeEnvelope({
		from: "main", to: "worker/waiter", type: "message", text: "queued behind the escalation",
	}));
	assert.equal(autonomy.noteTokens(20), "tokens");
	assert.equal(autonomy.paused, false);
	assert.equal(autonomy.canStart(), true);
	await runtime.send({ to: "worker/sleeper", text: "work continues after the warning" });
	for (let i = 0; i < 400 && mailbox.pendingCount(layout.mailboxDir("worker", "sleeper")) > 0; i++) await sleep(15);
	assert.equal(mailbox.pendingCount(layout.mailboxDir("worker", "sleeper")), 0, "new work still runs");
	assert.equal(getAgent(readRegistry(layout.registryFile), "worker/waiter")?.state, "waiting", "warning does not clobber waiting state");
	assert.equal(mailbox.pendingCount(layout.mailboxDir("worker", "waiter")), 1, "waiter's own boundary still owns queued mail");
	ok("autonomy thresholds warn without pausing or mutating unrelated agents");
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
	const layoutM = createLayout(projectM, { home, sessionId: "test-session" });
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
	const core1 = createCore({ cwd: projectM, home, sessionId: "test-session", settings: {} });
	const digest1 = core1.drainMainMail(sessionFile);
	assert.ok(digest1.includes("ESC_MARKER") && digest1.includes(esc.id), "digest composed with the envelope id embedded");
	assert.equal(mailbox.pendingCount(layoutM.mainMailboxDir), 0, "drained mail no longer pending");
	assert.ok(!existsSync(join(layoutM.mainMailboxDoneDir, `${esc.id}.json`)), "NOT finalized at compose time");
	assert.ok(existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json`)), "parked in .delivering/ awaiting the host append");
	assert.ok(existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json.meta`)), "target session file on record");
	ok("drain parks envelopes in .delivering/ instead of finalizing (host append unverified)");

	// A second startup/reconciler cannot use the fresh-process assumption while
	// this scope has a live host. It may inspect/finalize proven mail, but must
	// not requeue this digest before the owning host appends it.
	assert.deepEqual(
		reconcileMainMailFor(projectM, { home, sessionId: "test-session" }),
		{ finalized: [], requeued: [], inFlight: [esc.id] },
	);
	assert.ok(existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json`)));
	ok("live host lease prevents foreign startup reconciliation from requeueing in-flight mail");

	// In the SAME process an unverified envelope is in flight, never re-queued —
	// a drain loop can't double-deliver it (and can't double-charge the D21 pool).
	assert.equal(core1.drainMainMail(sessionFile), null, "no re-delivery while the injection may be in flight");
	assert.ok(existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json`)), "still parked");
	ok("in-process re-drain leaves in-flight envelopes alone (no double delivery)");

	// CRASH: host dies before appending the injected digest. Restart:
	await core1.dispose();
	const rec = reconcileMainMailFor(projectM, { home, sessionId: "test-session" });
	assert.deepEqual(rec, { finalized: [], requeued: [esc.id], inFlight: [] }, "session_start reconcile detects the loss");
	assert.equal(mailbox.pendingCount(layoutM.mainMailboxDir), 1, "escalation back in the pending mailbox");
	const core2 = createCore({ cwd: projectM, home, sessionId: "test-session", settings: {} });
	const digest2 = core2.drainMainMail(sessionFile);
	assert.ok(digest2.includes("ESC_MARKER"), "escalation re-delivered after the crash (was: silently lost)");
	assert.match(digest2, /re-delivered: an earlier delivery attempt did not complete/, "re-delivery labeled in the digest");
	ok("crash before the host append RE-DELIVERS the escalation on restart (at-least-once)");

	// A crash-truncated JSONL line may already contain both raw strings; it is
	// not a loadable host message and must never finalize the parked envelope.
	writeFileSync(
		sessionFile,
		`{"type":"custom_message","customType":"subagent-mail","content":"partial ${esc.id}`,
		{ flag: "a" },
	);
	assert.equal(core2.drainMainMail(sessionFile), null);
	assert.ok(existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json`)), "truncated host line stays unverified");
	writeFileSync(sessionFile, "\n", { flag: "a" });

	// --- no-crash path: host appends → next opportunity finalizes exactly once
	hostAppend("subagent-mail", digest2);
	assert.equal(core2.drainMainMail(sessionFile), null, "nothing pending after the verified delivery");
	assert.ok(existsSync(join(layoutM.mainMailboxDoneDir, `${esc.id}.json`)), "finalized to .done/ once verified in the JSONL");
	assert.ok(!existsSync(join(layoutM.mainMailboxDeliveringDir, `${esc.id}.json`)), ".delivering/ cleared");
	assert.equal(mailbox.pendingCount(layoutM.mainMailboxDir), 0);
	// Idempotent: neither reconcile flavor resurrects mail the agent has seen.
	assert.deepEqual(reconcileMainMailFor(projectM, { home, sessionId: "test-session" }), { finalized: [], requeued: [], inFlight: [] });
	assert.equal(core2.drainMainMail(sessionFile), null, "finalized exactly once — never re-delivered");
	ok("verified host append finalizes exactly once; reconciliation never resurrects seen mail");

	// --- no verifiable target (stub host / non-persisted session) ------------
	const plain = makeEnvelope({ from: "worker/alpha", to: "main", type: "report", text: "PLAIN_MARKER" });
	mailbox.writeEnvelope(layoutM.mainMailboxDir, plain);
	const digest3 = core2.drainMainMail(null);
	assert.ok(digest3.includes("PLAIN_MARKER"));
	assert.ok(existsSync(join(layoutM.mainMailboxDoneDir, `${plain.id}.json`)), "no session file → finalize at compose time (old behavior)");
	core2.commitMainMailDrain();
	ok("null session file falls back to compose-time finalize (nothing durable to verify against)");

	const noSessionFailure = makeEnvelope({ from: "worker/alpha", to: "main", type: "report", text: "NO_SESSION_FAILURE" });
	mailbox.writeEnvelope(layoutM.mainMailboxDir, noSessionFailure);
	assert.match(core2.drainMainMail(null), /NO_SESSION_FAILURE/);
	core2.rollbackMainMailDrain();
	assert.equal(mailbox.pendingCount(layoutM.mainMailboxDir), 1, "no-session provisional .done claim restored after injection failure");
	assert.ok(!existsSync(join(layoutM.mainMailboxDoneDir, `${noSessionFailure.id}.json`)));
	assert.match(core2.drainMainMail(null), /NO_SESSION_FAILURE/, "restored no-session mail can be retried");
	core2.commitMainMailDrain();
	ok("no-session synchronous injection failure requeues provisional done mail");
	await core2.dispose();
}

// ---------------------------------------------------------------------------
// (6) Main-mail durability (index.ts): no notification-driven auto-wake;
//     crash-lost delivery is requeued for the next genuine user turn.
// ---------------------------------------------------------------------------
console.log("(6) main-mail durability without auto-wake:");
{
	const extensionFactory = (await jiti.import(join(EXT, "index.ts"))).default ?? (await jiti.import(join(EXT, "index.ts")))
	const projectW = join(scratch, "project-mainmail-wiring");
	mkdirSync(projectW, { recursive: true });
	const layoutW = createLayout(projectW, { home, sessionId: "test-session" });
	const sessionFile = join(home, ".pi", "agent", "sessions", "fake-wiring-session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	const prevHome = process.env.HOME;
	process.env.HOME = home;
	const handlers = {};
	const sentMessages = [];
	const stubPi = {
		isStreaming: false,
		on: (event, handler) => (handlers[event] ??= []).push(handler),
		registerTool: () => {}, registerCommand: () => {}, registerShortcut: () => {},
		sendMessage: (message, options) => sentMessages.push({ message, options }),
	};
	extensionFactory(stubPi);
	const ctx = {
		cwd: projectW, modelRegistry, hasUI: true, mode: "tui",
		ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => sessionFile },
	};
	const fire = async (event) => {
		for (const h of handlers[event] ?? []) await h({ type: event }, ctx);
	};
	const hostAppend = (message) => {
		writeFileSync(sessionFile, `${JSON.stringify({ type: "custom-message", customType: message.customType, content: message.content })}\n`, { flag: "a" });
	};
	await fire("session_start");
	const esc = makeEnvelope({ from: "worker/alpha", to: "main", type: "escalation", text: "approve deploy? WIRE_ESC_MARKER" });
	mailbox.writeEnvelope(layoutW.mainMailboxDir, esc);
	await fire("agent_settled");
	assert.equal(sentMessages.length, 0, "idle mail never starts main");
	const injected = await handlers.before_agent_start[0]({ type: "before_agent_start" }, ctx);
	assert.match(injected.message.content, /WIRE_ESC_MARKER/);
	assert.ok(existsSync(join(layoutW.mainMailboxDeliveringDir, `${esc.id}.json`)));
	await fire("session_shutdown"); // crash before host append
	await fire("session_start");
	await fire("agent_settled");
	assert.equal(sentMessages.length, 0, "restart recovery also never auto-wakes main");
	const retried = await handlers.before_agent_start[0]({ type: "before_agent_start" }, ctx);
	assert.match(retried.message.content, /WIRE_ESC_MARKER/);
	assert.match(retried.message.content, /re-delivered: an earlier delivery attempt did not complete/);
	hostAppend(retried.message);
	const second = await handlers.before_agent_start[0]({ type: "before_agent_start" }, ctx);
	assert.equal(second, undefined);
	assert.ok(existsSync(join(layoutW.mainMailboxDoneDir, `${esc.id}.json`)));
	assert.equal(sentMessages.length, 0);
	ok("crash-lost main mail waits durably for the next real user turn and finalizes exactly once");
	await fire("session_shutdown");
	process.env.HOME = prevHome;
}

// ---------------------------------------------------------------------------
// Additional lifecycle guards: get-or-create cannot change lifetime, and run
// ownership is exclusive per runtime even when two cores share one PID.
// ---------------------------------------------------------------------------
console.log("(6b) lifetime and same-PID runtime ownership guards:");
{
	const layoutG = makeWorld("lifecycle-guard-world");
	const runtime1 = new InProcessRuntime({ layout: layoutG, modelRegistry, settingsManager, maxConcurrent: 2 });
	const oneshot = await runtime1.spawn({ type: "worker", lifetime: "oneshot" });
	const oneshotId = oneshot.address.split("/")[1];
	await assert.rejects(
		() => runtime1.spawn({ type: "worker", id: oneshotId, lifetime: "persistent" }),
		/active oneshot agent/,
		"persistent get-or-create must not hijack a disposable identity",
	);

	await runtime1.spawn({ type: "worker", id: "same-pid-owner" });
	assert.equal(runtime1._claimRunOwner("worker", "same-pid-owner"), true);
	const ownerBox = layoutG.mailboxDir("worker", "same-pid-owner");
	mailbox.writeEnvelope(ownerBox, makeEnvelope({
		from: "main", to: "worker/same-pid-owner", type: "message", text: "already queued before replacement startup",
	}));
	const runtime2 = new InProcessRuntime({ layout: layoutG, modelRegistry, settingsManager, maxConcurrent: 2 });
	assert.ok(runtime2._foreignRunOwner("worker", "same-pid-owner"), "different runtimeId in this PID is foreign");
	assert.equal(runtime2._claimRunOwner("worker", "same-pid-owner"), false, "same-PID second runtime cannot steal marker");
	await sleep(80);
	assert.equal(mailbox.pendingCount(ownerBox), 1, "startup leaves pre-existing mail queued while old work is genuinely live");
	runtime1._clearRunOwner("worker", "same-pid-owner");
	// Reacquire in this runtime before the old-owner poll fires. The poll must
	// recognize the successor generation as ours and never clear/reset it.
	streamDelayMs = 700;
	runtime2._scheduleMailTurn("worker/same-pid-owner");
	for (let i = 0; i < 100 && getAgent(readRegistry(layoutG.registryFile), "worker/same-pid-owner")?.state !== "running"; i++) await sleep(10);
	assert.equal(JSON.parse(readFileSync(join(layoutG.agentInstanceDir("worker", "same-pid-owner"), ".run-owner.json"), "utf8")).runtimeId, runtime2._runtimeId);
	await sleep(350); // crosses the old poll's 250ms boundary
	assert.equal(getAgent(readRegistry(layoutG.registryFile), "worker/same-pid-owner")?.state, "running", "old-generation poll did not reset successor turn");
	assert.equal(JSON.parse(readFileSync(join(layoutG.agentInstanceDir("worker", "same-pid-owner"), ".run-owner.json"), "utf8")).runtimeId, runtime2._runtimeId, "old-generation poll did not unlink successor marker");
	streamDelayMs = 0;
	for (let i = 0; i < 100 && mailbox.pendingCount(ownerBox) > 0; i++) await sleep(20);
	assert.equal(mailbox.pendingCount(ownerBox), 0, "successor turn drains queued mail after exact owner release");

	await runtime1.spawn({ type: "worker", id: "poll-generation" });
	assert.equal(runtime1._claimRunOwner("worker", "poll-generation"), true);
	const oldPollGeneration = getAgent(readRegistry(layoutG.registryFile), "worker/poll-generation").generationId;
	const runtime3 = new InProcessRuntime({ layout: layoutG, modelRegistry, settingsManager, maxConcurrent: 2 });
	runtime1._clearRunOwner("worker", "poll-generation");
	await runtime1.retire("worker/poll-generation");
	await runtime1.spawn({ type: "worker", id: "poll-generation" });
	const replacementPollGeneration = getAgent(readRegistry(layoutG.registryFile), "worker/poll-generation").generationId;
	assert.notEqual(replacementPollGeneration, oldPollGeneration);
	await sleep(350);
	const replacementPollRecord = getAgent(readRegistry(layoutG.registryFile), "worker/poll-generation");
	assert.equal(replacementPollRecord?.generationId, replacementPollGeneration, "old poll did not target replacement incarnation");
	assert.equal(replacementPollRecord?.state, "dormant");
	await runtime3.dispose();
	ok("same-PID runtimes never steal ownership; stale polls are incarnation-scoped");
	await runtime2.dispose();
	await runtime1.dispose();
}

// ---------------------------------------------------------------------------
// (7) Finding 1 — interrupt/shutdown leaves the triggering mail PENDING and the
//     agent alive (was: markDone ran unconditionally after an aborted turn,
//     consuming the mail the subagent_interrupt contract says must survive).
// ---------------------------------------------------------------------------
console.log("(7) interrupt leaves triggering mail pending + agent alive (Finding 1):");
{
	const layoutI = makeWorld("interrupt-world");
	const runtime = new InProcessRuntime({ layout: layoutI, modelRegistry, settingsManager, maxConcurrent: 2 });
	const events = [];
	runtime.onEvent((e) => events.push(e));

	// Hold the turn streaming so we can interrupt it mid-flight.
	streamDelayMs = 800;
	await runtime.spawn({ type: "worker", id: "victim", task: "long task INT_MARKER" });
	for (let i = 0; i < 400 && !events.some((e) => e.type === "turn-started" && e.address === "worker/victim"); i++) await sleep(15);
	await sleep(60); // ensure prompt() is actually streaming
	const res = await runtime.interrupt("worker/victim");
	assert.equal(res.interrupted, true, "interrupt fired on the streaming turn");
	streamDelayMs = 0;
	for (let i = 0; i < 400 && !events.some((e) => e.type === "turn-finished" && e.address === "worker/victim"); i++) await sleep(15);

	const box = layoutI.mailboxDir("worker", "victim");
	assert.equal(mailbox.pendingCount(box), 1, "triggering mail LEFT PENDING after interrupt (not consumed)");
	const rec = getAgent(readRegistry(layoutI.registryFile), "worker/victim");
	assert.ok(rec, "agent still alive (interrupt does not retire)");
	assert.equal(rec.state, "dormant", "interrupted agent parks dormant");

	// No IMMEDIATE auto-retry — the mail waits for a real wake, not a self-re-run.
	await sleep(300);
	assert.equal(mailbox.pendingCount(box), 1, "no immediate auto-retry — mail waits for a real wake");

	// A fresh send is that real wake: the pending mail re-delivers and drains.
	await runtime.send({ to: "worker/victim", text: "resume please" });
	for (let i = 0; i < 400 && mailbox.pendingCount(box) > 0; i++) await sleep(15);
	assert.equal(mailbox.pendingCount(box), 0, "next real wake re-delivers the interrupted mail (at-least-once)");
	ok("interrupt leaves the triggering envelope pending + agent alive + no auto-retry; next wake re-delivers");
	await runtime.dispose();
}

// ---------------------------------------------------------------------------
// (8) Finding 5 — a LIVE foreign run-owner blocks the wake WITHOUT clobbering
//     its marker (was: check-then-write overwrote it); a DEAD owner's stale
//     marker is swept by the atomic (wx) claim and the turn runs.
// ---------------------------------------------------------------------------
console.log("(8) atomic run-owner claim — live foreign blocks, stale swept (Finding 5):");
{
	const layoutC = makeWorld("claim-world");
	const runtime = new InProcessRuntime({ layout: layoutC, modelRegistry, settingsManager, maxConcurrent: 2 });
	const events = [];
	runtime.onEvent((e) => events.push(e));
	await runtime.spawn({ type: "worker", id: "shared" }); // dormant; instance dir exists
	await sleep(50);

	// A live FOREIGN process "owns" the run marker.
	const child = spawnChild(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { stdio: "ignore" });
	const ownerFile = join(layoutC.agentInstanceDir("worker", "shared"), ".run-owner.json");
	writeFileSync(ownerFile, JSON.stringify({
		pid: child.pid,
		runtimeId: "pid-reused-rt",
		processStartToken: "not-this-process-instance",
		claimedAt: new Date().toISOString(),
	}));
	assert.equal(runtime._foreignRunOwner("worker", "shared"), null, "live PID with mismatched start token is stale");
	assert.equal(runtime._claimRunOwner("worker", "shared"), true, "PID-reused marker can be reclaimed");
	runtime._clearRunOwner("worker", "shared");

	// Legacy token-less markers still recognize the genuinely live child.
	writeFileSync(ownerFile, JSON.stringify({ pid: child.pid, runtimeId: "foreign-rt", claimedAt: new Date().toISOString() }));

	await runtime.send({ to: "worker/shared", text: "do not double-run" });
	await sleep(400);
	assert.equal(mailbox.pendingCount(layoutC.mailboxDir("worker", "shared")), 1, "mail stays queued under a live foreign owner");
	assert.ok(
		events.some((e) => e.type === "turn-error" && /run-owned by another live|Lost the run-ownership/.test(e.error)),
		"turn-error notes the foreign owner",
	);
	const stillForeign = JSON.parse(readFileSync(ownerFile, "utf8"));
	assert.equal(stillForeign.pid, child.pid, "live owner's marker NOT clobbered (was: check-then-write overwrote it)");
	assert.equal(stillForeign.runtimeId, "foreign-rt");
	await runtime.dispose();

	// The owner dies; ANOTHER process (fresh runtime, cross-process takeover)
	// starts up. Reconciliation sees the dead-pid marker, sweeps it, and drains
	// the queued mail — the atomic claim now succeeds for the new owner.
	child.kill("SIGKILL");
	await new Promise((r) => child.on("exit", r));
	const runtime2 = new InProcessRuntime({ layout: layoutC, modelRegistry, settingsManager, maxConcurrent: 2 });
	for (let i = 0; i < 400 && mailbox.pendingCount(layoutC.mailboxDir("worker", "shared")) > 0; i++) await sleep(15);
	assert.equal(mailbox.pendingCount(layoutC.mailboxDir("worker", "shared")), 0, "dead-pid owner swept; the new owner's atomic claim runs the turn and drains");
	assert.ok(!existsSync(ownerFile), "stale run-owner marker cleared");
	const malformedCandidate = `${ownerFile}.candidate-crashed-writer`;
	writeFileSync(malformedCandidate, "{ partial", "utf8");
	const candidateOld = new Date(Date.now() - 120_000);
	utimesSync(malformedCandidate, candidateOld, candidateOld);
	assert.equal(runtime2._claimRunOwner("worker", "shared"), true);
	runtime2._clearRunOwner("worker", "shared");
	assert.ok(!existsSync(malformedCandidate), "aged malformed private candidate swept");

	// Operational owner reads fail closed: they cannot authorize a second run
	// and the uncertain marker is never unlinked as though it were stale JSON.
	const ownerLoop = join(layoutC.agentInstanceDir("worker", "shared"), "owner-loop");
	symlinkSync("owner-loop", ownerLoop);
	symlinkSync("owner-loop", ownerFile);
	assert.ok(runtime2._foreignRunOwner("worker", "shared"), "unreadable owner is conservatively foreign");
	assert.equal(runtime2._claimRunOwner("worker", "shared"), false);
	assert.ok(lstatSync(ownerFile).isSymbolicLink(), "operational read failure did not unlink owner marker");
	rmSync(ownerFile, { force: true });
	rmSync(ownerLoop, { force: true });
	ok("live/unreadable foreign owners fail closed; dead owners are reclaimed atomically");
	await runtime2.dispose();
}

// ---------------------------------------------------------------------------
// (9) Finding 13 — a retire that CRASHED after the archive move but before the
//     registry removal is reconciled on restart (record removed), and a fresh
//     same-address spawn does NOT resurrect the old memory.
// ---------------------------------------------------------------------------
console.log("(9) retire tombstone survives a mid-retire crash; no resurrection (Finding 13):");
{
	const layoutR = makeWorld("retire-crash-world");
	const runtime = new InProcessRuntime({ layout: layoutR, modelRegistry, settingsManager, maxConcurrent: 2 });
	const ev1 = [];
	runtime.onEvent((e) => ev1.push(e));
	await runtime.spawn({ type: "worker", id: "ghost", team: "afterlife", task: "remember GHOST_MEMORY_MARKER" });
	for (let i = 0; i < 400 && !ev1.some((e) => e.type === "turn-finished" && e.address === "worker/ghost"); i++) await sleep(15);
	await runtime.dispose();

	// Simulate a crash after durable tombstoning but before the archive move.
	// The registry must continue reserving the address until recovery archives
	// memory and scrubs teams; registry removal is the final publication step.
	const sourceDir = layoutR.agentInstanceDir("worker", "ghost");
	writeFileSync(join(sourceDir, ".retired-at"), `${new Date().toISOString()}\n`);
	assert.ok(getAgent(readRegistry(layoutR.registryFile), "worker/ghost"), "registry still reserves the address");
	assert.ok(existsSync(sourceDir), "old live-memory directory still exists at the crash point");

	// A transient operational mailbox read during recovery must install an
	// in-process retry rather than silently leaving every crashed state held.
	const mailboxPath = layoutR.mailboxDir("worker", "ghost");
	const heldMailbox = join(sourceDir, "mailbox-held-for-retry");
	rmSync(heldMailbox, { recursive: true, force: true });
	renameSync(mailboxPath, heldMailbox);
	symlinkSync("mailbox", mailboxPath); // self-loop -> ELOOP
	// Restart: the first reconciliation fails closed, then retries beneath the lifecycle lock.
	const runtime2 = new InProcessRuntime({ layout: layoutR, modelRegistry, settingsManager, maxConcurrent: 2 });
	assert.ok(runtime2._startupRecoveryTimer, "failed startup funeral scheduled durable retry");
	rmSync(mailboxPath, { force: true });
	renameSync(heldMailbox, mailboxPath);
	const ev2 = [];
	runtime2.onEvent((e) => ev2.push(e));
	for (let i = 0; i < 100 && getAgent(readRegistry(layoutR.registryFile), "worker/ghost"); i++) await sleep(20);
	assert.equal(getAgent(readRegistry(layoutR.registryFile), "worker/ghost"), undefined, "crashed retire reconciled on retry — record removed last");
	const archiveDir = layoutR.archiveDir("worker", "ghost");
	assert.ok(existsSync(archiveDir), "old memory archived before the address became reusable");
	assert.ok(existsSync(join(archiveDir, ".retired-at")), "tombstone travelled with the move");
	assert.equal(readTeams(layoutR.teamsFile).afterlife, undefined, "old team membership scrubbed before publication");

	// A fresh same-address spawn is created ANEW with no resurrected memory.
	const again = await runtime2.spawn({ type: "worker", id: "ghost", task: "fresh start FRESH_MARKER" });
	assert.equal(again.created, true, "get-or-create makes a NEW identity, not a resurrected one");
	for (let i = 0; i < 400 && !ev2.some((e) => e.type === "turn-finished" && e.address === "worker/ghost"); i++) await sleep(15);
	const dir = layoutR.agentInstanceDir("worker", "ghost");
	const content = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(dir, f), "utf8")).join("");
	assert.ok(content.length > 0, "fresh session file written");
	assert.ok(!content.includes("GHOST_MEMORY_MARKER"), "old memory NOT resurrected into the fresh identity");
	ok("crashed retire (dir archived, record present) is reconciled on restart with no memory resurrection");
	await runtime2.dispose();
}

// ---------------------------------------------------------------------------
// (9b) Retirement drains old async work and rejects mail racing the funeral.
// ---------------------------------------------------------------------------
console.log("(9b) retirement generation + delivery fences:");
{
	const layoutD = makeWorld("retire-drain-world");
	const runtime = new InProcessRuntime({ layout: layoutD, modelRegistry, settingsManager, maxConcurrent: 2 });
	await runtime.spawn({ type: "worker", id: "draining" });
	const sourceDir = layoutD.agentInstanceDir("worker", "draining");
	let releaseOldWork;
	const gate = new Promise((resolve) => { releaseOldWork = resolve; });
	const oldWork = gate.then(() => {
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "late-old-generation.txt"), "must be archived, never inherited\n");
	});
	runtime._chains.set("worker/draining", oldWork);
	runtime._handleLocks.set("worker/draining", oldWork);
	void oldWork.then(() => {
		if (runtime._chains.get("worker/draining") === oldWork) runtime._chains.delete("worker/draining");
		if (runtime._handleLocks.get("worker/draining") === oldWork) runtime._handleLocks.delete("worker/draining");
	});
	let retirementSettled = false;
	const retiring = runtime.retire("worker/draining").then((result) => {
		retirementSettled = true;
		return result;
	});
	await sleep(60);
	assert.equal(retirementSettled, false, "registry/address is not published free while old async work remains");
	assert.ok(getAgent(readRegistry(layoutD.registryFile), "worker/draining"), "registry still reserves old generation");
	releaseOldWork();
	const retired = await retiring;
	assert.ok(retired.archiveDir && existsSync(join(retired.archiveDir, "late-old-generation.txt")), "late old work drained into its archive");
	await runtime.spawn({ type: "worker", id: "draining" });
	assert.ok(!existsSync(join(layoutD.agentInstanceDir("worker", "draining"), "late-old-generation.txt")), "replacement inherits no old-generation files");

	// Defense-in-depth overlap: another runtime can retire/recreate an idle
	// address while this runtime still caches its old in-memory handle. The
	// durable generation ID must force disposal/rebuild, never transcript reuse.
	await runtime.spawn({ type: "worker", id: "handle-aba" });
	const oldHandle = runtime._handles.get("worker/handle-aba");
	const oldGeneration = getAgent(readRegistry(layoutD.registryFile), "worker/handle-aba").generationId;
	const otherRuntime = new InProcessRuntime({ layout: layoutD, modelRegistry, settingsManager, maxConcurrent: 2 });
	await otherRuntime.retire("worker/handle-aba");
	await otherRuntime.spawn({ type: "worker", id: "handle-aba" });
	const newGeneration = getAgent(readRegistry(layoutD.registryFile), "worker/handle-aba").generationId;
	assert.notEqual(newGeneration, oldGeneration, "address recreation minted a new durable generation");
	await otherRuntime.dispose();
	await runtime.send({ to: "worker/handle-aba", text: "must use replacement generation" });
	for (let i = 0; i < 100 && runtime._handles.get("worker/handle-aba")?.generationId !== newGeneration; i++) await sleep(20);
	assert.equal(runtime._handles.get("worker/handle-aba")?.generationId, newGeneration);
	assert.notEqual(runtime._handles.get("worker/handle-aba"), oldHandle, "stale in-memory session was not migrated into replacement");

	await runtime.spawn({ type: "worker", id: "queued-generation-aba" });
	let releaseQueuedGeneration;
	const queuedGenerationGate = new Promise((resolve) => { releaseQueuedGeneration = resolve; });
	runtime._chains.set("worker/queued-generation-aba", queuedGenerationGate);
	await runtime.send({ to: "worker/queued-generation-aba", text: "generation A queued work" });
	const queueRuntimeB = new InProcessRuntime({ layout: layoutD, modelRegistry, settingsManager, maxConcurrent: 2 });
	await queueRuntimeB.retire("worker/queued-generation-aba");
	await queueRuntimeB.spawn({ type: "worker", id: "queued-generation-aba" });
	const replacementQueueBox = layoutD.mailboxDir("worker", "queued-generation-aba");
	mailbox.writeEnvelope(replacementQueueBox, makeEnvelope({
		from: "main", to: "worker/queued-generation-aba", type: "message", text: "generation B work",
	}));
	releaseQueuedGeneration();
	await sleep(100);
	assert.equal(getAgent(readRegistry(layoutD.registryFile), "worker/queued-generation-aba")?.state, "dormant", "generation-A queued turn did not stamp B");
	assert.equal(mailbox.pendingCount(replacementQueueBox), 1, "generation-A queued turn did not consume B mailbox");
	queueRuntimeB._scheduleMailTurn("worker/queued-generation-aba");
	for (let i = 0; i < 100 && mailbox.pendingCount(replacementQueueBox) > 0; i++) await sleep(20);
	assert.equal(mailbox.pendingCount(replacementQueueBox), 0);
	await queueRuntimeB.dispose();

	await runtime.spawn({ type: "worker", id: "mail-race" });
	const bouncePending = runtime._bouncePendingMail.bind(runtime);
	let racingSend;
	runtime._bouncePendingMail = (address, record) => {
		bouncePending(address, record);
		if (address === "worker/mail-race") {
			racingSend = runtime.send({ to: address, text: "arrived during the funeral" });
			void racingSend.catch(() => {});
		}
	};
	await runtime.retire("worker/mail-race");
	await assert.rejects(racingSend, /No agent|retired/);
	assert.ok(!existsSync(layoutD.agentInstanceDir("worker", "mail-race")), "racing delivery cannot recreate a retired mailbox path");
	ok("retirement drains old generation work and atomically bounces racing delivery");
	await runtime.dispose();
}

// ---------------------------------------------------------------------------
// (10) sendAsUser opens a fresh warning-accounting window, but there is no
//      paused queue or global resume-drain behavior.
// ---------------------------------------------------------------------------
console.log("(10) sendAsUser resets warning accounting without pause/resume:");
{
	const layoutU = makeWorld("senduser-world");
	const autonomy = new AutonomyBudget({ autonomousTurns: 1e9, autonomousTokens: 100 });
	const runtime = new InProcessRuntime({ layout: layoutU, modelRegistry, settingsManager, maxConcurrent: 2, autonomy });
	const events = [];
	runtime.onEvent((e) => events.push(e));
	await runtime.spawn({ type: "worker", id: "direct" });
	await runtime.spawn({ type: "worker", id: "sleeper" });
	await sleep(80);
	assert.equal(autonomy.noteTokens(200), "tokens");
	assert.equal(autonomy.paused, false);
	mailbox.writeEnvelope(layoutU.mailboxDir("worker", "sleeper"), makeEnvelope({
		from: "main", to: "worker/sleeper", type: "message", text: "unscheduled durable mail",
	}));
	const before = events.filter((e) => e.type === "turn-finished").length;
	await runtime.send({ to: "worker/direct", text: "autonomous work still runs" });
	for (let i = 0; i < 400 && events.filter((e) => e.type === "turn-finished").length <= before; i++) await sleep(15);
	assert.ok(events.filter((e) => e.type === "turn-finished").length > before, "ordinary work ran beyond the threshold");
	assert.ok(autonomy.status().tokensUsed >= 200, "main send does not reset the accounting window");
	await runtime.sendAsUser({ to: "worker/direct", text: "user message DIRECT_MARKER" });
	assert.ok(autonomy.status().tokensUsed < 200, "direct user input opened a fresh accounting window");
	assert.equal(mailbox.pendingCount(layoutU.mailboxDir("worker", "sleeper")), 1, "no obsolete global resume-drain exists");
	await runtime.send({ to: "worker/sleeper", text: "explicit wake" });
	for (let i = 0; i < 400 && mailbox.pendingCount(layoutU.mailboxDir("worker", "sleeper")) > 0; i++) await sleep(15);
	assert.equal(mailbox.pendingCount(layoutU.mailboxDir("worker", "sleeper")), 0);
	ok("warning accounting resets on user input; execution never required resume");
	await runtime.dispose();
}

// ---------------------------------------------------------------------------
// (11) Finding 12 — a malformed settings file RETAINS its last-known-good layer
//      (was: collapsed to an empty layer, failing open to defaults) and warns;
//      an intentionally MISSING file removes the layer.
// ---------------------------------------------------------------------------
console.log("(11) settings last-known-good on malformed reload (Finding 12):");
{
	// readSettingsFile stays PURE: a parse failure is an empty patch flagged
	// `degraded` (retention lives in the live-reload path, not here).
	const probe = join(scratch, "lkg-probe.json");
	writeFileSync(probe, "{ not json");
	const badRead = readSettingsFile(probe);
	assert.deepEqual(badRead.values, {}, "readSettingsFile: empty patch on parse failure (pure)");
	assert.equal(badRead.degraded, true, "readSettingsFile: degraded flag set");
	assert.ok(badRead.warnings.some((w) => /invalid JSON/.test(w)));

	// The INITIAL load also seeds the fallback. The first file-watch event can
	// be a half-written save; it must retain startup's restrictive settings.
	const initialLay = {
		globalSettingsFile: join(scratch, "lkg-initial-global.json"),
		projectSettingsFile: join(scratch, "lkg-initial-project.json"),
	};
	writeFileSync(initialLay.projectSettingsFile, JSON.stringify({ maxTokensTotal: 4321 }));
	const initiallyLoaded = loadSettings(initialLay).settings;
	writeFileSync(initialLay.projectSettingsFile, "{ first save is half-written");
	applySettingsInto(initiallyLoaded, initialLay);
	assert.equal(initiallyLoaded.maxTokensTotal, 4321, "first malformed reload retained the initial load");

	// The live-reload path RETAINS the last-known-good layer for a degraded file
	// instead of failing open to defaults.
	const proj = join(scratch, "lkg-project");
	mkdirSync(proj, { recursive: true });
	const lay = {
		globalSettingsFile: join(scratch, "lkg-nonexistent-global.json"), // never present
		projectSettingsFile: join(proj, "subagents.json"),
	};
	writeFileSync(lay.projectSettingsFile, JSON.stringify({ maxTokensTotal: 1234, autonomousTurns: 7 }));
	const target = defaultSettings();
	let warnings = applySettingsInto(target, lay);
	assert.equal(target.maxTokensTotal, 1234, "valid reload applied the ceiling");
	assert.equal(target.autonomousTurns, 7);
	assert.deepEqual(warnings, []);

	// Malformed save: the restrictive live values are KEPT (not reset to defaults),
	// and the warning surfaces.
	writeFileSync(lay.projectSettingsFile, "{ half-written edit");
	warnings = applySettingsInto(target, lay);
	assert.equal(target.maxTokensTotal, 1234, "malformed reload KEPT the last-known-good ceiling (did NOT fail open)");
	assert.equal(target.autonomousTurns, 7, "malformed reload kept the last-known-good turn budget");
	assert.ok(warnings.some((w) => /invalid JSON/.test(w)), "warning surfaced for the malformed file");

	// Fix the file with a different value → the new value applies.
	writeFileSync(lay.projectSettingsFile, JSON.stringify({ maxTokensTotal: 50 }));
	applySettingsInto(target, lay);
	assert.equal(target.maxTokensTotal, 50, "a valid re-save takes effect");
	assert.equal(target.autonomousTurns, defaultSettings().autonomousTurns, "field absent in the new file falls back to default");

	// Intentional deletion removes the layer (back to defaults).
	rmSync(lay.projectSettingsFile, { force: true });
	applySettingsInto(target, lay);
	assert.equal(target.maxTokensTotal, undefined, "intentional deletion removed the layer (ceiling cleared)");
	ok("live reload keeps last-known-good on a malformed file + warns; a valid save or deletion updates the layer");
}

console.log(`\nall ${passed} runtime-fixes regression tests passed`);
process.exit(0);
