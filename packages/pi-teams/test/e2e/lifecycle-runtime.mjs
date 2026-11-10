import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { dependencyRoot } from "../../../../tests/runtime.mjs";
import { createTestModelRuntime, EXT, PI_PKG, jiti } from "./env.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
const sdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const ai = await jiti.import(join(dependencyRoot("@earendil-works/pi-ai", PI_PKG), "dist", "index.js"));
const { createSubagentTools } = await jiti.import(join(EXT, "tools/sub-agent.ts"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));
const { InProcessRuntime } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { writeEnvelope, readPending } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { readPersistedMailIds } = await jiti.import(join(EXT, "mail/transcript-ack.ts"));
const extension = await jiti.import(join(EXT, "index.ts"));
const teams = EXT.endsWith("teams");
const customType = teams ? "teams-mail" : "subagents-mail";
const handlers = new Map();
(extension.default ?? extension)({ registerTool() {}, registerCommand() {}, registerShortcut() {}, on: (name, fn) => handlers.set(name, fn) });
for (const name of ["input", "before_agent_start", "agent_start", "context", "agent_settled", "session_shutdown", "session_start"]) {
	assert.ok(handlers.has(name), `production lifecycle wiring: ${name}`);
}
const scratch = mkdtempSync(join(tmpdir(), "pi-lifecycle-"));
const cwd = join(scratch, "project"), agentDir = join(scratch, "agent");
mkdirSync(cwd); mkdirSync(agentDir);
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
let calls = 0, sequence = 0;
const scripts = [];
function streamSimple(model) {
	const stream = ai.createAssistantMessageEventStream();
	calls++;
	const spec = scripts.shift() ?? {};
	const content = spec.tools?.map(({ name, args }) => ({ type: "toolCall", id: `call_${++sequence}`, name, arguments: args })) ?? [{ type: "text", text: "done" }];
	const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: spec.error ? "error" : spec.tools ? "toolUse" : "stop", timestamp: Date.now() };
	stream.push({ type: "start", partial: output });
	for (const [contentIndex, toolCall] of content.entries()) if (toolCall.type === "toolCall") {
		stream.push({ type: "toolcall_start", contentIndex, partial: output });
		stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
	}
	stream.push(spec.error ? { type: "error", reason: "error", error: output } : { type: "done", reason: output.stopReason, message: output });
	stream.end(); return stream;
}
const { modelRuntime, modelRegistry } = await createTestModelRuntime(sdk, { cwd, agentDir, settingsManager, providers: { mock: {
	baseUrl: "http://mock.invalid", apiKey: "test", api: "mock-api", streamSimple,
	models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
} } });
const model = sdk.resolveCliModel({ cliModel: "mock/test", modelRuntime }).model;

// All tool outcomes, including dropped mail (not only bounced mail), use Pi's real error contract.
let delivered = true, disposition = "main";
const send = () => ({ delivered, disposition, envelopeId: "msg_test", bounceReason: "fixture failure" });
const tools = createSubagentTools("worker/main", { reportFromAgent: send, sendFromAgent: send });
const cases = [
	["report", { text: "progress" }, false], ["report", { text: "explicit progress", final: false }, false],
	["report", { text: "final", final: true }, true],
	...(teams ? [["ask", { text: "question" }, true], ["send_message", { to: "worker/peer", text: "question", expectReply: true }, true],
		["send_message", { to: "worker/peer", text: "ordinary" }, false], ["send_message", { to: "worker/peer", text: "answer", correlationId: "msg_question" }, false]] : []),
];
for (const [name, args, terminate] of cases) {
	const tool = tools.find((t) => t.name === name);
	delivered = true;
	const result = await tool.execute("call", args);
	assert.equal(result.terminate === true, terminate);
	assert.equal(result.content[0].text, JSON.stringify(JSON.parse(result.content[0].text)), "compact JSON");
	for (disposition of ["bounced", "dropped"]) { delivered = false; await assert.rejects(tool.execute("call", args), /not delivered/); }
}
delivered = true; disposition = "main";

// Final-report correlation and delivery outcomes stay intact without retiring the sender.
const runtime = Object.create(InProcessRuntime.prototype);
const handle = { trigger: null, assignment: "msg_task" };
runtime.handles = new Map([["worker/main", handle]]);
let sent;
runtime.deliverer = { send: (envelope) => { sent = envelope; return send(); } };
const report = () => runtime.sendFromAgent("worker/main", { to: "main", type: "report", text: "final", final: true });
for (disposition of ["bounced", "dropped"]) {
	delivered = false;
	assert.equal(report().delivered, false);
	assert.equal(sent.correlationId, "msg_task");
}
runtime.deliverer.send = () => { throw Error("disk failure"); };
assert.throws(report, /disk failure/);
runtime.deliverer.send = (envelope) => { sent = envelope; return send(); };
delivered = true;
assert.equal(report().delivered, true);
assert.equal(sent.correlationId, "msg_task");
assert.deepEqual(handle, { trigger: null, assignment: "msg_task" });

const quiet = { name: "ordinary", label: "ordinary", description: "ordinary", parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }) };
const failure = { ...quiet, name: "failure", execute: async () => { throw Error("failure"); } };
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true });
await loader.reload();
const { session: worker } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager,
	resourceLoader: loader, sessionManager: sdk.SessionManager.create(cwd, agentDir), noTools: "builtin", customTools: [...tools, quiet, failure] });
for (const [name, args, terminating] of cases) {
	const before = calls;
	scripts.push({ tools: [{ name, args }] });
	await worker.prompt("exercise lifecycle");
	assert.equal(calls - before, terminating ? 1 : 2, `${name}: actual provider continuation`);
}
for (const batch of [
	[{ name: "report", args: { text: "final", final: true } }, { name: "ordinary", args: {} }],
	[{ name: "report", args: { text: "one", final: true } }, { name: "report", args: { text: "two", final: true } }],
	[{ name: "report", args: { text: "final", final: true } }, { name: "failure", args: {} }],
]) {
	const before = calls; scripts.push({ tools: batch }); await worker.prompt("parallel batch");
	assert.equal(calls - before, batch[1].name === "report" ? 1 : 2, "Pi all-results termination semantics");
}
delivered = false; disposition = "dropped";
let before = calls; scripts.push({ tools: [{ name: "report", args: { text: "failed final", final: true } }] });
await worker.prompt("delivery failure"); assert.equal(calls - before, 2);
assert.ok(worker.sessionManager.getEntries().some((e) => e.type === "message" && e.message.role === "toolResult" && e.message.isError), "actual toolResult isError");
delivered = true;
if (teams) {
	before = calls; scripts.push({ tools: [{ name: "ask", args: { text: "which option?" } }] });
	await worker.prompt("ask then wait"); assert.equal(calls - before, 1);
	before = calls; await worker.prompt("answer: option A"); assert.equal(calls - before, 1, "question resumes on next mail turn");
}
worker.dispose();
console.log("  ok  tool success/failure matrix and actual scripted-provider termination (including mixed parallel batches)");

// Run the production extension against real Pi: sendMessage is void and message_end precedes append.
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
let main;
try {
	const mainLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [extension.default ?? extension] });
	await mainLoader.reload();
	const result = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager, resourceLoader: mainLoader,
		sessionManager: sdk.SessionManager.create(cwd, agentDir), noTools: "all" });
	main = result.session;
	const errors = [];
	await main.bindExtensions({ onError: (error) => errors.push(error) });
	const layout = createLayout(cwd, { agentDir, sessionId: main.sessionId });
	const mail = (text) => { const envelope = makeEnvelope({ from: "worker/main", to: "main", type: "report", text }); writeEnvelope(layout.mainMailboxDir, envelope); return envelope.id; };
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const first = mail("A"); before = calls;
	await main.prompt("settle with pending mail");
	assert.equal(calls - before, 1, "wake is delayed");
	await wait(100); const second = mail("B");
	await wait(450); await main.waitForIdle();
	assert.equal(calls - before, 2, "one coalesced wake");
	assert.equal(readPending(layout.mainMailboxDir).length, 0, "mail consumed after durable transcript");
	const persisted = readPersistedMailIds(main.sessionFile, customType);
	assert.ok(persisted.has(first) && persisted.has(second));
	const entries = main.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === customType);
	assert.equal(entries.length, 1); assert.ok(entries[0].content.includes("A") && entries[0].content.includes("B"));
	const errorMail = mail("inference fails after append"); before = calls;
	scripts.push({}, { error: true }); await main.prompt("settle before failed inference");
	await wait(450); await main.waitForIdle();
	assert.equal(calls - before, 2); assert.ok(readPersistedMailIds(main.sessionFile, customType).has(errorMail));
	await main.extensionRunner.emit({ type: "agent_settled" }); await wait(350);
	assert.equal(calls - before, 2, "persisted injection is not repeated after inference failure");
	const last = mail("shutdown pending");
	await main.extensionRunner.emit({ type: "agent_settled" });
	await main.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	await wait(350); assert.ok(readPending(layout.mainMailboxDir).some((p) => p.envelope.id === last));
	assert.deepEqual(errors, []);
	// Crash between persistence and mailbox commit: reconcile only the old IDs, preserve new mail.
	const recovery = createCore({ layout, modelRuntime, modelRegistry, settingsManager });
	const restored = makeEnvelope({ from: "worker/main", to: "main", type: "report", text: "already persisted" });
	writeEnvelope(layout.mainMailboxDir, restored);
	const snapshot = recovery.takeMainMailDigest(new Set([restored.id]));
	snapshot.begin();
	assert.ok(recovery.takeMainMailDigest().digest.includes("re-delivered"), "failed attempt labels redelivery");
	assert.ok(snapshot.envelopeIds.includes(last)); assert.ok(!snapshot.envelopeIds.includes(restored.id));
	await recovery.dispose();
	const sessionFile = main.sessionFile;
	main.dispose();
	const resumedLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [extension.default ?? extension] });
	await resumedLoader.reload();
	main = (await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager, resourceLoader: resumedLoader,
		sessionManager: sdk.SessionManager.open(sessionFile, agentDir), noTools: "all" })).session;
	before = calls;
	await main.bindExtensions({ onError: (error) => errors.push(error) });
	await wait(450); await main.waitForIdle();
	assert.equal(calls - before, 1, "resume delivers pending mail without waiting for user input");
	assert.equal(readPending(layout.mainMailboxDir).length, 0);
	await main.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	assert.deepEqual(errors, []);
	// A partial JSONL line and in-memory-only entries never acknowledge a delivery.
	const partial = join(scratch, "partial.jsonl");
	writeFileSync(partial, JSON.stringify({ type: "custom_message", customType, details: { envelopeIds: ["partial"] } }));
	assert.equal(readPersistedMailIds(partial, customType).size, 0);
	assert.equal(readPersistedMailIds(join(scratch, "not-written.jsonl"), customType).size, 0);
	assert.throws(() => readPersistedMailIds(cwd, customType), "unknown/unreadable persistence state fails closed");
	console.log("  ok  production extension: delayed coalesced wake, persisted acknowledgement, shutdown and recovery");
} finally {
	if (main) {
		await main.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		main.dispose();
	}
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(scratch, { recursive: true, force: true });
}
