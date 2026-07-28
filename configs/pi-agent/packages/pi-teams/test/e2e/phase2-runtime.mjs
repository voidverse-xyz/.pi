/**
 * Phase-2 runtime e2e for pi-teams: a REAL agent turn through
 * createAgentSession with a stubbed LLM (in-memory ModelRegistry, scripted
 * streamSimple — no network). Verifies spawn/get-or-create, JSONL persistence +
 * memory, vitals, status/peek, context composition (native project-context
 * ordering + body + identity), and the oneshot lifetime rule.
 *
 * Run: node phase2-runtime.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readRegistry, getAgent } = await jiti.import(join(EXT, "store/registry.ts"));
const { Scheduler } = await jiti.import(join(EXT, "runtime/scheduler.ts"));
const { composeIdentityBlock } = await jiti.import(join(EXT, "context/compose.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));

const scratch = join(WORLDS, "phase2-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent", "subagents"), { recursive: true });
mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
writeFileSync(join(project, "AGENTS.md"), "MARKER_PROJECT_CONTEXT: always use tabs.\n");

// researcher pins the mock model + opts OUT of project context.
writeFileSync(
	join(project, ".pi", "subagents", "researcher.md"),
	["---", "name: researcher", "description: Digs into questions", "model: mock/mock-1", "projectContext: false", "---", "You are a RESEARCHER_BODY_MARKER."].join("\n"),
);
// greeter inherits the session model + keeps default projectContext:true.
writeFileSync(
	join(home, ".pi", "agent", "subagents", "greeter.md"),
	["---", "name: greeter", "description: Says hello", "---", "You are a GREETER_BODY_MARKER."].join("\n"),
);
// broken pins an unknown model so pre-start error delivery can be verified.
writeFileSync(
	join(home, ".pi", "agent", "subagents", "broken.md"),
	["---", "name: broken", "description: Fails before its turn", "model: missing/no-such-model", "---", "Never reached."].join("\n"),
);

// ------------------------------------------------------------- mock provider
const llmCalls = [];
let lifecycleCalls = 0;

function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue;
		const content = messages[i].content;
		return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
	}
	return "";
}

function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const userText = lastUserText(context.messages);
		llmCalls.push({ systemPrompt: context.systemPrompt ?? "", model: `${model.provider}/${model.id}` });
		let spec;
		if (userText.includes("Exercise thinking lifecycle")) {
			lifecycleCalls++;
			spec = lifecycleCalls === 1
				? {
					thinking: "Inspecting the project instructions before reading them.",
					tools: [{ name: "read", args: { path: "AGENTS.md" } }],
				}
				: { thinking: "   ", text: "LIFECYCLE_OK", delayMs: 250 };
		} else {
			spec = {
				text: `MOCK_REPLY_${llmCalls.length}`,
				thinking: llmCalls.length === 1 ? "Inspecting the requested runtime task before replying." : "",
			};
		}

		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		if (spec.tools) {
			const thinking = spec.thinking ?? "";
			const toolCalls = spec.tools.map((tool) => ({ type: "toolCall", id: `call_${lifecycleCalls}`, name: tool.name, arguments: tool.args }));
			const content = [...(thinking ? [{ type: "thinking", thinking }] : []), ...toolCalls];
			const output = { ...base, content, stopReason: "toolUse" };
			stream.push({ type: "start", partial: output });
			if (thinking) {
				stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: output });
				stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial: output });
			}
			const toolOffset = thinking ? 1 : 0;
			toolCalls.forEach((toolCall, i) => {
				stream.push({ type: "toolcall_start", contentIndex: i + toolOffset, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: i + toolOffset, toolCall, partial: output });
			});
			stream.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const thinking = spec.thinking ?? "";
			const text = spec.text;
			const content = [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }];
			const output = { ...base, content, stopReason: "stop" };
			stream.push({ type: "start", partial: output });
			if (thinking) {
				stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: output });
				await new Promise((resolve) => setTimeout(resolve, spec.delayMs ?? 250));
				stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial: output });
			}
			const textIndex = thinking ? 1 : 0;
			stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
			stream.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: textIndex, content: text, partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
		}
		stream.end();
	})();
	return stream;
}

const agentDir = join(home, ".pi", "agent");
const settingsManager = piSdk.SettingsManager.create(project, agentDir);
const modelServices = await piSdk.createAgentSessionServices({
	cwd: project,
	agentDir,
	settingsManager,
	resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
});
const modelRuntime = modelServices.modelRuntime;
modelRuntime.registerProvider("mock", {
	baseUrl: "http://mock.invalid",
	apiKey: "test-key",
	api: "mock-api",
	streamSimple: mockStream,
	models: [{ id: "mock-1", name: "Mock One", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
});
const modelRegistry = new piSdk.ModelRegistry(modelRuntime);

const layout = createLayout(project, { home, sessionId: "sess-2" });
// Match live index.ts: pass the main facade but let Teams lazily create its own
// canonical ModelRuntime and mirror registered provider configs into it.
const core = createCore({ layout, modelRegistry, settingsManager, maxConcurrent: 2 });

const events = [];
core.onEvent((e) => events.push(e));

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

async function until(fn, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = fn();
		if (value || Date.now() >= deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

console.log("scheduler:");
await test("FIFO + capped + double-release no-op", async () => {
	const s = new Scheduler(2);
	const r1 = await s.acquire();
	await s.acquire();
	assert.equal(s.runningCount, 2);
	let third = false;
	const p = s.acquire().then((r) => ((third = true), r));
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(third, false);
	assert.equal(s.queuedCount, 1);
	r1();
	r1(); // no-op
	await p;
	assert.equal(third, true);
});

console.log("compose:");
await test("identity block: flat peers, no teams", () => {
	const block = composeIdentityBlock({ address: "refactorer/auth", purview: "auth", peers: [{ address: "docs/main", purview: "docs" }] });
	assert.ok(block.includes("refactorer/auth"));
	assert.ok(block.includes("docs/main"));
	assert.ok(!block.toLowerCase().includes("team"));
});

console.log("runtime:");
await test("spawn with task runs a real turn; JSONL + vitals land", async () => {
	const result = await core.spawn({ type: "researcher", id: "q1", task: "Investigate X." });
	assert.equal(result.address, "researcher/q1");
	assert.equal(result.created, true);
	const thinking = await until(() => {
		const candidate = core.activitySnapshot().find((entry) => entry.address === "researcher/q1");
		return candidate?.summary === "Inspecting the requested runtime task before replying. · thinking…" ? candidate : null;
	});
	assert.ok(thinking, "provider-visible thinking replaces the generic placeholder during a live turn");
	await core.whenIdle();
	const dir = layout.agentInstanceDir("researcher", "q1");
	const jsonl = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	assert.equal(jsonl.length, 1, "one session JSONL");
	const rec = getAgent(readRegistry(layout.registryFile), "researcher/q1");
	assert.equal(rec.vitals.state, "dormant");
	assert.ok(rec.vitals.turns >= 1, "at least one assistant turn recorded");
	assert.ok(rec.vitals.tokens > 0);
	assert.ok(events.some((e) => e.type === "turn-started" && e.address === "researcher/q1"));
	assert.ok(events.some((e) => e.type === "turn-finished" && e.address === "researcher/q1"));
});

await test("pinned model is used; project context OFF for researcher; body + identity present", () => {
	const call = llmCalls.at(-1);
	assert.equal(call.model, "mock/mock-1", "researcher pins mock/mock-1");
	assert.ok(call.systemPrompt.includes("RESEARCHER_BODY_MARKER"), "type body (layer 3)");
	assert.ok(call.systemPrompt.includes("Your identity"), "identity block (layer 4)");
	assert.ok(!call.systemPrompt.includes("MARKER_PROJECT_CONTEXT"), "projectContext:false → no AGENTS.md");
});

await test("the latest visible thought returns after a tool and survives a blank next thinking block", async () => {
	const result = await core.spawn({ type: "researcher", id: "lifecycle", task: "Exercise thinking lifecycle." });
	assert.equal(result.created, true);
	const restored = await until(() => {
		const candidate = core.activitySnapshot().find((entry) => entry.address === "researcher/lifecycle");
		return candidate?.toolUses === 1 && candidate.tool === "" && candidate.summary === "Inspecting the project instructions before reading them. · thinking…"
			? candidate
			: null;
	});
	assert.ok(restored, "tool completion and blank thinking must retain the latest visible clue");
	await core.whenIdle();
});

await test("get-or-create wakes with memory intact (created:false, same JSONL)", async () => {
	const dir = layout.agentInstanceDir("researcher", "q1");
	const before = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	const again = await core.spawn({ type: "researcher", id: "q1", task: "Follow up." });
	assert.equal(again.created, false);
	await core.whenIdle();
	const after = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	assert.deepEqual(after, before, "same session file resumed, not a new one");
	const detail = await core.peek("researcher/q1", 50);
	assert.ok(detail.tail.some((t) => t.text.includes("Investigate X")), "first task still in memory");
	assert.ok(detail.tail.length >= 3, "both turns present");
});

await test("greeter inherits session model + includes project context", async () => {
	await core.spawn({ type: "greeter", id: "main", task: "Hi", inherit: { modelRef: "mock/mock-1" } });
	await core.whenIdle();
	const call = llmCalls.at(-1);
	assert.equal(call.model, "mock/mock-1", "inherited model");
	assert.ok(call.systemPrompt.includes("GREETER_BODY_MARKER"));
	assert.ok(call.systemPrompt.includes("MARKER_PROJECT_CONTEXT"), "projectContext:true → AGENTS.md loaded natively");
});

console.log("status/peek:");
await test("roster lists all agents with vitals", async () => {
	const roster = await core.status();
	const addrs = roster.map((r) => r.address).sort();
	assert.deepEqual(addrs, ["greeter/main", "researcher/lifecycle", "researcher/q1"]);
	assert.ok(roster.every((r) => r.state === "dormant"));
	assert.equal(await core.peek("nope/x"), null);
});

console.log("pre-start errors:");
await test("handle-build failure notifies main and leaves task pending for retry", async () => {
	await core.spawn({ type: "broken", id: "bad-model", task: "This cannot start." });
	await core.whenIdle();
	assert.equal(core.mainUnreadCount(), 1, "main receives an actionable error envelope");
	const drained = core.takeMainMailDigest();
	assert.ok(drained?.digest.includes("Turn failed before start"));
	assert.ok(drained?.digest.includes("missing/no-such-model"));
	drained?.commit();
	const detail = await core.peek("broken/bad-model", 10);
	assert.equal(detail?.state, "dormant");
	assert.equal(detail?.unread, 1, "original task remains pending for a fixed-model retry");
});

console.log("lifetime:");
await test("oneshot must not take an id; anonymous gets tmp-<hex>", async () => {
	await assert.rejects(core.spawn({ type: "greeter", id: "x", lifetime: "oneshot" }));
	const one = await core.spawn({ type: "greeter", lifetime: "oneshot", task: "quick" });
	assert.match(one.address, /^greeter\/tmp-[0-9a-f]+$/);
	await core.whenIdle();
});

await test("unknown type lists the catalog", async () => {
	await assert.rejects(core.spawn({ type: "ghost" }), (e) => e.message.startsWith("Unknown subagent type"));
	assert.ok(core.availableTypes().some((t) => t.name === "researcher"));
});

await core.dispose();
console.log(`\nPhase 2: ${passed} checks passed.`);
