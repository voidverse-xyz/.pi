/**
 * Regression tests for the resource-lifecycle review fixes (leaks / unbounded
 * growth over a long-lived host process):
 *
 * (1) peek/readTranscriptTail: tail <= 0 means "vitals only" and returns []
 *     (previously slice(-0) = slice(0) returned the ENTIRE transcript — into
 *     the main agent's context on `subagent_status tail:0`, and re-read+parsed
 *     by the viewer's 1s poll forever). A positive tail returns exactly that
 *     many entries.
 * (2) _handleLocks: the per-address session-creation mutex map only holds
 *     IN-FLIGHT builds — settled locks self-delete, so N oneshot spawn+retire
 *     cycles (fresh tmp-<short> addresses) leave the map empty, and dispose()
 *     clears whatever is left.
 * (3) .sent-questions.json shrinks: consuming a correlated `answer` (or
 *     `error`) envelope deletes the question from the sent index AFTER the
 *     wake digest quoted it — the file no longer grows one entry per question
 *     for the agent's whole life.
 * (4) gcSweep coverage: aged mailbox/.corrupt/ quarantine files and aged
 *     .collect-requests.json entries are swept with the same N-day policy as
 *     .done/; cancelled escalation records age out while pending ones stay.
 * (5) Startup reconciliation cancels ORPHANED pending escalation records (a
 *     crash while `waiting` left a record no code would ever resolve — and
 *     gcEscalationRecords rightly never touches `pending`), while pending
 *     records of agents it did not reset stay intact.
 *
 * Harness: jiti-alias pattern + text-only mock provider (see env.mjs and
 * phase3-mail.mjs). Run: node test/e2e/phase-lifecycle-fixes.mjs
 */
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readRegistry, updateRegistry, getAgent } = await jiti.import(join(EXT, "store/registry.ts"));
const { InProcessRuntime, readTranscriptTail } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const { makeEnvelope, ulid } = await jiti.import(join(EXT, "mail/envelope.ts"));

// ulid() is monotonic-nondecreasing and never backdates (a wall-clock
// regression is treated as the same ms), so it cannot mint an id whose EMBEDDED
// timestamp is in the past. To fabricate an *aged* collect-request key (whose
// age gcCollectRequests reads from the key's own ULID time), encode the old ms
// directly — same Crockford-base32, 10-char big-endian time + 16 random chars
// as mail/envelope.ts, decoded by store/archive.ts's ulidTimestampMs.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulidAt(ms) {
	let time = "";
	let t = ms;
	for (let i = 0; i < 10; i++) {
		time = B32[t % 32] + time;
		t = Math.floor(t / 32);
	}
	let rand = "";
	for (let i = 0; i < 16; i++) rand += B32[Math.floor(Math.random() * 32)];
	return time + rand;
}
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const archive = await jiti.import(join(EXT, "store/archive.ts"));

// ---------------------------------------------------------------------------
// World + mock provider
// ---------------------------------------------------------------------------
const scratch = join(WORLDS, "lifecycle-fixes-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
writeFileSync(
	join(project, ".pi", "subagents", "worker.md"),
	["---", "name: worker", "description: lifecycle-test worker", "model: mock/mock-1", "projectContext: false", "---", "You are a worker.", ""].join("\n"),
);

let nextStreamGate = null;
function mockStream(model) {
	const stream = piAi.createAssistantMessageEventStream();
	const gate = nextStreamGate;
	nextStreamGate = null;
	(async () => {
		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
		const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), content: [{ type: "text", text: "ok" }], stopReason: "stop" };
		stream.push({ type: "start", partial: output });
		if (gate) await gate;
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
const layout = createLayout(project, { home, sessionId: "test-session" });
const settingsManager = piSdk.SettingsManager.create(project, join(home, ".pi", "agent"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY_MS = 24 * 60 * 60 * 1000;

let passed = 0;
function ok(name) {
	passed++;
	console.log(`  ok  ${name}`);
}

async function waitFor(predicate, what, tries = 400) {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return;
		await sleep(15);
	}
	assert.fail(`timed out waiting for: ${what}`);
}

const watchdog = setTimeout(() => {
	console.error("WATCHDOG: test file exceeded 120s — event loop starved or test wedged");
	process.exit(2);
}, 120_000);
watchdog.unref?.();

// ---------------------------------------------------------------------------
// (1) peek tail: 0 = vitals only, positive = exactly that many
// ---------------------------------------------------------------------------
console.log("(1) peek tail semantics:");
{
	// Pure function first: a 500-message transcript.
	const file = join(scratch, "fake-session.jsonl");
	const lines = [];
	for (let i = 0; i < 500; i++) {
		lines.push(JSON.stringify({ type: "message", timestamp: "t", message: { role: "user", content: `m${i}` } }));
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	assert.deepEqual(readTranscriptTail(file, 0), [], "tail 0 returns [] (was: the WHOLE transcript)");
	assert.deepEqual(readTranscriptTail(file, -3), [], "negative tail returns []");
	assert.equal(readTranscriptTail(file, 5).length, 5, "positive tail returns exactly that many");
	assert.equal(readTranscriptTail(file, 5)[4].text, "m499", "…and they are the LAST entries");
	ok("readTranscriptTail: tail<=0 → [], tail n → exactly the last n entries");

	// End-to-end through the runtime (subagent_status tail:0 / viewer poll path).
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	const events = [];
	runtime.onEvent((e) => events.push(e));
	await runtime.spawn({ type: "worker", id: "peeked", task: "hello" });
	await waitFor(() => events.some((e) => e.type === "turn-finished"), "task turn");

	const vitalsOnly = await runtime.peek("worker/peeked", 0);
	assert.ok(vitalsOnly, "peek returns the detail record");
	assert.deepEqual(vitalsOnly.tail, [], "peek(addr, 0) carries NO transcript");
	assert.equal(typeof vitalsOnly.vitals.tokens, "number", "…but vitals/header data is intact");
	assert.ok(vitalsOnly.sessionFile, "…and the sessionFile (viewer live-tail source) is intact");
	const tailed = await runtime.peek("worker/peeked", 2);
	assert.equal(tailed.tail.length, 2, "peek(addr, 2) returns exactly 2 entries");
	ok("runtime.peek: tail 0 = vitals only; positive tail = exactly that many");
	await runtime.dispose();
}

// ---------------------------------------------------------------------------
// (2) _handleLocks bounded: oneshot churn leaves no settled locks behind
// ---------------------------------------------------------------------------
console.log("(2) _handleLocks lifecycle:");
{
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	const N = 4;
	for (let i = 0; i < N; i++) {
		const r = await runtime.spawn({ type: "worker", lifetime: "oneshot", task: `job ${i}` });
		// The mock never calls report, so the oneshot parks dormant — wait for
		// the turn to settle, then retire manually (fresh tmp-<short> id each
		// cycle: exactly the pattern that leaked one dead lock per spawn).
		await waitFor(
			() => getAgent(readRegistry(layout.registryFile), r.address)?.state === "dormant",
			`${r.address} dormant`,
		);
		await runtime.retire(r.address);
	}
	assert.equal(runtime._handles.size, 0, "_handles empty after retires");
	assert.equal(runtime._chains.size, 0, "_chains empty after retires");
	assert.equal(runtime._handleLocks.size, 0, `_handleLocks empty after ${N} oneshot cycles (was: ${N}, one per spawn, forever)`);
	ok("settled creation locks self-delete — oneshot churn leaves the map empty");

	// A persistent agent mid-lifecycle, then dispose: the map must end empty.
	await runtime.spawn({ type: "worker", id: "keeper", task: "stay" });
	await waitFor(
		() => getAgent(readRegistry(layout.registryFile), "worker/keeper")?.state === "dormant",
		"worker/keeper dormant",
	);
	await runtime.dispose();
	assert.equal(runtime._handleLocks.size, 0, "_handleLocks empty after dispose");
	ok("dispose() clears _handleLocks alongside _handles/_chains");

	// A build already inside createAgentSession when shutdown begins must not
	// install a live handle after dispose's first handle sweep.
	const lateRuntime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	const buildSessionOptions = lateRuntime._buildSessionOptions.bind(lateRuntime);
	let releaseBuild;
	const buildGate = new Promise((resolve) => { releaseBuild = resolve; });
	lateRuntime._buildSessionOptions = async (...args) => {
		await buildGate;
		return buildSessionOptions(...args);
	};
	const lateSpawn = lateRuntime.spawn({ type: "worker", id: "dispose-build-race" });
	void lateSpawn.catch(() => {});
	await waitFor(() => lateRuntime._handleLocks.has("worker/dispose-build-race"), "in-flight handle build");
	const disposing = lateRuntime.dispose();
	await sleep(30);
	assert.equal(lateRuntime._disposed, true, "shutdown fence is visible to the in-flight builder");
	releaseBuild();
	await disposing;
	await assert.rejects(lateSpawn, /runtime was disposed/);
	assert.equal(lateRuntime._handles.size, 0, "late session was disposed instead of installed");
	assert.equal(lateRuntime._handleLocks.size, 0, "late build lock drained/cleared");
	await assert.rejects(
		() => lateRuntime.spawn({ type: "worker", id: "after-dispose" }),
		/runtime is disposed/,
		"disposed runtime rejects new builds",
	);
	ok("dispose fences and drains in-flight handle construction");

	// Address recreation, not only dispose, fences a build that crossed an
	// await. Generation A must never publish its session handle into B.
	const buildRuntimeA = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	const realBuildOptions = buildRuntimeA._buildSessionOptions.bind(buildRuntimeA);
	let releaseGenerationBuild;
	const generationBuildGate = new Promise((resolve) => { releaseGenerationBuild = resolve; });
	buildRuntimeA._buildSessionOptions = async (...args) => {
		await generationBuildGate;
		return realBuildOptions(...args);
	};
	const generationASpawn = buildRuntimeA.spawn({ type: "worker", id: "generation-build-race" });
	void generationASpawn.catch(() => {});
	await waitFor(() => buildRuntimeA._handleLocks.has("worker/generation-build-race"), "generation-A build in flight");
	const generationA = getAgent(readRegistry(layout.registryFile), "worker/generation-build-race").generationId;
	const buildRuntimeB = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	await buildRuntimeB.retire("worker/generation-build-race");
	await buildRuntimeB.spawn({ type: "worker", id: "generation-build-race" });
	const generationB = getAgent(readRegistry(layout.registryFile), "worker/generation-build-race").generationId;
	assert.notEqual(generationB, generationA);
	releaseGenerationBuild();
	await assert.rejects(generationASpawn, /retired\/recreated/);
	assert.equal(buildRuntimeA._handles.has("worker/generation-build-race"), false, "generation-A build never published a handle");
	await buildRuntimeA.dispose();
	await buildRuntimeB.dispose();
	ok("in-flight handle builds are fenced by durable address generation");

	// A provider that ignores abort may outlive the bounded drain. Once dispose
	// returns, its old finally block must not mutate a replacement host's record.
	let releaseTurn;
	nextStreamGate = new Promise((resolve) => { releaseTurn = resolve; });
	const timedRuntime = new InProcessRuntime({
		layout,
		modelRegistry,
		settingsManager,
		maxConcurrent: 2,
		disposeTimeoutMs: 35,
	});
	await timedRuntime.spawn({ type: "worker", id: "dispose-timeout-aba", task: "block past shutdown" });
	await waitFor(
		() => getAgent(readRegistry(layout.registryFile), "worker/dispose-timeout-aba")?.state === "running",
		"timed-out turn running",
	);
	await timedRuntime.dispose();
	assert.equal(timedRuntime._disposeComplete, true);
	updateRegistry(layout.registryFile, (registry) => {
		const replacement = getAgent(registry, "worker/dispose-timeout-aba");
		assert.ok(replacement);
		replacement.state = "queued";
		replacement.vitals.tokens = 424_242;
	});
	releaseTurn();
	await sleep(150);
	const replacement = getAgent(readRegistry(layout.registryFile), "worker/dispose-timeout-aba");
	assert.equal(replacement?.state, "queued", "late old turn did not stamp replacement dormant");
	assert.equal(replacement?.vitals.tokens, 424_242, "late old turn did not overwrite replacement vitals");
	await assert.rejects(
		() => timedRuntime.retire("worker/dispose-timeout-aba"),
		/runtime is disposed/,
		"disposed runtime cannot begin a destructive retirement",
	);
	ok("timed-out turns cannot publish after dispose returns");

	const retireRuntime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	await retireRuntime.spawn({ type: "worker", id: "dispose-retire-race" });
	let releaseRetireWork;
	const retireGate = new Promise((resolve) => { releaseRetireWork = resolve; });
	const oldChain = retireGate.then(() => {});
	retireRuntime._chains.set("worker/dispose-retire-race", oldChain);
	void oldChain.then(() => {
		if (retireRuntime._chains.get("worker/dispose-retire-race") === oldChain) {
			retireRuntime._chains.delete("worker/dispose-retire-race");
		}
	});
	const retiring = retireRuntime.retire("worker/dispose-retire-race");
	const disposeDuringRetire = retireRuntime.dispose();
	await sleep(40);
	assert.equal(retireRuntime._disposeComplete, false, "shutdown waits for the destructive operation");
	releaseRetireWork();
	await retiring;
	await disposeDuringRetire;
	const replacementRuntime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	assert.equal((await replacementRuntime.spawn({ type: "worker", id: "dispose-retire-race" })).created, true);
	await replacementRuntime.dispose();
	ok("dispose drains an already-started retirement before scope reuse");

	// A retirement blocked forever on old work must not retain the host lease.
	// Once the one shutdown deadline expires, its continuation is fenced before
	// every destructive step and a replacement runtime may safely reuse state.
	const boundedRetireRuntime = new InProcessRuntime({
		layout,
		modelRegistry,
		settingsManager,
		maxConcurrent: 2,
		disposeTimeoutMs: 35,
	});
	await boundedRetireRuntime.spawn({ type: "worker", id: "bounded-retire" });
	let releaseHungRetire;
	const hungRetireWork = new Promise((resolve) => { releaseHungRetire = resolve; });
	boundedRetireRuntime._chains.set("worker/bounded-retire", hungRetireWork);
	const hungRetirement = boundedRetireRuntime.retire("worker/bounded-retire");
	const disposeStarted = Date.now();
	await boundedRetireRuntime.dispose();
	assert.ok(Date.now() - disposeStarted < 500, "dispose timeout bounds retirement waits");
	assert.ok(getAgent(readRegistry(layout.registryFile), "worker/bounded-retire"), "timed-out retirement did not publish removal");
	const afterTimedRetire = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	assert.equal((await afterTimedRetire.spawn({ type: "worker", id: "bounded-retire" })).created, false);
	releaseHungRetire();
	await assert.rejects(hungRetirement, /disposed before retirement/);
	await sleep(25);
	assert.ok(getAgent(readRegistry(layout.registryFile), "worker/bounded-retire"), "late retirement remained non-destructive");
	await afterTimedRetire.dispose();
	ok("dispose bounds hung retirement and fences its late continuation");
}

// ---------------------------------------------------------------------------
// (3) .sent-questions.json shrinks when answers are consumed
// ---------------------------------------------------------------------------
console.log("(3) sent-questions index shrinks:");
{
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	const events = [];
	runtime.onEvent((e) => events.push(e));
	await runtime.spawn({ type: "worker", id: "curious", task: "start" });
	await waitFor(() => events.some((e) => e.type === "turn-finished"), "spawn turn");

	// Simulate the agent having asked three questions (deliver.ts records into
	// the SENDER's index when a question envelope goes out).
	const box = layout.mailboxDir("worker", "curious");
	const questionIds = [];
	for (let i = 0; i < 3; i++) {
		const id = `msg_${ulid()}`;
		questionIds.push(id);
		mailbox.recordSentQuestion(box, id, `question number ${i}: what color is bikeshed ${i}?`);
	}
	const indexFile = join(box, ".sent-questions.json");
	assert.equal(Object.keys(JSON.parse(readFileSync(indexFile, "utf8"))).length, 3);

	// Answer two of them (main send with correlationId → `answer` envelope →
	// wake digest quotes the question → turn → markDone → index delete).
	for (const id of questionIds.slice(0, 2)) {
		const turnsBefore = events.filter((e) => e.type === "turn-finished").length;
		await runtime.send({ to: "worker/curious", text: `the answer to ${id}`, correlationId: id });
		await waitFor(
			() => events.filter((e) => e.type === "turn-finished").length > turnsBefore,
			"answer turn",
		);
	}
	await waitFor(() => mailbox.pendingCount(box) === 0, "mailbox drained");

	const index = JSON.parse(readFileSync(indexFile, "utf8"));
	assert.deepEqual(Object.keys(index), [questionIds[2]], "consumed questions deleted; unanswered one kept");
	ok("consuming a correlated answer deletes the question from .sent-questions.json (file shrinks)");

	// The digest still QUOTED the question before the delete (D14 kept intact):
	// the quoted text must be in the agent's session transcript.
	const instanceDir = layout.agentInstanceDir("worker", "curious");
	const sessionFiles = readdirSync(instanceDir).filter((n) => n.endsWith(".jsonl")).sort();
	const transcript = readFileSync(join(instanceDir, sessionFiles[sessionFiles.length - 1]), "utf8");
	assert.match(transcript, /what color is bikeshed 0\?/, "digest quoted the original question before it was deleted");
	ok("delete happens AFTER the wake digest quoted the question (D14 quoting intact)");

	// Bounded-size regression: a long ask/answer life keeps the index at the
	// number of OUTSTANDING questions, not the number ever asked.
	for (let i = 0; i < 5; i++) {
		const id = `msg_${ulid()}`;
		mailbox.recordSentQuestion(box, id, `burst question ${i}`);
		const turnsBefore = events.filter((e) => e.type === "turn-finished").length;
		await runtime.send({ to: "worker/curious", text: `burst answer ${i}`, correlationId: id });
		await waitFor(
			() => events.filter((e) => e.type === "turn-finished").length > turnsBefore,
			`burst answer turn ${i}`,
		);
	}
	const finalIndex = JSON.parse(readFileSync(indexFile, "utf8"));
	assert.equal(Object.keys(finalIndex).length, 1, "index holds only the still-unanswered question after 5 more ask/answer rounds");
	ok("index size tracks OUTSTANDING questions, not questions-ever-asked (no unbounded growth)");
	await runtime.dispose();
}

// ---------------------------------------------------------------------------
// (4) gcSweep: .corrupt/, .collect-requests.json, escalation records
// ---------------------------------------------------------------------------
console.log("(4) gcSweep coverage:");
{
	const now = new Date();
	const oldMs = now.getTime() - 30 * DAY_MS;
	const backdate = (file) => utimesSync(file, new Date(oldMs), new Date(oldMs));

	// Aged + fresh quarantined envelopes in the main AND an agent mailbox.
	const boxes = [layout.mainMailboxDir, layout.mailboxDir("worker", "curious")];
	const agedCorrupt = [];
	const freshCorrupt = [];
	for (const box of boxes) {
		const corruptDir = join(box, ".corrupt");
		mkdirSync(corruptDir, { recursive: true });
		const aged = join(corruptDir, `msg_${ulid(oldMs)}.json`);
		writeFileSync(aged, "{ not json", "utf8");
		backdate(aged);
		agedCorrupt.push(aged);
		const fresh = join(corruptDir, `msg_${ulid()}.json`);
		writeFileSync(fresh, "{ also not json", "utf8");
		freshCorrupt.push(fresh);
	}
	// A structural impostor can be quarantined as a directory; it follows the
	// same age policy and must not leak forever merely because it is not a file.
	const agedImpostor = join(layout.mainMailboxDir, ".corrupt", `msg_${ulid(oldMs)}.json`);
	mkdirSync(agedImpostor, { recursive: true });
	writeFileSync(join(agedImpostor, "nested"), "corrupt directory payload\n");
	backdate(agedImpostor);
	agedCorrupt.push(agedImpostor);

	// Aged + fresh collect-request entries (age = the key's ULID timestamp).
	// ulidAt encodes oldMs directly since monotonic ulid() won't backdate.
	const agedCollectId = `msg_${ulidAt(oldMs)}`;
	const freshCollectId = `msg_${ulid()}`;
	mailbox.recordCollectRequest(layout.mainMailboxDir, agedCollectId, { type: "object" });
	mailbox.recordCollectRequest(layout.mainMailboxDir, freshCollectId, { type: "string" });
	mailbox.recordAwaitAnchor(layout.mainMailboxDir, agedCollectId, "worker/curious", `gen_${"a".repeat(32)}`);
	mailbox.recordAwaitAnchor(layout.mainMailboxDir, freshCollectId, "worker/curious", `gen_${"b".repeat(32)}`);

	// Escalation records: an aged CANCELLED one (GC-eligible — the startup
	// reconcile in (5) is what produces these) and a fresh PENDING one.
	mkdirSync(layout.escalationsDir, { recursive: true });
	const cancelledRecord = {
		id: `esc_${ulid(oldMs)}`, agent: "worker/gone", tool: "bash", inputSummary: "x", reason: "r",
		status: "cancelled", envelopeId: null, note: null,
		createdAt: new Date(oldMs).toISOString(), resolvedAt: new Date(oldMs).toISOString(),
	};
	writeFileSync(layout.escalationFile(cancelledRecord.id), JSON.stringify(cancelledRecord), "utf8");
	const pendingRecord = {
		id: `esc_${ulid()}`, agent: "worker/curious", tool: "bash", inputSummary: "y", reason: "r",
		status: "pending", envelopeId: null, note: null,
		createdAt: now.toISOString(), resolvedAt: null,
	};
	writeFileSync(layout.escalationFile(pendingRecord.id), JSON.stringify(pendingRecord), "utf8");

	const result = archive.gcSweep(layout, { days: 7, now });
	for (const aged of agedCorrupt) assert.ok(!existsSync(aged), `aged quarantine file swept: ${aged}`);
	for (const fresh of freshCorrupt) assert.ok(existsSync(fresh), `fresh quarantine file kept: ${fresh}`);
	assert.equal(result.corruptFiles.length, agedCorrupt.length);
	const external = join(scratch, "external-not-mail");
	mkdirSync(external, { recursive: true });
	const externalAged = join(external, "must-survive.json");
	writeFileSync(externalAged, "outside quarantine\n");
	backdate(externalAged);
	const linkedRoot = join(scratch, "linked-corrupt-root");
	symlinkSync(external, linkedRoot);
	assert.deepEqual(archive.gcDoneDir(linkedRoot, { days: 7, now }), []);
	assert.deepEqual(archive.gcEscalationRecords(linkedRoot, { days: 7, now }), []);
	assert.ok(existsSync(externalAged), "mail/escalation GC refused to traverse a symlink root");
	const symlinkGcLayout = createLayout(join(scratch, "symlink-gc-project"), {
		home: join(scratch, "symlink-gc-home"),
		sessionId: "symlink-gc-session",
	});
	const externalArchives = join(scratch, "external-archives");
	const externalArchive = join(externalArchives, "worker", "outside");
	mkdirSync(externalArchive, { recursive: true });
	writeFileSync(join(externalArchive, ".retired-at"), `${new Date(oldMs).toISOString()}\n`);
	mkdirSync(dirname(symlinkGcLayout.archiveRoot), { recursive: true });
	symlinkSync(externalArchives, symlinkGcLayout.archiveRoot);
	assert.deepEqual(archive.gcArchive(symlinkGcLayout, { days: 7, now }), []);
	assert.ok(existsSync(externalArchive), "archive GC refused to traverse a symlink root");
	ok("GC ages every quarantine entry kind and refuses all symlink roots");

	const collectIndex = JSON.parse(readFileSync(join(layout.mainMailboxDir, ".collect-requests.json"), "utf8"));
	assert.ok(!(agedCollectId in collectIndex), "aged collect request pruned");
	assert.ok(freshCollectId in collectIndex, "fresh collect request kept (schema intact)");
	assert.deepEqual(collectIndex[freshCollectId], { type: "string" });
	assert.deepEqual(result.collectRequests, [agedCollectId]);
	assert.deepEqual(result.awaitAnchors, [agedCollectId]);
	assert.equal(mailbox.lookupAwaitAnchorGeneration(layout.mainMailboxDir, agedCollectId, "worker/curious"), undefined);
	assert.equal(
		mailbox.lookupAwaitAnchorGeneration(layout.mainMailboxDir, freshCollectId, "worker/curious"),
		`gen_${"b".repeat(32)}`,
	);
	ok("unfulfilled collect + durable await-anchor indexes age out by envelope timestamp");

	assert.ok(!existsSync(layout.escalationFile(cancelledRecord.id)), "aged cancelled escalation record swept");
	assert.ok(existsSync(layout.escalationFile(pendingRecord.id)), "pending escalation record NEVER swept");
	ok("cancelled escalation records age out; pending ones stay (live waits untouched)");
	rmSync(layout.escalationFile(pendingRecord.id), { force: true }); // clean for (5)
}

// ---------------------------------------------------------------------------
// (5) startup reconcile cancels ORPHANED pending escalation records
// ---------------------------------------------------------------------------
console.log("(5) startup reconcile vs orphaned escalations:");
{
	// Simulate a crash while `waiting`: registry says waiting, a pending
	// escalation record is on disk, and no process holds the in-memory wait.
	updateRegistry(layout.registryFile, (reg) => {
		getAgent(reg, "worker/curious").state = "waiting";
	});
	const orphaned = {
		id: `esc_${ulid()}`, agent: "worker/curious", tool: "bash", inputSummary: "rm -rf /", reason: "outside scope",
		// Crash window: notifyMain wrote the envelope, but its returned id never
		// made it back into the second record write.
		status: "pending", envelopeId: null, note: null,
		createdAt: new Date().toISOString(), resolvedAt: null,
	};
	const orphanedMail = makeEnvelope({
		from: "worker/curious",
		to: "main",
		type: "escalation",
		text: `orphaned approval request\n- escalation id: ${orphaned.id}`,
		data: { escalationId: orphaned.id },
	});
	const resolving = {
		id: `esc_${ulid()}`, agent: "worker/curious", tool: "edit", inputSummary: "late.txt", reason: "outside scope",
		// Human decided, then the process died while slot/lifecycle restoration
		// was still in flight. The audit decision remains, but its prompt is stale.
		status: "approved", envelopeId: null, note: null,
		createdAt: new Date().toISOString(), resolvedAt: new Date().toISOString(),
	};
	const resolvingMail = makeEnvelope({
		from: "worker/curious",
		to: "main",
		type: "escalation",
		// No structured id: exercises recovery for envelopes from older builds.
		text: `resolution-in-flight approval\n- escalation id: ${resolving.id}`,
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, orphanedMail);
	mailbox.writeEnvelope(layout.mainMailboxDir, resolvingMail);
	const hostSession = join(layout.projectSessionDir, "orphaned-host.jsonl");
	mkdirSync(layout.projectSessionDir, { recursive: true });
	writeFileSync(hostSession, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	mailbox.claimPendingForHost(
		layout.mainMailboxDir,
		({ envelope }) => envelope.id === orphanedMail.id || envelope.id === resolvingMail.id,
		hostSession,
		"subagent-mail",
	);
	assert.ok(existsSync(join(layout.mainMailboxDeliveringDir, `${orphanedMail.id}.json`)), "orphaned prompt parked");
	assert.ok(existsSync(join(layout.mainMailboxDeliveringDir, `${resolvingMail.id}.json`)), "resolving prompt parked");
	writeFileSync(layout.escalationFile(orphaned.id), JSON.stringify(orphaned), "utf8");
	writeFileSync(layout.escalationFile(resolving.id), JSON.stringify(resolving), "utf8");
	// Control: a pending record owned by a live foreign runtime must stay pending.
	const keeperOwner = join(layout.agentInstanceDir("worker", "keeper"), ".run-owner.json");
	writeFileSync(keeperOwner, `${JSON.stringify({ pid: process.pid, runtimeId: "live-foreign-runtime" })}\n`);
	const untouched = {
		id: `esc_${ulid()}`, agent: "worker/keeper", tool: "edit", inputSummary: "z", reason: "r",
		status: "pending", envelopeId: null, note: null,
		createdAt: new Date().toISOString(), resolvedAt: null,
	};
	const untouchedMail = makeEnvelope({
		from: "worker/keeper",
		to: "main",
		type: "escalation",
		text: `live foreign approval\n- escalation id: ${untouched.id}`,
		data: { escalationId: untouched.id },
	});
	writeFileSync(layout.escalationFile(untouched.id), JSON.stringify(untouched), "utf8");
	mailbox.writeEnvelope(layout.mainMailboxDir, untouchedMail);

	// First restart pass hits a transient cancellation-write failure. It must
	// leave the still-pending prompt actionable and install an in-process retry.
	chmodSync(layout.escalationsDir, 0o555);
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	assert.ok(runtime._startupRecoveryTimer, "failed escalation persistence scheduled startup retry");
	await assert.rejects(
		() => runtime.send({ to: "worker/curious", text: "must not race fresh-start retry" }),
		/startup recovery is still retrying/,
	);
	assert.equal(JSON.parse(readFileSync(layout.escalationFile(orphaned.id), "utf8")).status, "pending");
	assert.ok(existsSync(join(layout.mainMailboxDeliveringDir, `${orphanedMail.id}.json`)), "prompt kept while cancellation was not durable");
	chmodSync(layout.escalationsDir, 0o755);
	for (let i = 0; i < 100; i++) {
		if (JSON.parse(readFileSync(layout.escalationFile(orphaned.id), "utf8")).status === "cancelled") break;
		await sleep(20);
	}
	assert.equal(getAgent(readRegistry(layout.registryFile), "worker/curious")?.state, "dormant", "stranded waiting reset");

	const orphanedAfter = JSON.parse(readFileSync(layout.escalationFile(orphaned.id), "utf8"));
	assert.equal(orphanedAfter.status, "cancelled", "orphaned pending record cancelled at startup");
	assert.ok(orphanedAfter.resolvedAt, "…with a resolvedAt stamp (GC clock)");
	assert.ok(!existsSync(join(layout.mainMailboxDeliveringDir, `${orphanedMail.id}.json`)), "stale parked prompt removed");
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, `${orphanedMail.id}.json`)), "stale prompt retained as done audit");
	const resolvingAfter = JSON.parse(readFileSync(layout.escalationFile(resolving.id), "utf8"));
	assert.equal(resolvingAfter.status, "approved", "durable human decision remains in the audit record");
	assert.ok(!existsSync(join(layout.mainMailboxDeliveringDir, `${resolvingMail.id}.json`)), "resolution-in-flight prompt removed");
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, `${resolvingMail.id}.json`)), "resolved prompt retained as done audit");
	const untouchedAfter = JSON.parse(readFileSync(layout.escalationFile(untouched.id), "utf8"));
	assert.equal(untouchedAfter.status, "pending", "record for a live foreign owner left intact");
	ok("reconcile cancels orphaned records but preserves a live foreign owner's wait");

	// If that owner subsequently dies/releases its marker, the targeted poll
	// must cancel the now-orphaned escalation even when no agent mailbox mail
	// exists, and settle its only actionable main prompt.
	rmSync(keeperOwner, { force: true });
	for (let i = 0; i < 100; i++) {
		if (JSON.parse(readFileSync(layout.escalationFile(untouched.id), "utf8")).status === "cancelled") break;
		await sleep(20);
	}
	assert.equal(JSON.parse(readFileSync(layout.escalationFile(untouched.id), "utf8")).status, "cancelled");
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, `${untouchedMail.id}.json`)), "released-owner prompt settled to audit");
	ok("foreign-owner death triggers targeted orphan-escalation recovery");

	// Cancelled records are now GC-eligible: an aged sweep removes both.
	const future = new Date(Date.now() + 30 * DAY_MS);
	const swept = archive.gcSweep(layout, { days: 7, now: future });
	assert.ok(swept.escalations.includes(layout.escalationFile(orphaned.id)), "cancelled record aged out by gcSweep");
	assert.ok(swept.escalations.includes(layout.escalationFile(untouched.id)), "released-owner record aged out too");
	assert.ok(!existsSync(layout.escalationFile(orphaned.id)));
	assert.ok(!existsSync(layout.escalationFile(untouched.id)));
	ok("the once-orphaned records now age out of .main/escalations/ (no longer GC-immune)");
	await runtime.dispose();
}

console.log(`\nall ${passed} lifecycle-fixes regression tests passed`);
process.exit(0);
