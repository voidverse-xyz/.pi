/**
 * Phase-2 runtime smoke test for pi-subagents-v2.
 *
 * Proves a REAL agent turn runs end-to-end through createAgentSession with a
 * fully stubbed LLM: a custom provider registered on an in-memory
 * ModelRegistry whose streamSimple returns scripted assistant messages (no
 * network). Everything else — Agent loop, AgentSession, SessionManager
 * persistence, system-prompt build — is the real SDK code path.
 *
 * Run: node smoke-phase2.mjs
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
const { sha256 } = await jiti.import(join(EXT, "typedefs/discover.ts"));
const { InProcessRuntime } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const { Scheduler } = await jiti.import(join(EXT, "runtime/scheduler.ts"));
const { composeIdentityBlock } = await jiti.import(join(EXT, "context/compose.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));
const { createSpawnTool, createStatusTool } = await jiti.import(join(EXT, "tools/main-agent.ts"));

// ---------------------------------------------------------------------------
// Temp world
// ---------------------------------------------------------------------------
const scratch = join(WORLDS, "phase2-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
writeFileSync(join(project, "AGENTS.md"), "MARKER_PROJECT_CONTEXT: always use tabs.\n");

// Type defs: researcher pins the mock model + opts OUT of project context;
// greeter inherits the session model + default projectContext.
writeFileSync(
	join(project, ".pi", "subagents", "researcher.md"),
	[
		"---",
		"name: researcher",
		"description: Digs into questions and reports findings",
		"model: mock/mock-1",
		"projectContext: false",
		"---",
		"You are a RESEARCHER_BODY_MARKER specialist.",
		"",
	].join("\n"),
);
mkdirSync(join(home, ".pi", "agent", "subagents"), { recursive: true });
writeFileSync(
	join(home, ".pi", "agent", "subagents", "greeter.md"),
	[
		"---",
		"name: greeter",
		"description: Says hello",
		"---",
		"You are a GREETER_BODY_MARKER.",
		"",
	].join("\n"),
);

// ---------------------------------------------------------------------------
// Mock LLM provider (fully stubbed streamSimple — no network)
// ---------------------------------------------------------------------------
const llmCalls = []; // { systemPrompt, messages, model } per LLM call
let mockDelayMs = 0;
let running = 0;
let maxObservedConcurrent = 0;

function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		running++;
		maxObservedConcurrent = Math.max(maxObservedConcurrent, running);
		llmCalls.push({
			systemPrompt: context.systemPrompt ?? "",
			messages: context.messages.map((m) => ({ role: m.role, content: m.content })),
			model: `${model.provider}/${model.id}`,
		});
		if (mockDelayMs > 0) await new Promise((r) => setTimeout(r, mockDelayMs));
		const text = `MOCK_REPLY_${llmCalls.length}`;
		const output = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: output });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
		running--;
		stream.push({ type: "done", reason: "stop", message: output });
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
			id: "mock-1",
			name: "Mock One",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 4096,
		},
	],
});

// ---------------------------------------------------------------------------
// Runtime under test
// ---------------------------------------------------------------------------
const layout = createLayout(project, { home });
const settingsManager = piSdk.SettingsManager.create(project, join(home, ".pi", "agent"));
const runtime = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 1 });

const events = [];
runtime.onEvent((e) => events.push(e));
function waitFor(predicate, label, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const check = () => {
			const hit = events.find(predicate);
			if (hit) return resolve(hit);
			if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
			setTimeout(check, 20);
		};
		const start = Date.now();
		check();
	});
}

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// Scheduler unit checks
// ---------------------------------------------------------------------------
console.log("scheduler:");
await test("slot pool is FIFO and capped", async () => {
	const s = new Scheduler(2);
	const r1 = await s.acquire();
	const r2 = await s.acquire();
	assert.equal(s.running, 2);
	let thirdGot = false;
	const third = s.acquire().then((r) => ((thirdGot = true), r));
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(thirdGot, false);
	assert.equal(s.queued, 1);
	r1();
	r1(); // double release is a no-op
	const r3 = await third;
	assert.equal(thirdGot, true);
	assert.equal(s.running, 2);
	r2();
	r3();
	assert.equal(s.running, 0);
});

// ---------------------------------------------------------------------------
// Lifetime / naming rules (D20)
// ---------------------------------------------------------------------------
console.log("naming rules:");
await test("explicit id on oneshot is rejected", async () => {
	await assert.rejects(
		runtime.spawn({ type: "researcher", id: "x", lifetime: "oneshot" }),
		/never take an explicit id/,
	);
});
await test("unknown type errors with library paths", async () => {
	await assert.rejects(runtime.spawn({ type: "nope" }), /Unknown subagent type "nope"/);
});
await test("invalid address segment rejected", async () => {
	await assert.rejects(runtime.spawn({ type: "researcher", id: "bad id!" }), /Invalid address/);
});

// ---------------------------------------------------------------------------
// One agent runs, end to end
// ---------------------------------------------------------------------------
console.log("one agent runs:");
let spawn1;
await test("spawn researcher/main with task → created, queued/running", async () => {
	spawn1 = await runtime.spawn({ type: "researcher", task: "Investigate X. TASK_ONE_MARKER" });
	assert.equal(spawn1.address, "researcher/main");
	assert.equal(spawn1.created, true);
	assert.ok(["queued", "running"].includes(spawn1.state), `state was ${spawn1.state}`);
});
await test("turn finishes; registry → dormant with vitals", async () => {
	await waitFor((e) => e.type === "turn-finished" && e.address === "researcher/main", "turn-finished");
	const rec = readRegistry(layout.registryFile).agents["researcher/main"];
	assert.equal(rec.state, "dormant");
	assert.equal(rec.lifetime, "persistent");
	assert.equal(rec.vitals.turns, 1);
	assert.ok(rec.vitals.tokens > 0, "tokens counted");
	assert.ok(rec.vitals.cost > 0, "cost counted");
});
await test("type hash recorded from the resolved file (D6)", async () => {
	const rec = readRegistry(layout.registryFile).agents["researcher/main"];
	const content = readFileSync(join(project, ".pi", "subagents", "researcher.md"), "utf8");
	assert.equal(rec.typeFileHash, sha256(content));
});
await test("session JSONL is REAL Pi format at the layout path (D3/D5)", async () => {
	const dir = layout.agentInstanceDir("researcher", "main");
	const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	assert.equal(files.length, 1);
	assert.match(files[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.jsonl$/);
	const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const header = lines[0];
	assert.equal(header.type, "session");
	assert.equal(header.cwd, project);
	assert.ok(header.id, "header has session id");
	const roles = lines.filter((l) => l.type === "message").map((l) => l.message.role);
	assert.deepEqual(roles, ["user", "assistant"]);
	const assistant = lines.find((l) => l.type === "message" && l.message.role === "assistant");
	assert.equal(assistant.message.content[0].text, "MOCK_REPLY_1");
	assert.ok(existsSync(join(dir, "files")), "files/ dir created");
});
await test("system prompt has D18 layers 1+3+4, and NO layer 2 (projectContext: false)", async () => {
	const call = llmCalls[0];
	assert.equal(call.model, "mock/mock-1"); // frontmatter pin resolved
	assert.match(call.systemPrompt, /expert coding assistant/); // layer 1: Pi base
	assert.match(call.systemPrompt, /RESEARCHER_BODY_MARKER/); // layer 3: type body
	assert.match(call.systemPrompt, /address `researcher\/main`/); // layer 4: identity
	assert.match(call.systemPrompt, /Questions are non-blocking/); // layer 4: conventions
	assert.match(call.systemPrompt, /solo worker/); // teamless comm powers
	assert.doesNotMatch(call.systemPrompt, /MARKER_PROJECT_CONTEXT/); // layer 2 off
	assert.match(call.messages[call.messages.length - 1].content[0]?.text ?? String(call.messages.at(-1).content), /TASK_ONE_MARKER/);
});

// ---------------------------------------------------------------------------
// Get-or-create wake with memory (D4/D5)
// ---------------------------------------------------------------------------
console.log("get-or-create:");
await test("re-spawn wakes the same identity: created:false, same file, memory in context", async () => {
	events.length = 0;
	const again = await runtime.spawn({ type: "researcher", task: "Continue. TASK_TWO_MARKER" });
	assert.equal(again.created, false);
	await waitFor((e) => e.type === "turn-finished" && e.address === "researcher/main", "turn 2");
	const dir = layout.agentInstanceDir("researcher", "main");
	assert.equal(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length, 1, "same session file appended");
	const call = llmCalls[1];
	const flat = JSON.stringify(call.messages);
	assert.ok(flat.includes("TASK_ONE_MARKER"), "first task still in context (memory intact)");
	assert.ok(flat.includes("MOCK_REPLY_1"), "first reply still in context");
	assert.ok(flat.includes("TASK_TWO_MARKER"), "new task delivered");
	const rec = readRegistry(layout.registryFile).agents["researcher/main"];
	assert.equal(rec.vitals.turns, 2);
});

// ---------------------------------------------------------------------------
// Cold wake: a fresh runtime (process restart) resumes the same JSONL
// ---------------------------------------------------------------------------
console.log("cold wake:");
await test("new runtime instance wakes with memory from disk", async () => {
	const runtime2 = new InProcessRuntime({ layout, modelRegistry, settingsManager, maxConcurrent: 1 });
	const evs = [];
	runtime2.onEvent((e) => evs.push(e));
	const res = await runtime2.spawn({ type: "researcher", task: "After restart. TASK_THREE_MARKER" });
	assert.equal(res.created, false);
	await new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (evs.some((e) => e.type === "turn-finished")) return resolve();
			if (Date.now() - start > 15000) return reject(new Error("timeout"));
			setTimeout(tick, 20);
		};
		tick();
	});
	const call = llmCalls[llmCalls.length - 1];
	assert.ok(JSON.stringify(call.messages).includes("TASK_ONE_MARKER"), "history restored from JSONL");
	assert.equal(readdirSync(layout.agentInstanceDir("researcher", "main")).filter((f) => f.endsWith(".jsonl")).length, 1);
	await runtime2.dispose();
});

// ---------------------------------------------------------------------------
// Inherited model + project context ON (greeter) + teams in identity
// ---------------------------------------------------------------------------
console.log("inherit + teams + layer 2:");
await test("greeter inherits session model, gets project context, joins team", async () => {
	events.length = 0;
	const res = await runtime.spawn({
		type: "greeter",
		id: "hallway",
		team: "welcome-crew",
		task: "Say hi",
		inherit: { modelRef: "mock/mock-1" },
	});
	assert.equal(res.address, "greeter/hallway");
	assert.equal(res.created, true);
	await waitFor((e) => e.type === "turn-finished" && e.address === "greeter/hallway", "greeter turn");
	const call = llmCalls[llmCalls.length - 1];
	assert.equal(call.model, "mock/mock-1"); // inherited
	assert.match(call.systemPrompt, /GREETER_BODY_MARKER/);
	assert.match(call.systemPrompt, /MARKER_PROJECT_CONTEXT/); // layer 2 ON by default
	assert.match(call.systemPrompt, /Team `welcome-crew`/);
	assert.deepEqual(readTeams(layout.teamsFile), { "welcome-crew": ["greeter/hallway"] });
});
await test("teammate rosters carry purviews (D18 layer 4)", async () => {
	events.length = 0;
	const res = await runtime.spawn({ type: "greeter", id: "lobby", team: "welcome-crew", task: "Hi too" });
	assert.equal(res.created, true);
	await waitFor((e) => e.type === "turn-finished" && e.address === "greeter/lobby", "lobby turn");
	const call = llmCalls[llmCalls.length - 1];
	assert.match(call.systemPrompt, /`greeter\/hallway` — hallway/); // teammate + purview
	assert.match(call.systemPrompt, /send messages to your teammates/);
});

// ---------------------------------------------------------------------------
// Oneshot naming (D13/D20)
// ---------------------------------------------------------------------------
console.log("oneshot:");
await test("anonymous oneshot gets tmp-<short> id", async () => {
	const res = await runtime.spawn({ type: "greeter", lifetime: "oneshot" });
	assert.match(res.address, /^greeter\/tmp-[0-9a-f]{7}$/);
	assert.equal(res.created, true);
	assert.equal(res.state, "dormant"); // no task → no turn
	const rec = readRegistry(layout.registryFile).agents[res.address];
	assert.equal(rec.lifetime, "oneshot");
});

// ---------------------------------------------------------------------------
// Scheduler cap through the runtime (D13): maxConcurrent=1
// ---------------------------------------------------------------------------
console.log("concurrency:");
await test("turns never overlap past maxConcurrent; waiters sit in queued state", async () => {
	events.length = 0;
	maxObservedConcurrent = 0;
	mockDelayMs = 150;
	const a = runtime.spawn({ type: "greeter", id: "c1", task: "one" });
	const b = runtime.spawn({ type: "greeter", id: "c2", task: "two" });
	await Promise.all([a, b]);
	// While one runs the other must be queued in the registry.
	const sawQueued = await waitFor(
		(e) => e.type === "state-changed" && e.state === "queued",
		"queued state",
	);
	assert.ok(sawQueued);
	await waitFor((e) => e.type === "turn-finished" && e.address === "greeter/c1", "c1 done");
	await waitFor((e) => e.type === "turn-finished" && e.address === "greeter/c2", "c2 done");
	assert.equal(maxObservedConcurrent, 1, "LLM calls never overlapped");
	mockDelayMs = 0;
});

// ---------------------------------------------------------------------------
// send / steer / interrupt (Phase-2 direct delivery)
// ---------------------------------------------------------------------------
console.log("send/interrupt:");
await test("send to dormant agent wakes it (delivery: delivered)", async () => {
	events.length = 0;
	const res = await runtime.send({ to: "greeter/hallway", text: "PING_MARKER" });
	assert.equal(res.delivery, "delivered");
	await waitFor((e) => e.type === "turn-finished" && e.address === "greeter/hallway", "send turn");
	assert.ok(JSON.stringify(llmCalls[llmCalls.length - 1].messages).includes("PING_MARKER"));
});
await test("send to unknown address bounces", async () => {
	await assert.rejects(runtime.send({ to: "ghost/nobody", text: "boo" }), /retired or never spawned/);
});
await test("steer/interrupt on idle agent are no-ops", async () => {
	assert.deepEqual(await runtime.steer("greeter/hallway", "x"), { steered: false });
	assert.deepEqual(await runtime.interrupt("greeter/hallway"), { interrupted: false });
});

// ---------------------------------------------------------------------------
// status / peek
// ---------------------------------------------------------------------------
console.log("status/peek:");
await test("roster joins registry + teams + vitals", async () => {
	const roster = await runtime.status();
	const hallway = roster.find((r) => r.address === "greeter/hallway");
	assert.equal(hallway.state, "dormant");
	assert.deepEqual(hallway.teams, ["welcome-crew"]);
	assert.ok(hallway.vitals.tokens > 0);
	assert.equal(hallway.purview, "hallway");
});
await test("peek returns detail + transcript tail from the session file", async () => {
	const detail = await runtime.peek("researcher/main", 2);
	assert.equal(detail.typeFileHash.length, 64);
	assert.ok(detail.sessionFile.endsWith(".jsonl"));
	assert.equal(detail.tail.length, 2);
	assert.equal(detail.tail[1].role, "assistant");
	assert.match(detail.tail[1].text, /MOCK_REPLY_/);
	assert.equal(await runtime.peek("ghost/nobody"), null);
});

// ---------------------------------------------------------------------------
// retire (D13)
// ---------------------------------------------------------------------------
console.log("retire:");
await test("retire deregisters, scrubs teams, archives the dir", async () => {
	const res = await runtime.retire("greeter/lobby");
	assert.equal(res.retired, true);
	assert.ok(res.archiveDir.includes("/.archive/greeter/lobby"));
	assert.ok(existsSync(res.archiveDir));
	assert.ok(!existsSync(layout.agentInstanceDir("greeter", "lobby")));
	assert.equal(readRegistry(layout.registryFile).agents["greeter/lobby"], undefined);
	assert.deepEqual(readTeams(layout.teamsFile)["welcome-crew"], ["greeter/hallway"]);
	await assert.rejects(runtime.send({ to: "greeter/lobby", text: "hi" }), /retired or never spawned/);
});

// ---------------------------------------------------------------------------
// core facade + tools (LLM-facing JSON shapes)
// ---------------------------------------------------------------------------
console.log("core + tools:");
await test("core facade lists types (project wins) and spawns", async () => {
	const core = createCore({ cwd: project, home, modelRegistry, settingsManager, maxConcurrent: 1 });
	const types = core.availableTypes().map((t) => `${t.name}:${t.source}`);
	assert.deepEqual(types, ["greeter:global", "researcher:project"]);
	await core.dispose();
});
await test("subagent_spawn / subagent_status tools return spec-shaped JSON", async () => {
	const core = createCore({ cwd: project, home, modelRegistry, settingsManager, maxConcurrent: 1 });
	const getCore = () => core;
	const spawnTool = createSpawnTool(getCore);
	const statusTool = createStatusTool(getCore);
	assert.equal(spawnTool.name, "subagent_spawn");
	assert.equal(statusTool.name, "subagent_status");
	const ctx = { model: modelRegistry.find("mock", "mock-1"), cwd: project };

	const spawnRes = await spawnTool.execute("t1", { type: "greeter", id: "tooltest", task: "hi" }, undefined, undefined, ctx);
	const spawnJson = JSON.parse(spawnRes.content[0].text);
	assert.deepEqual(Object.keys(spawnJson).sort(), ["address", "created", "state", "vitals"]);
	assert.equal(spawnJson.address, "greeter/tooltest");

	const badSpawn = await spawnTool.execute("t2", { type: "missing-type" }, undefined, undefined, ctx);
	assert.equal(badSpawn.isError, true);
	assert.match(badSpawn.content[0].text, /Available types:/);
	assert.match(badSpawn.content[0].text, /researcher \(project\)/);

	const rosterRes = await statusTool.execute("t3", {}, undefined, undefined, ctx);
	const roster = JSON.parse(rosterRes.content[0].text);
	assert.ok(roster.count >= 1);
	assert.ok(roster.agents.every((a) => "address" in a && "state" in a && "vitals" in a && "teams" in a));

	const detailRes = await statusTool.execute("t4", { address: "researcher/main", tail: 1 }, undefined, undefined, ctx);
	const detail = JSON.parse(detailRes.content[0].text);
	assert.equal(detail.address, "researcher/main");
	assert.equal(detail.tail.length, 1);

	const missing = await statusTool.execute("t5", { address: "ghost/x" }, undefined, undefined, ctx);
	assert.equal(missing.isError, true);
	await core.dispose();
});

await runtime.dispose();
console.log(`\nall ${passed} phase-2 smoke tests passed`);
