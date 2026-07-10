/**
 * Phase-3 mail smoke test for pi-subagents-v2.
 *
 * Extends the phase-2 harness (jiti-alias + mock provider on
 * ModelRegistry.inMemory) with a SCRIPTED mock LLM that can also emit tool
 * calls — so REAL AgentSession turns exercise the subagent tool trio
 * (send_message / report / ask) and the whole mail pipeline:
 *
 *  (unit) digest.ts pure: ordering, correlation quoting, redelivery label,
 *         roster lines; mailbox at-least-once mechanics; collect validator.
 *  (a) A asks B via peer send → A dormant → B wakes with digest containing
 *      the question → B answers (correlationId) → A wakes with digest quoting
 *      its original question + the answer.
 *  (b) mail arriving mid-turn is held to the turn boundary, never interrupts.
 *  (d) at-least-once: envelope moves to .done only after the session append.
 *  (c) oneshot final report → auto-retired (archived, teams scrubbed), report
 *      envelope still readable in main's mailbox.
 *  (e) subagent_collect round-trip with schema validation (valid + violating).
 *  (f) bounce on retired address (error envelope back to the sender).
 *  (ext) index.ts wiring: D16 selective auto-wake via a stubbed ExtensionAPI —
 *        question triggers sendMessage(triggerTurn), report queues quietly,
 *        before_agent_start injects the digest, main answer wakes the asker.
 *
 * Run: node smoke-phase3.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";



const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readRegistry } = await jiti.import(join(EXT, "store/registry.ts"));
const { readTeams } = await jiti.import(join(EXT, "store/teams.ts"));
const { InProcessRuntime, readOutstandingQuestions } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { composeWakeDigest } = await jiti.import(join(EXT, "mail/digest.ts"));
const { validateAgainstSchema, collectResultNote } = await jiti.import(join(EXT, "mail/collect.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const extensionFactory = (await jiti.import(join(EXT, "index.ts"))).default ??
	(await jiti.import(join(EXT, "index.ts")));

// ---------------------------------------------------------------------------
// Temp world
// ---------------------------------------------------------------------------
const scratch = join(WORLDS, "phase3-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(join(project, ".pi", "subagents"), { recursive: true });

writeFileSync(
	join(project, ".pi", "subagents", "worker.md"),
	[
		"---",
		"name: worker",
		"description: General worker for mail tests",
		"model: mock/mock-1",
		"projectContext: false",
		"---",
		"You are a worker.",
		"",
	].join("\n"),
);

// ---------------------------------------------------------------------------
// Scripted mock LLM provider (text replies AND tool calls)
// ---------------------------------------------------------------------------
const llmCalls = []; // { agent, systemPrompt, messages, lastUserText }
let callSeq = 0;
const scripts = []; // FIFO: { match(call) => bool, reply(call) => {text} | {tools:[{name,args}]} | {gate,text} }

function agentOf(systemPrompt) {
	const m = /address `([^`]+)`/.exec(systemPrompt ?? "");
	return m ? m[1] : "?";
}
function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") {
			return typeof m.content === "string"
				? m.content
				: m.content.map((c) => c.text ?? "").join("\n");
		}
	}
	return "";
}

function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const call = {
			agent: agentOf(context.systemPrompt),
			systemPrompt: context.systemPrompt ?? "",
			messages: context.messages,
			lastUserText: lastUserText(context.messages),
			lastRole: context.messages[context.messages.length - 1]?.role,
		};
		llmCalls.push(call);
		let spec = { text: `MOCK_DEFAULT_${llmCalls.length}` };
		for (let i = 0; i < scripts.length; i++) {
			if (scripts[i].match(call)) {
				spec = scripts.splice(i, 1)[0].reply(call);
				break;
			}
		}
		if (spec.gate) await spec.gate;
		const usage = {
			input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		};
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		if (spec.tools) {
			const content = spec.tools.map((t) => ({ type: "toolCall", id: `call_${++callSeq}`, name: t.name, arguments: t.args }));
			const output = { ...base, content, stopReason: "toolUse" };
			stream.push({ type: "start", partial: output });
			content.forEach((tc, i) => {
				stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: output });
			});
			stream.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const output = { ...base, content: [{ type: "text", text: spec.text }], stopReason: "stop" };
			stream.push({ type: "start", partial: output });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: spec.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: spec.text, partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
		}
		stream.end();
	})();
	return stream;
}

const authStorage = piSdk.AuthStorage.create(join(home, ".pi", "agent", "auth.json"));
const modelRegistry = piSdk.ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider("mock", {
	baseUrl: "http://mock.invalid",
	apiKey: "test-key",
	api: "mock-api",
	streamSimple: mockStream,
	models: [
		{
			id: "mock-1", name: "Mock One", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000, maxTokens: 4096,
		},
	],
});

// ---------------------------------------------------------------------------
// Runtime under test
// ---------------------------------------------------------------------------
const layout = createLayout(project, { home });
const settingsManager = piSdk.SettingsManager.create(project, join(home, ".pi", "agent"));
const mainMail = [];
const runtime = new InProcessRuntime({
	layout, modelRegistry, settingsManager, maxConcurrent: 2,
	onMainMail: (envelope) => mainMail.push(envelope),
});

const events = [];
runtime.onEvent((e) => events.push({ ...e, at: Date.now() }));
function waitFor(predicate, label, timeoutMs = 20000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = () => {
			const hit = events.find(predicate);
			if (hit) return resolve(hit);
			if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
			setTimeout(check, 15);
		};
		check();
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// Pure unit tests: digest
// ---------------------------------------------------------------------------
console.log("digest (pure):");
function env(over) {
	return makeEnvelope({
		from: "worker/beta", to: "worker/alpha", type: "message", text: "hello",
		...over,
	});
}
await test("orders answers first (with quoted questions), then mail by id", async () => {
	const q = "What error format does the API use?";
	const answer = env({ type: "answer", text: "RFC7807 problem+json.", correlationId: "msg_00000000000000000000000000" });
	const early = env({ from: "main", text: "EARLY_NOTE" });
	const late = env({ from: "main", text: "LATE_NOTE" });
	// feed items out of order; ids are monotonic so early < late by creation
	const digest = composeWakeDigest({
		items: [
			{ envelope: late, redelivered: false },
			{ envelope: answer, redelivered: false },
			{ envelope: early, redelivered: false },
		],
		questionLookup: (cid) => (cid === "msg_00000000000000000000000000" ? q : undefined),
	});
	assert.match(digest, /Wake digest — 3 messages/);
	const iAnswers = digest.indexOf("## Answers to your questions");
	const iMail = digest.indexOf("## Mail");
	assert.ok(iAnswers >= 0 && iMail > iAnswers, "answers section first");
	assert.ok(digest.indexOf("You asked") < digest.indexOf("RFC7807"), "question quoted before answer");
	assert.match(digest, /> What error format does the API use\?/);
	assert.ok(digest.indexOf(answer.id) > 0, "answer envelope id shown");
	// non-answer mail ordered by ulid regardless of input order
	assert.ok(digest.indexOf("EARLY_NOTE") < digest.indexOf("LATE_NOTE"), "mail in id order");
	assert.doesNotMatch(digest, /re-delivered/);
});
await test("questions carry answer-with-correlationId instructions", async () => {
	const q = env({ type: "question", text: "Which port?" });
	const digest = composeWakeDigest({ items: [{ envelope: q, redelivered: false }], questionLookup: () => undefined });
	assert.match(digest, new RegExp(`correlationId "${q.id}"`));
	assert.match(digest, /question from `worker\/beta`/);
});
await test("redelivered mail is labeled; notes and roster lines render", async () => {
	const m = env({ text: "again" });
	const digest = composeWakeDigest({
		items: [{ envelope: m, redelivered: true, note: "[collect result — conforms to the requested schema]" }],
		questionLookup: () => undefined,
		rosterChanges: ["worker/gamma joined team duo"],
	});
	assert.match(digest, /re-delivered: an earlier delivery attempt did not complete/);
	assert.match(digest, /\[collect result — conforms/);
	assert.match(digest, /## Roster changes\n\n- worker\/gamma joined team duo/);
});
await test("report data renders as a fenced JSON block (with verdict note as caption)", async () => {
	const r = env({ from: "worker/alpha", type: "report", text: "collect result ready", data: { answer: 42, label: "DISTINCTIVE_VALUE" } });
	const digest = composeWakeDigest({
		items: [{ envelope: r, redelivered: false, note: "[collect result — conforms to the requested schema]" }],
		questionLookup: () => undefined,
	});
	assert.match(digest, /   Data:/, "labeled data block");
	assert.match(digest, /```json/, "fenced json block");
	assert.match(digest, /"answer": 42/, "actual JSON data rendered");
	assert.match(digest, /DISTINCTIVE_VALUE/, "distinctive value from the returned data appears");
	assert.match(digest, /\[collect result — conforms/, "verdict note still shown as caption");
});
await test("collect REQUEST still renders the recipe, not a data block", async () => {
	const req = env({ from: "main", type: "message", text: "Collect request", data: { collectSchema: { type: "object" } } });
	const digest = composeWakeDigest({ items: [{ envelope: req, redelivered: false }], questionLookup: () => undefined });
	assert.match(digest, /To fulfill this collect request/, "recipe rendered for the request direction");
	assert.doesNotMatch(digest, /   Data:/, "request schema is not rendered as a result data block");
});
await test("oversized report data is truncated with an explicit marker", async () => {
	const big = "x".repeat(6000);
	const r = env({ from: "worker/alpha", type: "report", text: "big", data: { blob: big } });
	const digest = composeWakeDigest({ items: [{ envelope: r, redelivered: false }], questionLookup: () => undefined });
	assert.match(digest, /truncated at 4000 chars — the full value is in the report envelope/, "truncation marker present");
	assert.ok(digest.length < 6000 + 500, "digest bounded well under the raw payload size");
});
await test("non-serializable report data does not throw and yields a placeholder", async () => {
	const circular = {};
	circular.self = circular;
	const r = env({ from: "worker/alpha", type: "report", text: "bad", data: circular });
	let digest;
	assert.doesNotThrow(() => { digest = composeWakeDigest({ items: [{ envelope: r, redelivered: false }], questionLookup: () => undefined }); });
	assert.match(digest, /\(unserializable data\)/, "placeholder rendered for circular data");
});
await test("absent report data renders no extra data block", async () => {
	const r = env({ from: "worker/alpha", type: "report", text: "no data here" });
	const digest = composeWakeDigest({ items: [{ envelope: r, redelivered: false }], questionLookup: () => undefined });
	assert.doesNotMatch(digest, /   Data:/, "no empty data block when payload.data is absent");
});
await test("digest is deterministic (same inputs → same string)", async () => {
	const m = env({ text: "x" });
	const opts = { items: [{ envelope: m, redelivered: false }], questionLookup: () => undefined };
	assert.equal(composeWakeDigest(opts), composeWakeDigest(opts));
});

// ---------------------------------------------------------------------------
// Pure-ish unit tests: mailbox at-least-once mechanics + collect validator
// ---------------------------------------------------------------------------
console.log("mailbox + collect (unit):");
await test("mailbox: write→readPending(ulid order)→beginDelivery(redelivery flag)→markDone", async () => {
	const dir = join(scratch, "unit-mailbox");
	const e1 = env({ text: "first" });
	const e2 = env({ text: "second" });
	mailbox.writeEnvelope(dir, e2);
	mailbox.writeEnvelope(dir, e1);
	let pending = mailbox.readPending(dir);
	assert.deepEqual(pending.map((p) => p.envelope.id), [e1.id, e2.id].sort());
	assert.deepEqual(pending.map((p) => p.redelivered), [false, false]);
	assert.equal(mailbox.pendingCount(dir), 2);
	mailbox.beginDelivery(dir, [e1.id]);
	pending = mailbox.readPending(dir);
	assert.equal(pending.find((p) => p.envelope.id === e1.id).redelivered, true, "attempt marker → redelivered");
	assert.equal(pending.find((p) => p.envelope.id === e2.id).redelivered, false);
	mailbox.markDone(dir, [e1.id, e2.id]);
	assert.equal(mailbox.pendingCount(dir), 0);
	assert.ok(existsSync(join(dir, ".done", `${e1.id}.json`)), "done envelope kept for audit");
	assert.ok(!existsSync(join(dir, `${e1.id}.json.attempt`)), "marker removed");
});
await test("sent-question + collect-request indexes", async () => {
	const dir = join(scratch, "unit-mailbox");
	mailbox.recordSentQuestion(dir, "msg_A", "what?");
	assert.equal(mailbox.lookupSentQuestion(dir, "msg_A"), "what?");
	assert.equal(mailbox.lookupSentQuestion(dir, "msg_B"), undefined);
	mailbox.recordCollectRequest(dir, "msg_C", { type: "object" });
	assert.deepEqual(mailbox.takeCollectRequest(dir, "msg_C"), { type: "object" });
	assert.equal(mailbox.takeCollectRequest(dir, "msg_C"), undefined, "take pops");
});
await test("outstanding sent-questions: answered/bounced ones pruned, unanswered kept", async () => {
	const dir = join(scratch, "unit-outstanding");
	mailbox.recordSentQuestion(dir, "msg_Q1", "first?");
	mailbox.recordSentQuestion(dir, "msg_Q2", "second?");
	mailbox.recordSentQuestion(dir, "msg_Q3", "third?");
	// An answer for Q1 sits pending in the asker's mailbox; an error bounce for
	// Q2 was already processed (.done). Only Q3 stays outstanding.
	const a = env({ type: "answer", text: "yes", correlationId: "msg_Q1" });
	mailbox.writeEnvelope(dir, a);
	const b = env({ type: "error", text: "bounced", correlationId: "msg_Q2" });
	mailbox.writeEnvelope(dir, b);
	mailbox.markDone(dir, [b.id]);
	assert.deepEqual(readOutstandingQuestions(dir), [{ id: "msg_Q3", text: "third?" }]);
});
await test("collect validator: subset checks + note text", async () => {
	const schema = {
		type: "object",
		required: ["answer", "tags"],
		additionalProperties: false,
		properties: {
			answer: { type: "integer" },
			tags: { type: "array", items: { type: "string" } },
			mode: { enum: ["a", "b"] },
		},
	};
	assert.deepEqual(validateAgainstSchema({ answer: 42, tags: ["x"], mode: "a" }, schema), { valid: true, errors: [] });
	const bad = validateAgainstSchema({ answer: "nope", tags: ["x", 5], extra: 1 }, schema);
	assert.equal(bad.valid, false);
	assert.ok(bad.errors.some((e) => e.includes("$.answer")), "type violation flagged");
	assert.ok(bad.errors.some((e) => e.includes("$.tags[1]")), "items violation flagged");
	assert.ok(bad.errors.some((e) => e.includes('unexpected property "extra"')));
	assert.match(collectResultNote(bad), /SCHEMA VIOLATIONS/);
	assert.match(collectResultNote({ valid: true, errors: [] }), /conforms/);
});

// ---------------------------------------------------------------------------
// (a) peer question → dormant → answer wakes with quoted question
// ---------------------------------------------------------------------------
console.log("(a) peer Q&A round trip:");
const QUESTION = "What is the config value? QUESTION_MARKER";
let askedCorrelationId = null;

scripts.push({
	// A's first wake: task digest → ask B a question via peer send
	match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("TASK_ASK_BETA"),
	reply: () => ({ tools: [{ name: "send_message", args: { to: "worker/beta", text: QUESTION, expectReply: true } }] }),
});
scripts.push({
	// A's same turn after the tool result: leave a checkpoint, end turn
	match: (c) => c.agent === "worker/alpha" && c.lastRole === "toolResult",
	reply: () => ({ text: "CHECKPOINT: paused waiting for beta; next: apply the value." }),
});
scripts.push({
	// B wakes with the question digest → answer with the correlationId from the digest
	match: (c) => c.agent === "worker/beta" && c.lastUserText.includes("QUESTION_MARKER"),
	reply: (c) => {
		askedCorrelationId = /correlationId "(msg_[0-9A-Z]{26})"/.exec(c.lastUserText)?.[1] ?? null;
		return { tools: [{ name: "send_message", args: { to: "worker/alpha", text: "The value is 42. ANSWER_MARKER", correlationId: askedCorrelationId } }] };
	},
});
scripts.push({
	match: (c) => c.agent === "worker/beta" && c.lastRole === "toolResult",
	reply: () => ({ text: "answered." }),
});
scripts.push({
	// A's second wake: the answer digest
	match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("ANSWER_MARKER"),
	reply: () => ({ text: "GOT_ANSWER_ACK" }),
});

await test("A asks B; A goes dormant; B wakes with question digest", async () => {
	await runtime.spawn({ type: "worker", id: "beta", team: "duo" });
	await runtime.spawn({ type: "worker", id: "alpha", team: "duo", task: "TASK_ASK_BETA: find the config value from worker/beta" });
	// A's asking turn finishes (dormant with question outstanding — non-blocking D14)
	await waitFor((e) => e.type === "turn-finished" && e.address === "worker/alpha", "alpha turn 1");
	const recA = readRegistry(layout.registryFile).agents["worker/alpha"];
	assert.ok(["dormant", "queued", "running"].includes(recA.state)); // dormant, or already re-woken by the answer
	// B's wake digest contained the question with answer instructions
	await waitFor((e) => e.type === "turn-finished" && e.address === "worker/beta", "beta turn");
	const bCall = llmCalls.find((c) => c.agent === "worker/beta" && c.lastUserText.includes("QUESTION_MARKER"));
	assert.ok(bCall, "beta woke with the question in its digest");
	assert.match(bCall.lastUserText, /Wake digest/);
	assert.match(bCall.lastUserText, /question from `worker\/alpha`/);
	assert.ok(askedCorrelationId, "digest exposed the correlationId");
});
await test("answer wakes A with its original question quoted next to the answer (D14)", async () => {
	await waitFor(
		(e, i) => e.type === "turn-finished" && e.address === "worker/alpha" &&
			events.filter((x) => x.type === "turn-finished" && x.address === "worker/alpha").length >= 2,
		"alpha turn 2",
	);
	const wake2 = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastUserText.includes("ANSWER_MARKER"));
	assert.ok(wake2, "alpha woke with the answer");
	assert.match(wake2.lastUserText, /## Answers to your questions/);
	assert.match(wake2.lastUserText, /You asked \(msg_[0-9A-Z]{26}\):/);
	assert.match(wake2.lastUserText, /> What is the config value\? QUESTION_MARKER/);
	assert.match(wake2.lastUserText, /`worker\/beta` answered/);
	assert.match(wake2.lastUserText, /> The value is 42\. ANSWER_MARKER/);
	// the question envelope was marked done in B's mailbox after B's turn
	const bBox = layout.mailboxDir("worker", "beta");
	assert.equal(mailbox.pendingCount(bBox), 0);
	assert.ok(readdirSync(join(bBox, ".done")).length >= 1, "processed mail in .done");
	// M4 read joins: the answered question no longer counts as outstanding,
	// and roster rows expose the mailbox unread count.
	const detail = await runtime.peek("worker/alpha");
	assert.deepEqual(detail.outstandingQuestions, [], "answered question pruned from outstanding");
	assert.equal(typeof detail.unread, "number");
	const roster = await runtime.status();
	const alphaRow = roster.find((r) => r.address === "worker/alpha");
	assert.equal(alphaRow.unread, mailbox.pendingCount(layout.mailboxDir("worker", "alpha")), "roster unread = mailbox pending");
});

// ---------------------------------------------------------------------------
// (b) + (d) mid-turn hold + at-least-once ordering
// ---------------------------------------------------------------------------
console.log("(b)+(d) mid-turn hold + at-least-once:");
await test("mail arriving mid-turn is held to the boundary; .done only after append", async () => {
	let releaseGate;
	const gate = new Promise((r) => (releaseGate = r));
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("SLOW_MARKER"),
		reply: () => ({ gate, text: "slow work done" }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("MIDTURN_MARKER"),
		reply: () => ({ text: "midturn mail processed" }),
	});

	events.length = 0;
	const slowSend = await runtime.send({ to: "worker/alpha", text: "SLOW_MARKER: do slow work" });
	assert.equal(slowSend.delivery, "delivered");
	await waitFor((e) => e.type === "turn-started" && e.address === "worker/alpha", "slow turn start");
	const aBox = layout.mailboxDir("worker", "alpha");

	// (d) while the turn is in-flight: envelope consumed by it is still in the
	// mailbox with an attempt marker — NOT yet in .done (append hasn't happened).
	const slowFile = join(aBox, `${slowSend.envelopeId}.json`);
	assert.ok(existsSync(slowFile), "envelope still pending during its turn");
	assert.ok(existsSync(`${slowFile}.attempt`), "attempt marker stamped before the turn");
	assert.ok(!existsSync(join(aBox, ".done", `${slowSend.envelopeId}.json`)), "not done during the turn");

	// (b) mid-turn mail: held, no steer, no new turn until the boundary
	const held = await runtime.send({ to: "worker/alpha", text: "MIDTURN_MARKER: also do this" });
	assert.equal(held.delivery, "queued");
	assert.equal(held.recipientState, "running");
	await sleep(150);
	assert.ok(!llmCalls.some((c) => c.lastUserText.includes("MIDTURN_MARKER")), "held mail never reached the LLM mid-turn");
	assert.equal(events.filter((e) => e.type === "turn-started" && e.address === "worker/alpha").length, 1);

	releaseGate();
	await waitFor((e) => e.type === "turn-finished" && e.address === "worker/alpha", "slow turn end");
	// at-least-once: done only after the turn (durable append) completed
	assert.ok(existsSync(join(aBox, ".done", `${slowSend.envelopeId}.json`)), "envelope done after append");
	assert.ok(!existsSync(slowFile));

	// boundary drain delivers the held mail as its own digest turn
	await waitFor(
		(e) => e.type === "turn-finished" && e.address === "worker/alpha" &&
			events.filter((x) => x.type === "turn-finished" && x.address === "worker/alpha").length >= 2,
		"boundary drain turn",
	);
	const drainCall = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastUserText.includes("MIDTURN_MARKER"));
	assert.ok(drainCall, "held mail delivered at the boundary");
	assert.match(drainCall.lastUserText, /Wake digest/);
	assert.ok(existsSync(join(aBox, ".done", `${held.envelopeId}.json`)), "held envelope done after its own turn");
});

// ---------------------------------------------------------------------------
// (e) subagent_collect round trip with schema validation
// ---------------------------------------------------------------------------
console.log("(e) collect round trip:");
await test("collect request → report(correlationId, data) → validated digest note in main mail", async () => {
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("Collect request"),
		reply: (c) => {
			const id = /message from `main` \((msg_[0-9A-Z]{26})\)/.exec(c.lastUserText)?.[1];
			return { tools: [{ name: "report", args: { text: "collect result ready", data: { answer: 42 }, correlationId: id } }] };
		},
	});
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastRole === "toolResult",
		reply: () => ({ text: "reported." }),
	});
	mainMail.length = 0;
	const res = await runtime.collect("worker/alpha", {
		type: "object", required: ["answer"], properties: { answer: { type: "integer" } },
	});
	assert.equal(res.requested, true);
	assert.match(res.requestId, /^msg_/);
	assert.ok(["dormant", "queued", "running", "waiting"].includes(res.recipientState), "recipientState surfaced");
	// wait for the report to land in main's mailbox
	const start = Date.now();
	while (!mainMail.some((e) => e.type === "report" && e.correlationId === res.requestId)) {
		if (Date.now() - start > 20000) throw new Error("timeout waiting for collect report");
		await sleep(15);
	}
	// the agent's digest spelled out the fulfillment recipe (collectSchema helper)
	const collectCall = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastUserText.includes("Collect request"));
	assert.ok(collectCall, "agent saw the collect request");
	assert.match(collectCall.lastUserText, /To fulfill this collect request/);
	assert.ok(collectCall.lastUserText.includes(`correlationId "${res.requestId}"`), "helper line names the request envelope id");
	const report = mainMail.find((e) => e.type === "report" && e.correlationId === res.requestId);
	assert.deepEqual(report.payload.data, { answer: 42 });
	// drain main mail the way the host extension does → validation note attached
	const pending = mailbox.readPending(layout.mainMailboxDir);
	assert.ok(pending.some((p) => p.envelope.id === report.id), "report pending in .main/mailbox");
	// validate via collect index like core.drainMainMail does
	const schema = mailbox.takeCollectRequest(layout.mainMailboxDir, res.requestId);
	assert.deepEqual(schema, { type: "object", required: ["answer"], properties: { answer: { type: "integer" } } });
	const verdict = validateAgainstSchema(report.payload.data, schema);
	assert.equal(verdict.valid, true);
});

// ---------------------------------------------------------------------------
// (c) oneshot auto-retire on final report
// ---------------------------------------------------------------------------
console.log("(c) oneshot auto-retire:");
await test("oneshot final report → archived + teams scrubbed; report survives in main mail", async () => {
	scripts.push({
		match: (c) => c.agent.startsWith("worker/tmp-") && c.lastUserText.includes("ONESHOT_TASK"),
		reply: () => ({ tools: [{ name: "report", args: { text: "FINAL_ONESHOT_RESULT", final: true } }] }),
	});
	scripts.push({
		match: (c) => c.agent.startsWith("worker/tmp-") && c.lastRole === "toolResult",
		reply: () => ({ text: "done, signing off." }),
	});
	mainMail.length = 0;
	events.length = 0;
	const res = await runtime.spawn({ type: "worker", lifetime: "oneshot", team: "duo", task: "ONESHOT_TASK: do one thing" });
	assert.match(res.address, /^worker\/tmp-/);
	const retired = await waitFor((e) => e.type === "agent-retired" && e.address === res.address, "auto-retire");
	// registry gone, address bounces, dir archived, teams scrubbed
	assert.equal(readRegistry(layout.registryFile).agents[res.address], undefined);
	assert.ok(retired.archiveDir.includes("/.archive/worker/tmp-"));
	assert.ok(existsSync(retired.archiveDir));
	const [, id] = res.address.split("/");
	assert.ok(!existsSync(layout.agentInstanceDir("worker", id)));
	assert.ok(!(readTeams(layout.teamsFile).duo ?? []).includes(res.address), "scrubbed from teams");
	// the final report envelope survives the agent, readable in main's mailbox
	const report = mainMail.find((e) => e.type === "report" && e.from === res.address);
	assert.ok(report, "final report delivered to main");
	assert.equal(report.payload.text, "FINAL_ONESHOT_RESULT");
	const pending = mailbox.readPending(layout.mainMailboxDir);
	assert.ok(pending.some((p) => p.envelope.id === report.id), "report file readable after the funeral");
});

// ---------------------------------------------------------------------------
// (f) bounce on retired address
// ---------------------------------------------------------------------------
console.log("(f) bounce:");
await test("peer send to a retired address bounces an error envelope back to the sender", async () => {
	await runtime.retire("worker/beta");
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("PING_BETA"),
		reply: () => ({ tools: [{ name: "send_message", args: { to: "worker/beta", text: "are you there? BOUNCE_PROBE" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastRole === "toolResult",
		reply: (c) => ({ text: `SAW_TOOL_ERROR: ${JSON.stringify(c.messages[c.messages.length - 1].content)}` }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("Delivery failure"),
		reply: () => ({ text: "BOUNCE_DIGEST_ACK" }),
	});
	events.length = 0;
	await runtime.send({ to: "worker/alpha", text: "PING_BETA: check on beta" });
	await waitFor((e) => e.type === "turn-finished" && e.address === "worker/alpha", "ping turn");
	// the send tool itself reported the bounce to the LLM
	const toolErr = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastRole === "toolResult" &&
		JSON.stringify(c.messages[c.messages.length - 1].content).includes("Not delivered"));
	assert.ok(toolErr, "tool result carried the bounce reason");
	// and the bounce error envelope arrived as mail (boundary drain digest turn)
	await waitFor(
		(e) => e.type === "turn-finished" && e.address === "worker/alpha" &&
			events.filter((x) => x.type === "turn-finished" && x.address === "worker/alpha").length >= 2,
		"bounce digest turn",
	);
	const bounceCall = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastUserText.includes("Delivery failure"));
	assert.ok(bounceCall, "bounce envelope woke the sender");
	assert.match(bounceCall.lastUserText, /error from `worker\/beta`/);
	assert.match(bounceCall.lastUserText, /BOUNCE_PROBE/);
	assert.match(bounceCall.lastUserText, /retired or never spawned/);
});

// ---------------------------------------------------------------------------
// (ext) index.ts wiring — D16 selective auto-wake through a stubbed pi
// ---------------------------------------------------------------------------
console.log("(ext) host wiring (D16):");
await test("question auto-wakes idle main; report queues quietly; digest injected at turn start; answer wakes asker", async () => {
	// Fresh world for the extension test; index.ts derives home from os.homedir().
	const project2 = join(scratch, "project2");
	mkdirSync(join(project2, ".pi", "subagents"), { recursive: true });
	writeFileSync(join(project2, ".pi", "subagents", "worker.md"), readFileSync(join(project, ".pi", "subagents", "worker.md")));
	// D21 token cap for the charging bracket below: the first auto-woken main
	// turn charges 990k (must NOT pause — margin 10k dwarfs the ~15-token mock
	// subagent turns the runtime also meters into the shared pool), the second
	// charges 50k more (MUST pause).
	writeFileSync(join(project2, ".pi", "subagents.json"), `${JSON.stringify({ autonomousTokens: 1_000_000 })}\n`);
	const prevHome = process.env.HOME;
	process.env.HOME = home;

	const handlers = {};
	const registeredTools = new Map();
	const sentMessages = [];
	// Faithful-enough host stub: it models AgentSession's streaming flag and
	// records the delivery MODE the real SDK would pick for each sendMessage
	// (agent-session.js sendCustomMessage): "nextTurn" queues for the next
	// prompt; while isStreaming it STEERS (or followUp) into the running turn;
	// only isStreaming=false + triggerTurn starts a genuinely new turn.
	const stubPi = {
		isStreaming: false,
		on: (event, handler) => (handlers[event] ??= []).push(handler),
		registerTool: (tool) => registeredTools.set(tool.name, tool),
		sendMessage: (message, options) => {
			const mode =
				options?.deliverAs === "nextTurn" ? "nextTurn"
				: stubPi.isStreaming ? (options?.deliverAs === "followUp" ? "followUp" : "steer")
				: options?.triggerTurn ? "newTurn"
				: "append";
			sentMessages.push({ message, options, mode });
		},
		// Phase 6 registers TUI surfaces at load; the smoke drives none of them.
		registerCommand: () => {},
		registerShortcut: () => {},
	};
	extensionFactory(stubPi);
	// Emulate ONE host agent run with the REAL SDK's event ordering: agent_end
	// is emitted while isStreaming is still true (_isAgentRunActive is cleared
	// only in _emitAgentSettled, AFTER agent_end); agent_settled fires once the
	// run has fully settled and isStreaming is false.
	const fireHostTurn = async (ctx, messages = []) => {
		stubPi.isStreaming = true;
		for (const h of handlers.agent_start ?? []) await h({ type: "agent_start" }, ctx);
		for (const h of handlers.agent_end ?? []) await h({ type: "agent_end", messages }, ctx);
		stubPi.isStreaming = false;
		for (const h of handlers.agent_settled ?? []) await h({ type: "agent_settled" }, ctx);
	};
	assert.deepEqual(
		[...registeredTools.keys()].sort(),
		["subagent_collect", "subagent_interrupt", "subagent_retire", "subagent_send", "subagent_spawn", "subagent_status", "subagent_steer"],
		"the full seven-tool surface is registered",
	);

	const ctx = { cwd: project2, modelRegistry, model: modelRegistry.find("mock", "mock-1") };
	const layout2 = createLayout(project2, { home });

	// Subagent asks main a question via the ask tool.
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastUserText.includes("EXT_TASK"),
		reply: () => ({ tools: [{ name: "ask", args: { text: "Main, which branch? EXT_QUESTION" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastRole === "toolResult",
		reply: () => ({ text: "checkpoint: waiting for main." }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastUserText.includes("EXT_ANSWER"),
		reply: () => ({ text: "EXT_DONE_ACK" }),
	});

	const spawnTool = registeredTools.get("subagent_spawn");
	await spawnTool.execute("t1", { type: "worker", task: "EXT_TASK: work on the thing" }, undefined, undefined, ctx);
	// wait for the question to hit main's mailbox → auto-wake trigger
	const start = Date.now();
	while (sentMessages.length === 0) {
		if (Date.now() - start > 20000) throw new Error("timeout waiting for auto-wake");
		await sleep(15);
	}
	assert.equal(sentMessages[0].options.triggerTurn, true, "question auto-woke idle main (D16)");
	assert.equal(sentMessages[0].mode, "newTurn", "idle wake starts a real turn (isStreaming=false + triggerTurn)");
	assert.match(sentMessages[0].message.customType, /subagent-mail/);

	// Phase-6 carried-forward fix: the digest is EMBEDDED in the wake trigger
	// message (auto-woken sendMessage/triggerTurn turns never fire
	// before_agent_start, so a digest deferred to that hook stranded until the
	// next real user turn while agent_end kept re-triggering — a rail-bounded
	// self-wake loop). The mailbox is therefore drained AT TRIGGER TIME.
	const wakeContent = sentMessages[0].message.content;
	assert.match(wakeContent, /Wake digest/);
	assert.match(wakeContent, /question from `worker\/main`/);
	assert.match(wakeContent, /EXT_QUESTION/);
	const corr = /correlationId "(msg_[0-9A-Z]{26})"/.exec(wakeContent)?.[1];
	assert.ok(corr, "digest tells main how to answer");
	assert.equal(mailbox.pendingCount(layout2.mainMailboxDir), 0, "main mail drained at trigger time");
	// A real user turn starting now finds nothing left to inject.
	assert.equal(await handlers.before_agent_start[0]({}, ctx), undefined, "no double-injection");

	// M4: before the answer exists, the unanswered question is recoverable via
	// subagent_status detail (outstandingQuestions) — even if main's own
	// context lost the digest.
	const statusTool = registeredTools.get("subagent_status");
	const detailRes = await statusTool.execute("tq", { address: "worker/main" }, undefined, undefined, ctx);
	const detailJson = JSON.parse(detailRes.content[0].text);
	assert.ok(
		detailJson.outstandingQuestions.some((q) => q.id === corr && q.text.includes("EXT_QUESTION")),
		"unanswered question listed in peek detail",
	);

	// main answers via subagent_send(correlationId) → asker wakes with the quote
	const sendTool = registeredTools.get("subagent_send");
	const answerRes = await sendTool.execute("t2", { to: "worker/main", text: "Use branch main-2. EXT_ANSWER", correlationId: corr }, undefined, undefined, ctx);
	const answerJson = JSON.parse(answerRes.content[0].text);
	assert.deepEqual(Object.keys(answerJson).sort(), ["delivery", "disposition", "recipientState"], "spec-exact send result");
	assert.ok(["woken", "held", "queued"].includes(answerJson.disposition), "Deliverer disposition surfaced");
	{
		const s2 = Date.now();
		while (!llmCalls.some((c) => c.agent === "worker/main" && c.lastUserText.includes("EXT_ANSWER"))) {
			if (Date.now() - s2 > 20000) throw new Error("timeout waiting for asker wake");
			await sleep(15);
		}
	}
	const wake = llmCalls.find((c) => c.agent === "worker/main" && c.lastUserText.includes("EXT_ANSWER"));
	assert.match(wake.lastUserText, /You asked/);
	assert.match(wake.lastUserText, /EXT_QUESTION/);

	// plain report queues quietly: no new auto-wake trigger
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastUserText.includes("EXT_REPORT_TASK"),
		reply: () => ({ tools: [{ name: "report", args: { text: "progress: 50% EXT_PROGRESS" } }] }),
	});
	const before = sentMessages.length;
	await sendTool.execute("t3", { to: "worker/main", text: "EXT_REPORT_TASK: send a progress report" }, undefined, undefined, ctx);
	{
		const s3 = Date.now();
		while (mailbox.pendingCount(layout2.mainMailboxDir) === 0) {
			if (Date.now() - s3 > 20000) throw new Error("timeout waiting for report");
			await sleep(15);
		}
	}
	await sleep(100);
	assert.equal(sentMessages.length, before, "report did NOT auto-wake (quiet queue)");
	assert.ok(mailbox.pendingCount(layout2.mainMailboxDir) >= 1, "unread count exposed for the widget");
	// A full host run at the next boundary: reports alone still don't wake —
	// neither at agent_end nor at agent_settled.
	await fireHostTurn(ctx);
	assert.equal(sentMessages.length, before, "turn boundary: reports stay quiet");

	// --- M1 pin: the boundary wake fires at agent_settled, NOT agent_end ----
	// The real SDK still counts the session as streaming during agent_end, so a
	// sendMessage(triggerTurn) there would STEER into the ending turn. Simulate
	// a host turn with wake-worthy mail arriving mid-turn and assert the wake
	// is issued only once isStreaming has dropped (mode "newTurn").
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastUserText.includes("EXT_TASK2"),
		reply: () => ({ tools: [{ name: "ask", args: { text: "Main, held until the boundary? MIDTURN_Q_MARKER" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastRole === "toolResult",
		reply: () => ({ text: "checkpoint: waiting on main (2)." }),
	});
	const beforeMidturn = sentMessages.length;
	stubPi.isStreaming = true; // a main turn is running…
	for (const h of handlers.agent_start ?? []) await h({ type: "agent_start" }, ctx);
	await sendTool.execute("t4", { to: "worker/main", text: "EXT_TASK2: ask main something mid-turn" }, undefined, undefined, ctx);
	{
		const s4 = Date.now();
		while (!mailbox.readPending(layout2.mainMailboxDir).some((p) => p.envelope.type === "question")) {
			if (Date.now() - s4 > 20000) throw new Error("timeout waiting for mid-turn question");
			await sleep(15);
		}
	}
	await sleep(100);
	assert.equal(sentMessages.length, beforeMidturn, "mid-turn wake-worthy mail never interrupts (D11)");
	// agent_end arrives while isStreaming is STILL true (real SDK ordering) —
	// the wake must NOT fire here (it would be recorded as a "steer").
	for (const h of handlers.agent_end ?? []) await h({ type: "agent_end", messages: [] }, ctx);
	assert.equal(sentMessages.length, beforeMidturn, "no wake at agent_end (still streaming — would steer)");
	stubPi.isStreaming = false;
	for (const h of handlers.agent_settled ?? []) await h({ type: "agent_settled" }, ctx);
	assert.equal(sentMessages.length, beforeMidturn + 1, "boundary wake fired at agent_settled");
	const boundaryWake = sentMessages[sentMessages.length - 1];
	assert.equal(boundaryWake.mode, "newTurn", "settled-time wake starts a REAL new turn, not a steer");
	assert.equal(boundaryWake.options.triggerTurn, true);
	assert.match(boundaryWake.message.content, /MIDTURN_Q_MARKER/, "digest embedded in the wake trigger");
	assert.equal(mailbox.pendingCount(layout2.mainMailboxDir), 0, "boundary wake drained main mail");

	// --- M2: D21 token charging of auto-woken main turns, with REAL usage ----
	// The wake above marked the now-running main turn auto-woken. Finish it with
	// a realistic agent_end payload (pi-ai AssistantMessage.usage: input/output/
	// cacheRead/cacheWrite) and bracket the pool cap (1,000,000 from the
	// settings file above):
	//   turn 1 charges 600k + 390k = 990k  → must NOT pause (wake 2 still fires)
	//   turn 2 charges  50k        → 1040k → MUST pause (wake 3 blocked)
	// Decoy usage on non-assistant messages pins the role check; dropping any
	// of the four usage fields (or charging 0) lands under the cap and fails
	// the "paused" leg; counting decoys pauses early and fails the "not paused"
	// leg.
	const mkUsage = (input, output, cacheRead, cacheWrite) => ({
		input, output, cacheRead, cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	});
	const assistantMsg = (usage) => ({
		role: "assistant", api: "mock-api", provider: "mock", model: "mock-1",
		content: [{ type: "text", text: "worked on the digest" }],
		usage, stopReason: "stop", timestamp: Date.now(),
	});
	await fireHostTurn(ctx, [
		{ role: "user", content: [{ type: "text", text: "decoy" }], usage: mkUsage(7_777_777, 0, 0, 0), timestamp: Date.now() },
		assistantMsg(mkUsage(400_000, 90_000, 80_000, 30_000)), // 600k
		{ role: "toolResult", toolCallId: "t0", content: [{ type: "text", text: "decoy" }], usage: mkUsage(5_555_555, 0, 0, 0), timestamp: Date.now() },
		assistantMsg(mkUsage(200_000, 100_000, 60_000, 30_000)), // 390k
	]);
	// 990k charged < 1M cap → NOT paused: the next question still auto-wakes.
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastUserText.includes("EXT_TASK3"),
		reply: () => ({ tools: [{ name: "ask", args: { text: "Main, still under budget? UNDER_CAP_Q_MARKER" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastRole === "toolResult",
		reply: () => ({ text: "checkpoint: waiting on main (3)." }),
	});
	const beforeUnderCap = sentMessages.length;
	await sendTool.execute("t5", { to: "worker/main", text: "EXT_TASK3: ask main again" }, undefined, undefined, ctx);
	{
		const s5 = Date.now();
		while (sentMessages.length === beforeUnderCap) {
			if (Date.now() - s5 > 20000) throw new Error("timeout waiting for under-cap wake (was the pool over-charged?)");
			await sleep(15);
		}
	}
	assert.match(sentMessages[sentMessages.length - 1].message.content, /UNDER_CAP_Q_MARKER/);
	assert.equal(sentMessages[sentMessages.length - 1].mode, "newTurn");

	// That wake's turn now runs; a THIRD question arrives mid-turn, then the
	// turn's agent_end charges 50k more → the pool trips at/over the cap and
	// the settled-time boundary re-check must SKIP the wake (paused, D21).
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastUserText.includes("EXT_TASK4"),
		reply: () => ({ tools: [{ name: "ask", args: { text: "Main, over budget now? OVER_CAP_Q_MARKER" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/main" && c.lastRole === "toolResult",
		reply: () => ({ text: "checkpoint: waiting on main (4)." }),
	});
	stubPi.isStreaming = true;
	for (const h of handlers.agent_start ?? []) await h({ type: "agent_start" }, ctx);
	await sendTool.execute("t6", { to: "worker/main", text: "EXT_TASK4: one more ask" }, undefined, undefined, ctx);
	{
		const s6 = Date.now();
		while (!mailbox.readPending(layout2.mainMailboxDir).some((p) => p.envelope.type === "question")) {
			if (Date.now() - s6 > 20000) throw new Error("timeout waiting for the over-cap question");
			await sleep(15);
		}
	}
	const beforePaused = sentMessages.length;
	for (const h of handlers.agent_end ?? []) await h({ type: "agent_end", messages: [assistantMsg(mkUsage(30_000, 5_000, 10_000, 5_000))] }, ctx); // +50k → ≥ cap
	stubPi.isStreaming = false;
	for (const h of handlers.agent_settled ?? []) await h({ type: "agent_settled" }, ctx);
	await sleep(100);
	assert.equal(sentMessages.length, beforePaused, "paused pool: wake-worthy mail queues, no auto-wake (D21)");
	assert.ok(
		mailbox.readPending(layout2.mainMailboxDir).some((p) => p.envelope.type === "question"),
		"question parked on disk while paused",
	);
	// The next REAL user turn resets the pool and drains the held question.
	const injected = await handlers.before_agent_start[0]({}, ctx);
	assert.match(injected.message.content, /OVER_CAP_Q_MARKER/, "user-turn digest drained the paused-held question");

	// D17: user → subagent FYI. Reach the runtime through a fresh core-level path:
	// sendAsUser is a runtime power; exercised in the runtime section below.

	for (const h of handlers.session_shutdown ?? []) await h({}, ctx);
	process.env.HOME = prevHome;
});

// ---------------------------------------------------------------------------
// (D17) user→subagent FYI
// ---------------------------------------------------------------------------
console.log("(D17) sendAsUser:");
await test("user message to a subagent drops a quiet FYI report to main", async () => {
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("USER_DIRECT"),
		reply: () => ({ text: "hi user." }),
	});
	mainMail.length = 0;
	events.length = 0;
	const res = await runtime.sendAsUser({ to: "worker/alpha", text: "USER_DIRECT: status please" });
	assert.equal(res.delivery, "delivered");
	const fyi = mainMail.find((e) => e.type === "report" && e.from === "user");
	assert.ok(fyi, "FYI report envelope to main");
	assert.match(fyi.payload.text, /user messaged `worker\/alpha` directly/);
	assert.match(fyi.payload.text, /USER_DIRECT/);
	await waitFor((e) => e.type === "turn-finished" && e.address === "worker/alpha", "user-direct turn", 20000);
	const call = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastUserText.includes("USER_DIRECT"));
	assert.ok(call, "subagent received the user's message");
	assert.match(call.lastUserText, /message from `user`/);
});

await runtime.dispose();
console.log(`\nall ${passed} phase-3 smoke tests passed`);
