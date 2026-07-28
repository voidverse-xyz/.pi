/**
 * Phase-5 sandbox e2e for pi-teams: the non-overridable system-deny guard, the
 * pi.events safety bridge (fail-closed + claim), and end-to-end sandboxed
 * subagent tool calls (edit/write/bash → system-deny then pi-safety confirm).
 *
 * Run: node phase5-sandbox.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestModelRuntime, EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { makeSystemDenyCheck, realpathDeep } = await jiti.import(join(EXT, "sandbox/system-deny.ts"));
const { makeSafetyConfirm } = await jiti.import(join(EXT, "sandbox/safety-bridge.ts"));
const { selectToolNames } = await jiti.import(join(EXT, "sandbox/tools-filter.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// -------------------------------------------------------- system-deny (pure)
console.log("system-deny (pure):");
await test("denies the state tree + type-def dirs, ancestors; allows project files", () => {
	const id = (p) => p; // identity realpath (no fs)
	const stateTree = "/home/u/.pi/agent/sessions/--proj--/teams";
	const typeDefs = "/proj/.pi/subagents";
	const deny = makeSystemDenyCheck([stateTree, typeDefs], id);
	assert.equal(deny(join(stateTree, "sess-A/registry.json")).denied, true, "below state tree");
	assert.equal(deny(stateTree).denied, true, "the state tree itself");
	assert.equal(deny("/home/u/.pi/agent/sessions/--proj--").denied, true, "ancestor of the state tree");
	assert.equal(deny(join(typeDefs, "researcher.md")).denied, true, "a type-def file");
	assert.equal(deny("/proj/src/app.ts").denied, false, "an ordinary project file");
});
await test("realpathDeep resolves the deepest existing ancestor", () => {
	const world = join(WORLDS, "phase5-rp");
	rmSync(world, { recursive: true, force: true });
	mkdirSync(world, { recursive: true });
	const resolved = realpathDeep(join(world, "nonexistent", "child.txt"), realpathSync);
	assert.ok(resolved.endsWith(join("nonexistent", "child.txt")));
});

// -------------------------------------------------------- safety bridge (pure)
console.log("safety bridge (pure):");
function fakePi() {
	const handlers = {};
	return { events: { emit: (ch, data) => (handlers[ch] ?? []).forEach((h) => h(data)), on: (ch, h) => (handlers[ch] ??= []).push(h) } };
}
await test("fails closed when no provider claims", async () => {
	const confirm = makeSafetyConfirm(fakePi());
	assert.deepEqual((await confirm({ agent: "a/b", tool: "bash", command: "rm x" })).approved, false);
});
await test("uses the claiming provider's verdict", async () => {
	const pi = fakePi();
	let seen = null;
	pi.events.on("teams:confirm-request", (data) => data.claim(async (req) => { seen = req; return { approved: req.command !== "rm -rf /" }; }));
	const confirm = makeSafetyConfirm(pi);
	assert.equal((await confirm({ agent: "a/b", tool: "bash", command: "ls" })).approved, true);
	assert.equal(seen.command, "ls");
	assert.equal((await confirm({ agent: "a/b", tool: "bash", command: "rm -rf /" })).approved, false);
});

// -------------------------------------------------------- tools-filter (pure)
console.log("tools-filter (pure):");
await test("selectToolNames: allowlist intersect, unknown rejected, default = all", () => {
	assert.deepEqual(selectToolNames({ name: "t", tools: ["read", "bash"] }), ["read", "bash"]);
	assert.deepEqual(selectToolNames({ name: "t", tools: undefined }), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	assert.throws(() => selectToolNames({ name: "t", tools: ["read", "nope"] }));
});

// -------------------------------------------------------- end-to-end sandbox
console.log("sandboxed subagent tool calls:");
const scratch = join(WORLDS, "phase5-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
const globalDefinitionsDir = join(home, ".pi", "agent", "subagents");
const projectDefinitionsDir = join(project, ".pi", "subagents");
const globalDefinitionSentinel = join(globalDefinitionsDir, "global-sentinel.md");
const projectDefinitionSentinel = join(projectDefinitionsDir, "project-sentinel.md");
mkdirSync(globalDefinitionsDir, { recursive: true });
mkdirSync(projectDefinitionsDir, { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(globalDefinitionsDir, "coder.md"), ["---", "name: coder", "description: writes code", "model: mock/mock-1", "projectContext: false", "tools: [read, write, bash]", "---", "You are CODER."].join("\n"));
writeFileSync(globalDefinitionSentinel, "global definition sentinel");
writeFileSync(projectDefinitionSentinel, "project definition sentinel");

// Confirm port: record requests; approve unless the command/path contains DENY.
const confirmCalls = [];
const confirm = async (req) => {
	confirmCalls.push(req);
	const blob = `${req.command ?? ""} ${req.path ?? ""}`;
	return { approved: !blob.includes("DENY") };
};

// Mock LLM: on the first wake, perform a scripted tool call; then end.
let scriptedCall = null;
function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const sp = context.systemPrompt ?? "";
		const lastRole = context.messages.at(-1)?.role;
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		if (lastRole === "user" && sp.includes("`coder/") && scriptedCall) {
			const tc = { type: "toolCall", id: `c${Date.now()}`, name: scriptedCall.name, arguments: scriptedCall.args };
			const output = { ...base, content: [tc], stopReason: "toolUse" };
			stream.push({ type: "start", partial: output });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tc, partial: output });
			stream.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const output = { ...base, content: [{ type: "text", text: "done" }], stopReason: "stop" };
			stream.push({ type: "start", partial: output });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: output });
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

const layout = createLayout(project, { home, sessionId: "sess-5" });
const core = createCore({ layout, modelRuntime, modelRegistry, settingsManager, maxConcurrent: 2, confirm });

async function runScripted(id, call) {
	scriptedCall = call;
	confirmCalls.length = 0;
	await core.spawn({ type: "coder", id, task: "do the thing" });
	await core.whenIdle();
	scriptedCall = null;
}

await test("approved write to a project file executes", async () => {
	const target = join(project, "src", "new.txt");
	await runScripted("w1", { name: "write", args: { path: target, content: "hello world" } });
	assert.equal(confirmCalls.length, 1);
	assert.equal(confirmCalls[0].tool, "write");
	assert.ok(existsSync(target), "file written after approval");
	assert.equal(readFileSync(target, "utf8"), "hello world");
});

await test("write to the state tree is hard-denied BEFORE any confirmation", async () => {
	const target = join(layout.subagentsRoot, "registry.json");
	await runScripted("w2", { name: "write", args: { path: target, content: "PWNED" } });
	assert.equal(confirmCalls.length, 0, "system-deny blocks before pi-safety is asked");
	// registry.json legitimately changes (the w2 spawn writes it) — assert only
	// that the agent's payload never landed.
	assert.ok(!readFileSync(target, "utf8").includes("PWNED"), "state tree not overwritten by the agent");
});

await test("writes to shared global and project definitions are hard-denied", async () => {
	await runScripted("d1", { name: "write", args: { path: globalDefinitionSentinel, content: "PWNED" } });
	assert.equal(confirmCalls.length, 0, "global definition write blocked before confirmation");
	assert.equal(readFileSync(globalDefinitionSentinel, "utf8"), "global definition sentinel");

	await runScripted("d2", { name: "write", args: { path: projectDefinitionSentinel, content: "PWNED" } });
	assert.equal(confirmCalls.length, 0, "project definition write blocked before confirmation");
	assert.equal(readFileSync(projectDefinitionSentinel, "utf8"), "project definition sentinel");
});

await test("bash references to shared definitions are hard-denied", async () => {
	await runScripted("d3", { name: "bash", args: { command: `printf PWNED >> ${globalDefinitionSentinel}` } });
	assert.equal(confirmCalls.length, 0, "definition-targeting bash blocked before confirmation");
	assert.equal(readFileSync(globalDefinitionSentinel, "utf8"), "global definition sentinel");
});

await test("a denied confirmation blocks the write", async () => {
	const target = join(project, "src", "DENY-me.txt");
	await runScripted("w3", { name: "write", args: { path: target, content: "nope" } });
	assert.equal(confirmCalls.length, 1);
	assert.ok(!existsSync(target), "denied write did not execute");
});

await test("bash routes through confirmation", async () => {
	await runScripted("b1", { name: "bash", args: { command: "echo hi" } });
	assert.ok(confirmCalls.some((c) => c.tool === "bash" && c.command.includes("echo hi")));
});

await core.dispose();
console.log(`\nPhase 5: ${passed} checks passed.`);
