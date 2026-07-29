/**
 * Phase-4 rails e2e for pi-teams: the chain-hops rail (D21). Pure-unit checks
 * of makeHopsGuard/isMainEscape, then a forced peer ping-pong that must die at
 * the hop cap instead of looping forever.
 *
 * Run: node phase4-rails.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestModelRuntime, EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { makeHopsGuard, isMainEscape, DEFAULT_MAX_HOPS } = await jiti.import(join(EXT, "rails/hops.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------- pure units
console.log("hops (pure):");
await test("guard blocks at the cap; main-escape is never blocked", () => {
	const guard = makeHopsGuard(3);
	const peer = (hops) => makeEnvelope({ from: "worker/a", to: "worker/b", type: "message", text: "x", hops });
	assert.equal(guard(peer(2)), null);
	assert.ok(guard(peer(3))?.includes("report to the main agent"));
	// report/escalation/error → main are sacred at any depth
	const escape = makeEnvelope({ from: "worker/a", to: "main", type: "report", text: "help", hops: 99 });
	assert.ok(isMainEscape(escape));
	assert.equal(guard(escape), null);
	assert.equal(DEFAULT_MAX_HOPS, 8);
});

// -------------------------------------------------------------- ping-pong dies
console.log("runtime rail:");
const scratch = join(WORLDS, "phase4-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent", "subagents"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "subagents", "worker.md"), ["---", "name: worker", "description: worker", "model: mock/mock-1", "projectContext: false", "---", "You are WORKER."].join("\n"));

let pings = 0;
const HARD_CAP = 30; // safety: if the rail is broken, stop the mock looping forever
function otherOf(address) {
	return address === "worker/alice" ? "worker/bob" : "worker/alice";
}
function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const sp = context.systemPrompt ?? "";
		const address = (sp.match(/address `([^`]+)`/) || [])[1] ?? "?";
		const lastUser = (() => {
			for (let i = context.messages.length - 1; i >= 0; i--) if (context.messages[i].role === "user") {
				const c = context.messages[i].content;
				return typeof c === "string" ? c : c.map((x) => x.text ?? "").join("\n");
			}
			return "";
		})();
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		// Ping back exactly once per wake: only when the fresh wake digest is the
		// last message (role "user"); on the tool-result follow-up call, end the
		// turn. Also ignore delivery-failure errors (their text echoes "PING").
		const lastRole = context.messages.at(-1)?.role;
		const pingBack =
			(address === "worker/alice" || address === "worker/bob") &&
			lastRole === "user" &&
			lastUser.includes("PING") &&
			!lastUser.includes("Delivery to") &&
			pings < HARD_CAP;
		if (pingBack) {
			pings++;
			const content = [{ type: "toolCall", id: `c${pings}`, name: "send_message", arguments: { to: otherOf(address), text: "PING" } }];
			const output = { ...base, content, stopReason: "toolUse" };
			stream.push({ type: "start", partial: output });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: content[0], partial: output });
			stream.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const output = { ...base, content: [{ type: "text", text: "idle" }], stopReason: "stop" };
			stream.push({ type: "start", partial: output });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "idle", partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: "idle", partial: output });
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

const layout = createLayout(project, { home, sessionId: "sess-4" });
const MAX_HOPS = 3;
const core = createCore({ layout, modelRuntime, modelRegistry, settingsManager, maxConcurrent: 3, maxHops: MAX_HOPS });

await test("forced ping-pong dies at the hop cap (does not loop forever)", async () => {
	await core.spawn({ type: "worker", id: "alice" });
	await core.spawn({ type: "worker", id: "bob" });
	await core.send({ to: "worker/alice", text: "PING" }); // hops 0
	await core.whenIdle();
	// Without the rail this loops until HARD_CAP; with maxHops=3 it stops after a
	// few exchanges (hops 1,2,3 attempted; the hop-3 send bounces).
	assert.ok(pings > 0, "the exchange started");
	assert.ok(pings < HARD_CAP, `ping-pong terminated by the rail (pings=${pings})`);
	assert.ok(pings <= MAX_HOPS + 1, `bounded near the cap (pings=${pings})`);
	// The final bounce lands as an error envelope in the last sender's mailbox.
	const aliceDone = existsSync(join(layout.mailboxDir("worker", "alice"), ".done")) ? readdirSync(join(layout.mailboxDir("worker", "alice"), ".done")) : [];
	const bobDone = existsSync(join(layout.mailboxDir("worker", "bob"), ".done")) ? readdirSync(join(layout.mailboxDir("worker", "bob"), ".done")) : [];
	assert.ok(aliceDone.length + bobDone.length > 0, "exchanges were processed");
});

await core.dispose();
console.log(`\nPhase 4: ${passed} checks passed.`);
