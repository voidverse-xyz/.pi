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
const { InProcessRuntime } = await jiti.import(join(EXT, "runtime/in-process.ts"));
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
	// wait for the report to land in main's mailbox
	const start = Date.now();
	while (!mainMail.some((e) => e.type === "report" && e.correlationId === res.requestId)) {
		if (Date.now() - start > 20000) throw new Error("timeout waiting for collect report");
		await sleep(15);
	}
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
	const prevHome = process.env.HOME;
	process.env.HOME = home;

	const handlers = {};
	const registeredTools = new Map();
	const sentMessages = [];
	const stubPi = {
		on: (event, handler) => (handlers[event] ??= []).push(handler),
		registerTool: (tool) => registeredTools.set(tool.name, tool),
		sendMessage: (message, options) => sentMessages.push({ message, options }),
		// Phase 6 registers TUI surfaces at load; the smoke drives none of them.
		registerCommand: () => {},
		registerShortcut: () => {},
	};
	extensionFactory(stubPi);
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

	// main answers via subagent_send(correlationId) → asker wakes with the quote
	const sendTool = registeredTools.get("subagent_send");
	const answerRes = await sendTool.execute("t2", { to: "worker/main", text: "Use branch main-2. EXT_ANSWER", correlationId: corr }, undefined, undefined, ctx);
	const answerJson = JSON.parse(answerRes.content[0].text);
	assert.deepEqual(Object.keys(answerJson).sort(), ["delivery", "recipientState"], "spec-exact send result");
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
	// agent_end at the next boundary: reports alone still don't wake
	await handlers.agent_end[0]({}, ctx);
	assert.equal(sentMessages.length, before, "agent_end boundary: reports stay quiet");

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
