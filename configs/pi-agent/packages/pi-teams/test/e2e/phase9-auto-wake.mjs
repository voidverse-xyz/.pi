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
import { createTestModelRuntime, EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { writeEnvelope } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));
// The REAL auto-wake policy + injection options, imported (never copied): stripping
// `triggerTurn` or breaking the hostIdle gating in production breaks this suite.
const { createWakePump } = await jiti.import(join(EXT, "mail/wake-pump.ts"));
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

const agentDir = join(home, ".pi", "agent");
const settingsManager = piSdk.SettingsManager.create(project, agentDir);
const { modelRuntime, modelRegistry } = await createTestModelRuntime(piSdk, {
	cwd: project,
	agentDir,
	settingsManager,
	providers: {
		mock: {
			baseUrl: "http://mock.invalid",
			apiKey: "test-key",
			api: "mock-api",
			streamSimple: mockStream,
			models: [{ id: "mock-1", name: "Mock One", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
		},
	},
});

const layout = createLayout(project, { home, sessionId: "sess-9" });
const core = createCore({ layout, modelRuntime, modelRegistry, settingsManager });

// A REAL main-agent session — the thing auto-wake must start a turn on.
const resolved = piSdk.resolveCliModel({ cliModel: "mock/mock-1", modelRuntime });
assert.ok(resolved.model, `model resolve failed: ${resolved.error}`);
const { session: mainSession } = await piSdk.createAgentSession({
	cwd: project,
	agentDir,
	modelRuntime,
	sessionManager: piSdk.SessionManager.create(project, agentDir),
	settingsManager,
	model: resolved.model,
	noTools: "builtin",
	customTools: [],
});

// ------------------------------------------- the REAL pump, wired as index.ts does
const injected = [];

// Port bound exactly as index.ts binds it: core for the digest, sendMessage+
// WAKE_DELIVERY for the injection — but against a real main AgentSession so the
// SDK's actual branch logic (and thus the auto-wake) is what gets exercised.
const pump = createWakePump({
	takeDigest: () => core.takeMainMailDigest(),
	inject: (digest) => {
		injected.push(digest);
		void mainSession.sendCustomMessage({ content: digest, customType: "teams-mail", display: true, details: undefined }, WAKE_DELIVERY);
	},
});

// The runtime's wake trigger, as wired in index.ts.
core.onEvent((event) => {
	if (event.type === "turn-finished" || event.type === "agent-retired") pump.onMailArrived();
});

/** Put a report from a subagent into main's mailbox (as the runtime would). */
function mailToMain(text) {
	writeEnvelope(layout.mainMailboxDir, makeEnvelope({ from: "worker/main", to: "main", type: "report", text }));
}

/** Pi's agent_settled → the REAL pump decides whether to drain. */
function settle() {
	pump.onSettled();
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
	pump.onBeforeAgentStart(); // host is mid-turn
	assert.equal(pump.hostIdle, false, "pump knows the host is busy");
	mailToMain("arrived mid-turn");
	pump.onMailArrived(); // the runtime event fires even while busy — must not drain
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
	const injectedBefore = injected.length;
	mailToMain("reentrancy probe");
	settle();
	await settleWait();
	// The pump flips hostIdle=false BEFORE injecting, so a nested settle/onMailArrived
	// during the injected turn must not drain the same mail twice.
	assert.equal(injected.length - injectedBefore, 1, "the pump injected exactly once");
	assert.equal(llmCalls.length - before, 1, "exactly one turn — no recursive/overlapping run");
	assert.equal(pump.hostIdle, false, "pump left the host marked busy after injecting");
});

await test("a re-entrant onMailArrived during injection cannot double-drain", async () => {
	// Directly attack the guard: pump from inside the port's own inject().
	let reentered = 0;
	const drains = [];
	const reentrantPump = createWakePump({
		takeDigest: () => {
			const digest = drains.length === 0 ? { digest: "D1", commit: () => drains.push("D1") } : null;
			return digest;
		},
		inject: () => {
			reentered++;
			reentrantPump.onMailArrived(); // re-enter mid-injection
		},
	});
	reentrantPump.onSettled();
	assert.equal(reentered, 1, "inject ran once — the re-entrant pump was gated by hostIdle=false");
	assert.deepEqual(drains, ["D1"], "committed exactly once");
});

await test("a failing injection does NOT consume the mail (commit strictly after inject)", async () => {
	// Locks the ordering: commit() must come AFTER inject(). If injection blows up,
	// the mail must survive for the next settle — at-least-once.
	let committed = 0;
	const boom = createWakePump({
		takeDigest: () => ({ digest: "D", commit: () => committed++ }),
		inject: () => {
			throw new Error("injection failed");
		},
	});
	assert.throws(() => boom.onSettled(), /injection failed/);
	assert.equal(committed, 0, "mail NOT committed when the injection threw");
});

await test("mail is NOT consumed while the host is busy (no premature commit)", async () => {
	pump.onInput(); // user typed → host busy
	mailToMain("pending while busy");
	pump.onMailArrived(); // gated by the REAL pump: host not idle
	assert.equal(core.mainUnreadCount(), 1, "still pending — nothing drained or committed");
	settle();
	await settleWait();
	assert.equal(core.mainUnreadCount(), 0);
});

await test("shutdown does not start a stale turn and preserves pending mail", async () => {
	const before = llmCalls.length;
	// A dedicated pump so the real shutdown() latch is exercised (it is one-way).
	const shutPump = createWakePump({
		takeDigest: () => core.takeMainMailDigest(),
		inject: (digest) => {
			injected.push(digest);
			void mainSession.sendCustomMessage({ content: digest, customType: "teams-mail", display: true, details: undefined }, WAKE_DELIVERY);
		},
	});
	shutPump.shutdown(); // session_shutdown
	mailToMain("arrived during shutdown");
	shutPump.onSettled(); // a settle racing teardown must not drain
	shutPump.onMailArrived();
	await settleWait();
	assert.equal(llmCalls.length - before, 0, "no turn started after shutdown");
	assert.equal(core.mainUnreadCount(), 1, "mail preserved for the next session (at-least-once)");
});

// ---------------------------------------------------- index.ts's event wiring
// The pump is unit-tested above; this closes the last gap by asserting index.ts
// actually maps Pi's lifecycle events onto it (e.g. agent_settled → onSettled).
console.log("index.ts wiring:");
await test("index.ts subscribes the auto-wake lifecycle events", async () => {
	const handlers = new Map();
	const stubPi = {
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event, handler) => handlers.set(event, handler),
		events: { emit: () => {}, on: () => {} },
		sendMessage: () => {},
	};
	const ext = await jiti.import(join(EXT, "index.ts"));
	(ext.default ?? ext)(stubPi);
	for (const event of ["input", "before_agent_start", "agent_settled", "session_shutdown", "session_start"]) {
		assert.ok(handlers.has(event), `index.ts must subscribe "${event}"; subscribed: ${JSON.stringify([...handlers.keys()])}`);
	}
});

await test("agent_settled (and ONLY agent_settled) drives a real drain through index.ts", async () => {
	// The full wiring, end to end: boot index.ts's real session_start against a temp
	// Pi agent directory, then drive the REAL lifecycle handlers and observe
	// pi.sendMessage.
	// This is what catches agent_settled being wired to the wrong pump callback.
	const handlers = new Map();
	const sent = [];
	const stubPi = {
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event, handler) => handlers.set(event, handler),
		events: { emit: () => {}, on: () => {} },
		sendMessage: (message) => sent.push(message),
	};
	const ext = await jiti.import(join(EXT, "index.ts"));
	(ext.default ?? ext)(stubPi);

	const wireHome = join(scratch, "wire-home");
	const wireAgentDir = join(wireHome, ".pi", "agent");
	const wireProject = join(scratch, "wire-project");
	mkdirSync(wireAgentDir, { recursive: true });
	mkdirSync(wireProject, { recursive: true });
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = wireAgentDir;
	try {
		const ctx = {
			cwd: wireProject,
			hasUI: false,
			mode: "cli",
			modelRegistry,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "wire-sess", getSessionFile: () => join(wireProject, "s.jsonl") },
			ui: { notify: () => {} },
		};
		await handlers.get("session_start")({ type: "session_start" }, ctx);

		// Mail for main, with the host NOT yet idle.
		const layoutW = createLayout(wireProject, { agentDir: wireAgentDir, sessionId: "wire-sess" });
		writeEnvelope(layoutW.mainMailboxDir, makeEnvelope({ from: "worker/main", to: "main", type: "report", text: "WIRED_REPORT" }));

		// input marks the host busy → must NOT drain.
		await handlers.get("input")({ type: "input" }, ctx);
		assert.equal(sent.length, 0, "input must not drain");

		// agent_settled marks it idle → MUST drain and inject.
		await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
		assert.equal(sent.length, 1, "agent_settled must drive exactly one injection");
		assert.ok(String(sent[0].content).includes("WIRED_REPORT"), "the injected digest carries the mail");
		assert.equal(sent[0].customType, "teams-mail");

		// shutdown latches: a later settle must not drain again.
		writeEnvelope(layoutW.mainMailboxDir, makeEnvelope({ from: "worker/main", to: "main", type: "report", text: "AFTER_SHUTDOWN" }));
		await handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
		await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
		assert.equal(sent.length, 1, "no injection after session_shutdown");
	} finally {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	}
});

await core.dispose();
console.log(`\nPhase 9 (auto-wake): ${passed} checks passed.`);
