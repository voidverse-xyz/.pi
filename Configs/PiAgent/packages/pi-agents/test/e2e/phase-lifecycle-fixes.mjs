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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

	// Aged + fresh collect-request entries (age = the key's ULID timestamp).
	// ulidAt encodes oldMs directly since monotonic ulid() won't backdate.
	const agedCollectId = `msg_${ulidAt(oldMs)}`;
	const freshCollectId = `msg_${ulid()}`;
	mailbox.recordCollectRequest(layout.mainMailboxDir, agedCollectId, { type: "object" });
	mailbox.recordCollectRequest(layout.mainMailboxDir, freshCollectId, { type: "string" });

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
	ok("mailbox/.corrupt/ ages out under the same N-day policy as .done/ (main + agent boxes)");

	const collectIndex = JSON.parse(readFileSync(join(layout.mainMailboxDir, ".collect-requests.json"), "utf8"));
	assert.ok(!(agedCollectId in collectIndex), "aged collect request pruned");
	assert.ok(freshCollectId in collectIndex, "fresh collect request kept (schema intact)");
	assert.deepEqual(collectIndex[freshCollectId], { type: "string" });
	assert.deepEqual(result.collectRequests, [agedCollectId]);
	ok("unfulfilled .collect-requests.json entries age out (key's ULID timestamp = request time)");

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
		status: "pending", envelopeId: null, note: null,
		createdAt: new Date().toISOString(), resolvedAt: null,
	};
	writeFileSync(layout.escalationFile(orphaned.id), JSON.stringify(orphaned), "utf8");
	// Control: a pending record for an agent the reconcile does NOT reset
	// (worker/keeper is dormant) must stay pending.
	const untouched = {
		id: `esc_${ulid()}`, agent: "worker/keeper", tool: "edit", inputSummary: "z", reason: "r",
		status: "pending", envelopeId: null, note: null,
		createdAt: new Date().toISOString(), resolvedAt: null,
	};
	writeFileSync(layout.escalationFile(untouched.id), JSON.stringify(untouched), "utf8");

	// "Restart": constructing the runtime runs the reconciliation.
	const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });
	assert.equal(getAgent(readRegistry(layout.registryFile), "worker/curious")?.state, "dormant", "stranded waiting reset");

	const orphanedAfter = JSON.parse(readFileSync(layout.escalationFile(orphaned.id), "utf8"));
	assert.equal(orphanedAfter.status, "cancelled", "orphaned pending record cancelled at startup");
	assert.ok(orphanedAfter.resolvedAt, "…with a resolvedAt stamp (GC clock)");
	const untouchedAfter = JSON.parse(readFileSync(layout.escalationFile(untouched.id), "utf8"));
	assert.equal(untouchedAfter.status, "pending", "record for a non-reset agent left intact");
	ok("reconcile cancels pending records ONLY for agents whose stranded state it reset");

	// The cancelled record is now GC-eligible: an aged sweep removes it.
	const future = new Date(Date.now() + 30 * DAY_MS);
	const swept = archive.gcSweep(layout, { days: 7, now: future });
	assert.ok(swept.escalations.includes(layout.escalationFile(orphaned.id)), "cancelled record aged out by gcSweep");
	assert.ok(!existsSync(layout.escalationFile(orphaned.id)));
	assert.ok(existsSync(layout.escalationFile(untouched.id)), "pending record still immune to GC");
	ok("the once-orphaned record now ages out of .main/escalations/ (no longer GC-immune)");

	rmSync(layout.escalationFile(untouched.id), { force: true });
	await runtime.dispose();
}

console.log(`\nall ${passed} lifecycle-fixes regression tests passed`);
process.exit(0);
