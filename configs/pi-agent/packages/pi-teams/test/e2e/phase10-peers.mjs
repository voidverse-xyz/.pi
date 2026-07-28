/**
 * Phase-10 peer-messaging control e2e (D12). The `peers` capability with three
 * layers of control (user → main → per-type), covering:
 *   - frontmatter `peers: false` parses
 *   - identity prose flips between "you may message peers" and "cannot message
 *     them directly; the main agent coordinates"
 *   - createSubagentTools omits send_message when peers are off
 *   - precedence: user on/off beats the main override beats the per-type default
 *   - live enforcement: a peer send bounces when the sender's effective peers=off,
 *     through a REAL agent turn (scripted mock LLM)
 *   - the team_peers tool reports "user-locked" when the user has pinned it
 *
 * Run: node phase10-peers.mjs
 */
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestModelRuntime, EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { parseTypeFile } = await jiti.import(join(EXT, "typedefs/parse.ts"));
const { composeIdentityBlock } = await jiti.import(join(EXT, "context/compose.ts"));
const { createSubagentTools } = await jiti.import(join(EXT, "tools/sub-agent.ts"));
const { createPeersTool } = await jiti.import(join(EXT, "tools/main-agent.ts"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ------------------------------------------------------------------ pure: parse
console.log("frontmatter:");
await test("peers:false parses; bad value rejected; default omitted", () => {
	const off = parseTypeFile("---\nname: t\ndescription: d\npeers: false\n---\nbody", "t");
	assert.ok(off.ok && off.definition.config.peers === false);
	const on = parseTypeFile("---\nname: t\ndescription: d\n---\nbody", "t");
	assert.ok(on.ok && on.definition.config.peers === undefined, "default is unset (treated as on)");
	const bad = parseTypeFile("---\nname: t\ndescription: d\npeers: maybe\n---\nbody", "t");
	assert.equal(bad.ok, false);
});

// ------------------------------------------------------------------ pure: prose
console.log("identity prose:");
const peers = [{ address: "b/main", purview: "b" }];
await test("peers ON: 'you may message any of these peers'", () => {
	const block = composeIdentityBlock({ address: "a/main", purview: "a", peers, peersEnabled: true });
	assert.ok(block.includes("You may message any of these peers"));
	assert.ok(!block.includes("cannot message them directly"));
});
await test("peers OFF: 'cannot message them directly; main coordinates'", () => {
	const block = composeIdentityBlock({ address: "a/main", purview: "a", peers, peersEnabled: false });
	assert.ok(block.includes("cannot message them directly"));
	assert.ok(block.includes("main agent coordinates the team"));
	assert.ok(block.includes("Peer messaging is OFF"));
	assert.ok(!block.includes("You may message any of these peers"));
});

// ------------------------------------------------------------------ pure: tools
console.log("tool set:");
const stubPort = { sendFromAgent: () => ({ delivered: true, disposition: "held", envelopeId: "x" }) };
await test("send_message present when peers on, absent when off", () => {
	const on = createSubagentTools("a/main", stubPort, { peers: true }).map((t) => t.name);
	const off = createSubagentTools("a/main", stubPort, { peers: false }).map((t) => t.name);
	assert.deepEqual(on, ["send_message", "report", "ask"]);
	assert.deepEqual(off, ["report", "ask"], "no send_message when peers off; report/ask remain");
});

// ------------------------------------------------------------- real core: precedence + enforcement
console.log("precedence + live enforcement:");
const scratch = join(WORLDS, "phase10-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
const defs = join(home, ".pi", "agent", "subagents");
mkdirSync(defs, { recursive: true });
mkdirSync(project, { recursive: true });
// talker: peers ON by default; loner: peers OFF by default.
writeFileSync(join(defs, "talker.md"), ["---", "name: talker", "description: t", "model: mock/mock-1", "projectContext: false", "---", "You are TALKER."].join("\n"));
writeFileSync(join(defs, "loner.md"), ["---", "name: loner", "description: l", "model: mock/mock-1", "projectContext: false", "peers: false", "---", "You are LONER."].join("\n"));

const scripts = [];
function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const sys = context.systemPrompt ?? "";
		const address = (sys.match(/address `([^`]+)`/) || [])[1] ?? "?";
		const lastRole = context.messages.at(-1)?.role;
		let spec = { text: "ok" };
		for (let i = 0; i < scripts.length; i++) {
			if (scripts[i].match({ address, lastRole })) {
				spec = scripts.splice(i, 1)[0].reply();
				break;
			}
		}
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		if (spec.tools) {
			const content = spec.tools.map((t, i) => ({ type: "toolCall", id: `c${i}`, name: t.name, arguments: t.args }));
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
			baseUrl: "http://mock.invalid",
			apiKey: "k",
			api: "mock-api",
			streamSimple: mockStream,
			models: [{ id: "mock-1", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
		},
	},
});
const layout = createLayout(project, { home, sessionId: "sess-10" });
const core = createCore({ layout, modelRuntime, modelRegistry, settingsManager, maxConcurrent: 3 });

await test("peerState precedence: user on/off beats main override beats default", () => {
	core.setUserPeerMode("llm");
	core.setMainPeerOverride(null);
	assert.deepEqual(core.peerState(), { userMode: "llm", mainOverride: null, userControls: false });
	core.setMainPeerOverride(false);
	assert.equal(core.peerState().mainOverride, false, "main can set an override while user delegates");
	core.setUserPeerMode("on");
	assert.equal(core.peerState().userControls, true, "user pin takes control away from main");
});

await test("team_peers reports user-locked when the user has pinned the setting", async () => {
	core.setUserPeerMode("off"); // user pins OFF
	const tool = createPeersTool(() => core);
	const res = await tool.execute("id", { mode: "on" }, undefined, undefined, {});
	const out = JSON.parse(res.content[0].text);
	assert.equal(out.applied, false, "main's request is not applied while user controls");
	assert.ok(out.note.includes("pinned"), "the model is told the user's choice wins");
});

await test("the peer gate enforces live at the delivery port (on → delivered, off → bounced)", async () => {
	// Two real agents so both sender and recipient exist.
	await core.spawn({ type: "talker", id: "main", task: "exist" });
	await core.spawn({ type: "loner", id: "main", task: "exist" });
	await core.whenIdle();
	const port = core.runtime; // InProcessRuntime implements SubagentMailPort

	// User pins ON → a talker→loner peer message is delivered.
	core.setUserPeerMode("on");
	const on = port.sendFromAgent("talker/main", { to: "loner/main", type: "message", text: "hi" });
	assert.equal(on.delivered, true, "peer send delivered while peers ON");
	assert.notEqual(on.disposition, "bounced");

	// User pins OFF → the SAME send bounces, immediately, without rebuilding the session.
	core.setUserPeerMode("off");
	const off = port.sendFromAgent("talker/main", { to: "loner/main", type: "message", text: "hi again" });
	assert.equal(off.delivered, false, "peer send blocked while peers OFF");
	assert.equal(off.disposition, "bounced");
	assert.ok(off.bounceReason.includes("main agent"), "the bounce points the agent at the coordinator");

	// Upward channel to main is NEVER gated, even with peers OFF.
	const toMain = port.sendFromAgent("talker/main", { to: "main", type: "report", text: "still can report" });
	assert.notEqual(toMain.disposition, "bounced", "reports to main are always allowed");
});

await core.dispose();
console.log(`\nPhase 10 (peer control): ${passed} checks passed.`);
