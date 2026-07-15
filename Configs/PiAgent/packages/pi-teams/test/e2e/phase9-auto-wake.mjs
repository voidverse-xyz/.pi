/**
 * Phase-9 auto-wake e2e (D24): mail arriving for an IDLE main host must start
 * exactly one autonomous main-agent turn — no user message required.
 *
 * Regression for the auto-wake bug: `pi.sendMessage(..., {deliverAs:"followUp"})`
 * only consults `deliverAs` while STREAMING. When idle it fell through to a silent
 * "append to state, no turn", so the digest sat in the conversation until the user's
 * next message. The fix adds `triggerTurn: true`.
 *
 * Drives a REAL main AgentSession (stubbed LLM) so the SDK's actual branch logic is
 * exercised, and mirrors index.ts's deliverMainMail()/hostIdle lifecycle.
 *
 * Run: node phase9-auto-wake.mjs
 */
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { writeEnvelope } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));
// The REAL injection options used by index.ts's deliverMainMail — imported, not
// copied, so stripping `triggerTurn` from production breaks this suite.
const { WAKE_DELIVERY } = await jiti.import(join(EXT, "index.ts"));

const scratch = join(WORLDS, "phase9-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(project, { recursive: true });

// ------------------------------------------------------------- mock provider
const llmCalls = [];
function mockStream(model) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		llmCalls.push({ n: llmCalls.length + 1 });
		const text = `MOCK_${llmCalls.length}`;
		const output = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: output });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
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
	models: [{ id: "mock-1", name: "Mock One", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
});

const agentDir = join(home, ".pi", "agent");
const layout = createLayout(project, { home, sessionId: "sess-9" });
const settingsManager = piSdk.SettingsManager.create(project, agentDir);
const core = createCore({ layout, modelRegistry, settingsManager, authStorage });

// A REAL main-agent session — the thing auto-wake must start a turn on.
const resolved = piSdk.resolveCliModel({ cliModel: "mock/mock-1", modelRegistry });
assert.ok(resolved.model, `model resolve failed: ${resolved.error}`);
const { session: mainSession } = await piSdk.createAgentSession({
	cwd: project,
	agentDir,
	sessionManager: piSdk.SessionManager.create(project, agentDir),
	settingsManager,
	authStorage,
	modelRegistry,
	model: resolved.model,
	noTools: "builtin",
	customTools: [],
});

// ------------------------------------------- index.ts's deliverMainMail, mirrored
let hostIdle = false;
let shuttingDown = false;
let deliverCount = 0;
const injected = [];

/** Mirrors extensions/teams/index.ts deliverMainMail() incl. the hostIdle lifecycle. */
function deliverMainMail() {
	if (!hostIdle || shuttingDown) return;
	const drained = core.takeMainMailDigest();
	if (!drained) return;
	hostIdle = false;
	deliverCount++;
	injected.push(drained.digest);
	// The production call shape — WAKE_DELIVERY is imported from index.ts.
	void mainSession.sendCustomMessage(
		{ content: drained.digest, customType: "teams-mail", display: true, details: undefined },
		WAKE_DELIVERY,
	);
	drained.commit();
}

// The runtime's wake trigger, as wired in index.ts.
core.onEvent((event) => {
	if (event.type === "turn-finished" || event.type === "agent-retired") deliverMainMail();
});

/** Put a report from a subagent into main's mailbox (as the runtime would). */
function mailToMain(text) {
	writeEnvelope(layout.mainMailboxDir, makeEnvelope({ from: "worker/main", to: "main", type: "report", text }));
}

/** Simulate Pi's agent_settled → host is idle → drain. */
function settle() {
	hostIdle = true;
	deliverMainMail();
}

const settleWait = async () => {
	await mainSession.waitForIdle();
	await new Promise((r) => setTimeout(r, 120));
};

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

console.log("auto-wake (D24):");

await test("mail arriving while the host is IDLE starts exactly one autonomous turn", async () => {
	const before = llmCalls.length;
	mailToMain("background worker finished");
	settle(); // agent_settled with mail already pending
	await settleWait();
	assert.equal(llmCalls.length - before, 1, "exactly one autonomous main turn");
	assert.equal(core.mainUnreadCount(), 0, "mail consumed");
	assert.ok(injected[injected.length - 1].includes("background worker finished"));
});

await test("no duplicate digest / no duplicate turn on a second settle", async () => {
	const before = llmCalls.length;
	const digestsBefore = injected.length;
	settle(); // nothing pending
	await settleWait();
	assert.equal(llmCalls.length - before, 0, "no extra turn when there is no mail");
	assert.equal(injected.length, digestsBefore, "no duplicate digest");
});

await test("mail arriving DURING a main turn is not lost and wakes once at the boundary", async () => {
	const before = llmCalls.length;
	hostIdle = false; // host is mid-turn
	mailToMain("arrived mid-turn");
	assert.equal(core.mainUnreadCount(), 1, "held while busy — never interrupts (D11)");
	assert.equal(llmCalls.length - before, 0, "no turn started while busy");
	settle(); // turn ends → agent_settled
	await settleWait();
	assert.equal(llmCalls.length - before, 1, "exactly one wake at the boundary");
	assert.equal(core.mainUnreadCount(), 0);
});

await test("a burst of reports coalesces into ONE digest and ONE turn", async () => {
	const before = llmCalls.length;
	const digestsBefore = injected.length;
	mailToMain("report A");
	mailToMain("report B");
	mailToMain("report C");
	settle();
	await settleWait();
	assert.equal(injected.length - digestsBefore, 1, "one coalesced digest");
	assert.equal(llmCalls.length - before, 1, "one turn, not three");
	const d = injected[injected.length - 1];
	assert.ok(d.includes("report A") && d.includes("report B") && d.includes("report C"), "all three in the digest");
	assert.equal(core.mainUnreadCount(), 0);
});

await test("no reentrancy: starting a turn from inside the settle path does not recurse", async () => {
	const before = llmCalls.length;
	const beforeDeliver = deliverCount;
	mailToMain("reentrancy probe");
	settle();
	await settleWait();
	// hostIdle=false is set BEFORE injecting, so a nested settle/onEvent during the
	// injected turn must not re-enter deliverMainMail for the same mail.
	assert.equal(deliverCount - beforeDeliver, 1, "deliverMainMail ran exactly once");
	assert.equal(llmCalls.length - before, 1, "exactly one turn — no recursive/overlapping run");
});

await test("mail is NOT consumed while the host is busy (no premature commit)", async () => {
	hostIdle = false;
	mailToMain("pending while busy");
	deliverMainMail(); // gated: host not idle
	assert.equal(core.mainUnreadCount(), 1, "still pending — nothing drained or committed");
	settle();
	await settleWait();
	assert.equal(core.mainUnreadCount(), 0);
});

await test("shutdown does not start a stale turn", async () => {
	const before = llmCalls.length;
	shuttingDown = true;
	mailToMain("arrived during shutdown");
	settle();
	await settleWait();
	assert.equal(llmCalls.length - before, 0, "no turn started after shutdown");
	assert.equal(core.mainUnreadCount(), 1, "mail preserved for the next session (at-least-once)");
	shuttingDown = false;
});

await core.dispose();
console.log(`\nPhase 9 (auto-wake): ${passed} checks passed.`);
