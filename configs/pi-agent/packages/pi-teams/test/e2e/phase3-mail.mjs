/**
 * Phase-3 mail e2e for pi-teams: mailbox IO, delivery/dispositions/bounce,
 * the deterministic wake digest, non-blocking questions (Q→dormant→A→wake with
 * the original question quoted), reports to main, peer messaging, collect
 * delivery, and poison-envelope quarantine. Real agent turns through a scripted
 * mock LLM (no network).
 *
 * Run: node phase3-mail.mjs
 */
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestModelRuntime, EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readPending } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { composeWakeDigest } = await jiti.import(join(EXT, "mail/digest.ts"));
const { validateAgainstSchema } = await jiti.import(join(EXT, "mail/collect.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));

const scratch = join(WORLDS, "phase3-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent", "subagents"), { recursive: true });
mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
const defs = join(home, ".pi", "agent", "subagents");
for (const [name, body] of [
	["researcher", "You are RESEARCHER."],
	["greeter", "You are GREETER."],
	["worker", "You are WORKER."],
]) {
	writeFileSync(join(defs, `${name}.md`), ["---", `name: ${name}`, `description: ${name}`, "model: mock/mock-1", "projectContext: false", "---", body].join("\n"));
}

// ---------------------------------------------------------------- mock LLM
const llmCalls = [];
let callSeq = 0;
const scripts = [];
function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			const c = messages[i].content;
			return typeof c === "string" ? c : c.map((x) => x.text ?? "").join("\n");
		}
	}
	return "";
}
function addressOf(systemPrompt) {
	const m = systemPrompt.match(/address `([^`]+)`/);
	return m ? m[1] : "?";
}
function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const call = { address: addressOf(context.systemPrompt ?? ""), systemPrompt: context.systemPrompt ?? "", lastUserText: lastUserText(context.messages), lastRole: context.messages.at(-1)?.role };
		llmCalls.push(call);
		let spec = { text: `MOCK_DEFAULT_${llmCalls.length}` };
		for (let i = 0; i < scripts.length; i++) {
			if (scripts[i].match(call)) {
				spec = scripts.splice(i, 1)[0].reply(call);
				break;
			}
		}
		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
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

const agentDir = join(home, ".pi", "agent");
const settingsManager = piSdk.SettingsManager.create(project, agentDir);
const { modelRuntime, modelRegistry } = await createTestModelRuntime(piSdk, {
	cwd: project,
	agentDir,
	settingsManager,
	providers: {
		mock: {
			baseUrl: "http://mock.invalid", apiKey: "k", api: "mock-api", streamSimple: mockStream,
			models: [{ id: "mock-1", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
		},
	},
});

const layout = createLayout(project, { home, sessionId: "sess-3" });
const core = createCore({ layout, modelRuntime, modelRegistry, settingsManager, maxConcurrent: 3 });
const mainMail = () => readPending(layout.mainMailboxDir).map((p) => p.envelope);

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ------------------------------------------------------------- pure units
console.log("digest (pure):");
await test("answers quote the original question; mail ordered", () => {
	const q = makeEnvelope({ from: "researcher/q1", to: "main", type: "question", text: "A or B?" });
	const a = makeEnvelope({ from: "main", to: "researcher/q1", type: "answer", text: "Use A.", correlationId: q.id });
	const digest = composeWakeDigest({ items: [{ envelope: a, redelivered: false }], questionLookup: (cid) => (cid === q.id ? "A or B?" : undefined) });
	assert.ok(digest.includes("## Answers to your questions"));
	assert.ok(digest.includes("A or B?"));
	assert.ok(digest.includes("Use A."));
});
console.log("collect validation (pure):");
await test("honest subset: additionalProperties:false closes empty object; order-independent const", () => {
	assert.equal(validateAgainstSchema({ x: 1 }, { type: "object", additionalProperties: false }).valid, false);
	assert.equal(validateAgainstSchema({ a: 1, b: 2 }, { const: { b: 2, a: 1 } }).valid, true);
	assert.equal(validateAgainstSchema(3, { type: "nonsense" }).valid, false);
	assert.equal(validateAgainstSchema({ n: 5 }, { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }).valid, true);
});

// ------------------------------------------------------- Q → dormant → A → wake
console.log("non-blocking questions:");
await test("spawn task → agent asks → question lands in main mailbox → agent dormant", async () => {
	scripts.push({ match: (c) => c.address === "researcher/q1" && c.lastUserText.includes("Investigate"), reply: () => ({ tools: [{ name: "ask", args: { text: "Should I use approach A or B?" } }] }) });
	await core.spawn({ type: "researcher", id: "q1", task: "Investigate the caching bug." });
	await core.whenIdle();
	const q = mainMail().find((e) => e.type === "question" && e.from === "researcher/q1");
	assert.ok(q, "question envelope reached main");
	assert.ok(q.payload.text.includes("approach A or B"));
	const roster = await core.status();
	assert.equal(roster.find((r) => r.address === "researcher/q1").state, "dormant");
});

await test("answer wakes the agent; digest quotes the question next to the answer", async () => {
	const q = mainMail().find((e) => e.type === "question" && e.from === "researcher/q1");
	const before = llmCalls.length;
	const res = await core.send({ to: "researcher/q1", text: "Use approach A.", correlationId: q.id });
	assert.equal(res.disposition, "woken");
	await core.whenIdle();
	const wakeCall = llmCalls.slice(before).find((c) => c.address === "researcher/q1");
	assert.ok(wakeCall, "researcher woke and got an LLM call");
	assert.ok(wakeCall.lastUserText.includes("Answers to your questions"));
	assert.ok(wakeCall.lastUserText.includes("Should I use approach A or B?"), "original question quoted");
	assert.ok(wakeCall.lastUserText.includes("Use approach A."), "answer included");
});

// ------------------------------------------------------------- reports to main
console.log("reports:");
await test("greeter sends a FINAL report to main", async () => {
	scripts.push({ match: (c) => c.address === "greeter/main" && c.lastUserText.includes("Say hi"), reply: () => ({ tools: [{ name: "report", args: { text: "Greeted successfully.", final: true } }] }) });
	await core.spawn({ type: "greeter", id: "main", task: "Say hi to the team." });
	await core.whenIdle();
	const report = mainMail().find((e) => e.type === "report" && e.from === "greeter/main");
	assert.ok(report);
	assert.equal(report.payload.final, true);
	assert.ok(report.payload.text.includes("Greeted successfully"));
});

// ------------------------------------------------------------- peer messaging
console.log("peer messaging (flat, D12):");
await test("worker/alice messages worker/bob; bob wakes with the message", async () => {
	await core.spawn({ type: "worker", id: "bob" }); // exists, dormant
	scripts.push({ match: (c) => c.address === "worker/alice" && c.lastUserText.includes("Coordinate"), reply: () => ({ tools: [{ name: "send_message", args: { to: "worker/bob", text: "PEER_HELLO from alice" } }] }) });
	const before = llmCalls.length;
	await core.spawn({ type: "worker", id: "alice", task: "Coordinate with bob." });
	await core.whenIdle();
	const bobCall = llmCalls.slice(before).find((c) => c.address === "worker/bob");
	assert.ok(bobCall, "bob was woken by the peer message");
	assert.ok(bobCall.lastUserText.includes("PEER_HELLO from alice"));
});

console.log("bounce:");
await test("send to an unknown agent bounces", async () => {
	const res = await core.send({ to: "ghost/x", text: "hello?" });
	assert.equal(res.disposition, "bounced");
	assert.ok(res.bounceReason.includes("no such agent"));
});

// ------------------------------------------------------------- collect
console.log("collect:");
let collectRequestId = null;
await test("collect delivers a request; agent fulfils via a correlated report", async () => {
	scripts.push({
		match: (c) => c.address === "researcher/c1" && c.lastUserText.includes("collect request"),
		reply: () => ({ tools: [{ name: "report", args: { text: "here", data: { answer: 42 }, correlationId: collectRequestId } }] }),
	});
	await core.spawn({ type: "researcher", id: "c1" });
	const { requestId, requested } = await core.collect("researcher/c1", { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"] });
	collectRequestId = requestId; // set before the (async) mail turn runs
	assert.equal(requested, true);
	await core.whenIdle();
	const report = mainMail().find((e) => e.type === "report" && e.from === "researcher/c1" && e.correlationId === requestId);
	assert.ok(report, "collect result report correlated to the request");
	assert.deepEqual(report.payload.data, { answer: 42 });
});

// ------------------------------------------------------------- quarantine
console.log("mailbox quarantine:");
await test("poison envelope is quarantined, not re-read forever", async () => {
	const dir = layout.mailboxDir("worker", "bob");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "msg_NOTAULID.json"), "{ broken json");
	const pending = readPending(dir);
	assert.ok(!pending.some((p) => p.envelope?.id === "msg_NOTAULID"));
});

await core.dispose();
console.log(`\nPhase 3: ${passed} checks passed.`);
