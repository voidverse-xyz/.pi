import { dependencyRoot } from "../../../../tests/runtime.mjs";
import { systemPromptText } from "../../../../tests/runtime.mjs";
/**
 * Phase-7 completion e2e for pi-teams: explicit team_await (completed /
 * attention / timeout), persistent reuse after final reports, manual retire +
 * archive, collect validation on arrival, and the main-mail digest drain.
 *
 * Run: node phase7-completion.mjs
 */
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createTestModelRuntime, EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(dependencyRoot("@earendil-works/pi-ai", PI_PKG), "dist", "index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));
const { composeIdentityBlock } = await jiti.import(join(EXT, "context/compose.ts"));

const scratch = join(WORLDS, "phase7-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent", "subagents"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "subagents", "worker.md"), ["---", "name: worker", "description: worker", "model: mock/mock-1", "projectContext: false", "tools: [read]", "---", "You are WORKER."].join("\n"));

// Scripted mock: reply once per wake (lastRole user) using scripts; else end turn.
const scripts = [];
function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const sp = systemPromptText(context);
		const address = (sp.match(/address `([^`]+)`/) || [])[1] ?? "?";
		const lastRole = context.messages.at(-1)?.role;
		let lastUser = "";
		for (let i = context.messages.length - 1; i >= 0; i--) if (context.messages[i].role === "user") { const c = context.messages[i].content; lastUser = typeof c === "string" ? c : c.map((x) => x.text ?? "").join(""); break; }
		let spec = { text: "idle" };
		if (lastRole === "user") for (let i = 0; i < scripts.length; i++) if (scripts[i].match({ address, lastUser })) { spec = scripts.splice(i, 1)[0].reply(); break; }
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		if (spec.tools) {
			const content = spec.tools.map((t, i) => ({ type: "toolCall", id: `c${Date.now()}_${i}`, name: t.name, arguments: t.args }));
			const output = { ...base, content, stopReason: "toolUse" };
			stream.push({ type: "start", partial: output });
			content.forEach((tc, i) => { stream.push({ type: "toolcall_start", contentIndex: i, partial: output }); stream.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: output }); });
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
		mock: { baseUrl: "http://mock.invalid", apiKey: "k", api: "mock-api", streamSimple: mockStream, models: [{ id: "mock-1", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] },
	},
});

const layout = createLayout(project, { home, sessionId: "sess-7" });
let core = createCore({ layout, modelRuntime, modelRegistry, settingsManager, maxConcurrent: 3 });

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

console.log("await:");
await test("await(final) returns the correlated final report", async () => {
	scripts.push({ match: (c) => c.address === "worker/j1", reply: () => ({ tools: [{ name: "report", args: { text: "task done", final: true } }] }) });
	const { taskEnvelopeId } = await core.spawn({ type: "worker", id: "j1", task: "do job" });
	const result = await core.awaitResult({ to: "worker/j1", waitFor: "final", anchorId: taskEnvelopeId, timeoutSeconds: 10 });
	assert.equal(result.status, "completed");
	assert.ok(result.report.final);
	assert.ok(result.report.text.includes("task done"));
});

await test("await returns 'attention' when the agent asks instead of finishing", async () => {
	scripts.push({ match: (c) => c.address === "worker/j2", reply: () => ({ tools: [{ name: "ask", args: { text: "which config?" } }] }) });
	const { taskEnvelopeId } = await core.spawn({ type: "worker", id: "j2", task: "do job" });
	const result = await core.awaitResult({ to: "worker/j2", waitFor: "final", anchorId: taskEnvelopeId, timeoutSeconds: 10 });
	assert.equal(result.status, "attention");
	assert.ok(result.attention.text.includes("which config?"));
});

await test("await times out when nothing arrives (consumes nothing)", async () => {
	await core.spawn({ type: "worker", id: "idle" }); // dormant, no task
	const result = await core.awaitResult({ to: "worker/idle", waitFor: "final", anchorId: "msg_nope", timeoutSeconds: 0.2 });
	assert.equal(result.status, "timeout");
});

console.log("display label:");
await test("a spawn label is sanitized, stored, and becomes the roster purview", async () => {
	await core.spawn({ type: "worker", id: "labelled", label: "  auth   refactor  " });
	const entry = (await core.status()).find((r) => r.address === "worker/labelled");
	assert.ok(entry, "labelled agent on the roster");
	assert.equal(entry.label, "auth refactor", "label trimmed + whitespace-collapsed");
	assert.equal(entry.purview, "auth refactor", "label doubles as the purview");
	await core.retire("worker/labelled");
});

console.log("persistent completion:");
await test("the identity block explains completion and continued availability", () => {
	const identity = composeIdentityBlock({ address: "w/main", purview: "main", peers: [] });
	assert.ok(identity.includes("FINAL report"));
	assert.ok(identity.includes("available for follow-up work"));
	assert.ok(identity.includes("explicitly retire"));
});
await test("final reports retain the agent and later mail completes a new assignment", async () => {
	scripts.push({ match: (c) => c.address === "worker/main", reply: () => ({ tools: [{ name: "report", args: { text: "first task done", final: true } }] }) });
	const spawn = await core.spawn({ type: "worker", task: "first task" });
	const result = await core.awaitResult({ to: spawn.address, waitFor: "final", anchorId: spawn.taskEnvelopeId, timeoutSeconds: 10 });
	assert.equal(result.status, "completed");
	await core.whenIdle();
	const entry = (await core.status()).find((r) => r.address === spawn.address);
	assert.equal(entry.state, "dormant");
	assert.ok(!("lifetime" in entry));
	assert.ok(!core.archived().some((a) => a.address === spawn.address));

	scripts.push({ match: (c) => c.address === spawn.address, reply: () => ({ tools: [{ name: "report", args: { text: "follow-up done", final: true } }] }) });
	const followUp = await core.send({ to: spawn.address, text: "follow-up task" });
	assert.equal(followUp.disposition, "woken");
	const next = await core.awaitResult({ to: spawn.address, waitFor: "final", anchorId: followUp.envelopeId, timeoutSeconds: 10 });
	assert.equal(next.status, "completed");
	assert.equal(next.report.text, "follow-up done");
	assert.notEqual(followUp.envelopeId, spawn.taskEnvelopeId);
	await core.whenIdle();
	const detail = await core.peek(spawn.address, 100);
	assert.ok(detail.tail.some((e) => e.text.includes("first task")), "first task remains in memory");
	assert.ok(detail.tail.some((e) => e.text.includes("follow-up task")), "follow-up remains in memory");
	assert.ok(readFileSync(detail.sessionFile, "utf8").includes("first task done"), "first final report is persisted");
});
await test("legacy agents survive reload and final reports with their session memory intact", async () => {
	const address = "worker/main";
	const before = await core.peek(address, 100);
	await core.dispose();
	const legacy = JSON.parse(readFileSync(layout.registryFile, "utf8"));
	legacy.agents[address].lifetime = "oneshot";
	writeFileSync(layout.registryFile, JSON.stringify(legacy));
	core = createCore({ layout, modelRuntime, modelRegistry, settingsManager, maxConcurrent: 3 });
	const restored = await core.peek(address, 100);
	assert.equal(restored.sessionFile, before.sessionFile);
	assert.deepEqual(restored.tail, before.tail);
	scripts.push({ match: (c) => c.address === address, reply: () => ({ tools: [{ name: "report", args: { text: "resumed task done", final: true } }] }) });
	const assignment = await core.spawn({ type: "worker", task: "task after reload" });
	assert.equal(assignment.created, false);
	const result = await core.awaitResult({ to: address, waitFor: "final", anchorId: assignment.taskEnvelopeId, timeoutSeconds: 10 });
	assert.equal(result.status, "completed");
	await core.whenIdle();
	assert.ok((await core.status()).some((r) => r.address === address));
	assert.ok(!core.archived().some((a) => a.address === address));
	const detail = await core.peek(address, 100);
	assert.ok(detail.tail.some((e) => e.text.includes("first task")));
	assert.ok(detail.tail.some((e) => e.text.includes("task after reload")));
	await core.retire(address);
	assert.ok(core.archived().some((a) => a.address === address), "explicit retirement still archives memory");
});

console.log("retire:");
await test("manual retire deregisters + archives", async () => {
	await core.spawn({ type: "worker", id: "old" });
	const res = await core.retire("worker/old");
	assert.equal(res.retired, true);
	assert.ok(res.archiveDir);
	assert.ok(!(await core.status()).some((r) => r.address === "worker/old"));
	// address now bounces
	const send = await core.send({ to: "worker/old", text: "hi" });
	assert.equal(send.disposition, "bounced");
});

console.log("collect validation:");
await test("collect result is validated against its schema on await + in the digest", async () => {
	let reqId = null;
	scripts.push({ match: (c) => c.address === "worker/c1" && c.lastUser.includes("collect request"), reply: () => ({ tools: [{ name: "report", args: { text: "here", data: { answer: "not-an-int" }, correlationId: reqId } }] }) });
	await core.spawn({ type: "worker", id: "c1" });
	const collect = await core.collect("worker/c1", { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"] });
	reqId = collect.requestId;
	const result = await core.awaitResult({ to: "worker/c1", waitFor: "collect", anchorId: reqId, timeoutSeconds: 10 });
	assert.equal(result.status, "completed");
	assert.equal(result.validation.valid, false, "non-integer answer violates the schema");
	assert.ok(result.validation.errors.length > 0);
});

console.log("main-mail digest drain (D24):");
await test("takeMainMailDigest drains reports into a digest and marks them done", async () => {
	scripts.push({ match: (c) => c.address === "worker/r1", reply: () => ({ tools: [{ name: "report", args: { text: "progress note" } }] }) });
	await core.spawn({ type: "worker", id: "r1", task: "go" });
	await core.whenIdle();
	assert.ok(core.mainUnreadCount() > 0, "report queued for main");
	const drained = core.takeMainMailDigest();
	assert.ok(drained && drained.digest.includes("progress note"));
	assert.ok(core.mainUnreadCount() > 0, "mail is NOT consumed until commit() (at-least-once)");
	drained.commit();
	assert.equal(core.mainUnreadCount(), 0, "main mail marked done after commit");
	assert.equal(core.takeMainMailDigest(), null, "nothing left to drain");
});

await core.dispose();
console.log(`\nPhase 7: ${passed} checks passed.`);
