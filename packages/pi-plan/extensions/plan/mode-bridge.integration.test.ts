import assert from "node:assert/strict";
import test from "node:test";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import planExtension from "./index.ts";
import { MODE_CHANGED_EVENT, QUERY_MODE_EVENT, type ModeSnapshot } from "./mode-bridge.ts";

type Handler = (event: unknown, ctx: ExtensionCommandContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

function fixture(initialMode = "off") {
	const events = createEventBus();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const snapshots: ModeSnapshot[] = [];
	const persisted: unknown[] = [];
	const order: string[] = [];
	let idle = true;
	let branchMode = initialMode;
	let activeTools = ["read", "bash"];
	let sessionId = "session-a";
	const tools = activeTools.map((name) => ({
		name, sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "temporary", origin: "top-level" },
	}));
	const ctx = {
		cwd: process.cwd(), hasUI: false, mode: "print",
		isIdle: () => idle,
		abort: () => { order.push("abort"); return Promise.resolve(); },
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "plan-mode.state", data: { mode: branchMode } }],
			getSessionId: () => sessionId,
		},
		ui: { setStatus: () => {}, notify: () => {} },
	} as unknown as ExtensionCommandContext;
	const pi = {
		events,
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerTool: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; order.push("tools"); },
		getAllTools: () => tools,
		appendEntry: (_type: string, state: unknown) => { persisted.push(state); },
	} as unknown as ExtensionAPI;
	events.on(MODE_CHANGED_EVENT, (data) => {
		snapshots.push(data as ModeSnapshot);
		order.push("snapshot");
	});
	planExtension(pi);
	return {
		events, snapshots, persisted, order, handlers,
		query() {
			let result: ModeSnapshot | undefined;
			events.emit(QUERY_MODE_EVENT, { version: 1, respond: (snapshot: ModeSnapshot) => { result = snapshot; } });
			assert.ok(result, "real event bus responds before emit returns");
			return result;
		},
		fire(name: string, event: unknown = {}) {
			const handler = handlers.get(name);
			assert.ok(handler, `registered ${name}`);
			return handler(event, ctx);
		},
		command(name: string, args: string) { return commands.get(name)!.handler(args, ctx); },
		setIdle(value: boolean) { idle = value; },
		setBranch(mode: string) { branchMode = mode; },
		setSession(id: string) { sessionId = id; },
		activeTools: () => activeTools,
	};
}

const preflight = { systemPrompt: "Base", systemPromptOptions: { skills: [] } };

test("factory queries before restore are unavailable and never persist state", () => {
	const f = fixture();
	assert.equal(f.query().ready, false);
	assert.equal(f.query().sessionId, null);
	assert.equal(f.snapshots.length, 0);
	assert.equal(f.persisted.length, 0);
	assert.equal(f.handlers.has("session_switch"), false);
	f.fire("session_start");
	assert.equal(f.query().ready, true);
	assert.equal(f.query().contextRevision, 1);
	assert.equal(f.persisted.length, 0);
});

test("busy restrictions publish synchronously before abort without altering run tools", async () => {
	const f = fixture();
	f.fire("session_start");
	f.fire("before_agent_start", preflight);
	f.setIdle(false);
	f.fire("agent_start");
	f.order.length = 0;
	await f.command("plan", "on");
	assert.deepEqual(f.order, ["snapshot", "abort"]);
	assert.equal(f.query().selectedMode, "plan");
	assert.equal(f.query().enforcedMode, "off");
	assert.equal(f.query().pendingChange, true);
	assert.deepEqual(f.activeTools(), ["read", "bash"]);
	f.setIdle(true);
	f.fire("agent_settled");
	assert.equal(f.query().enforcedMode, "plan");
	assert.equal(f.query().pendingChange, false);
	f.fire("agent_start");
	f.setIdle(false);
	await f.command("plan", "off");
	assert.equal(f.query().selectedMode, "off");
	assert.equal(f.query().enforcedMode, "plan");
	assert.equal(f.query().pendingChange, true);
	f.setIdle(true);
	f.fire("agent_settled");
	assert.equal(f.query().enforcedMode, "off");
	assert.deepEqual(f.activeTools(), ["read", "bash"]);
});

test("normal and fallback starts publish once and harmless Off runs keep the context epoch", () => {
	const f = fixture();
	f.fire("session_start");
	f.fire("before_agent_start", preflight);
	const startedRevision = f.query().revision;
	f.fire("agent_start");
	assert.equal(f.query().revision, startedRevision);
	f.fire("agent_settled");
	assert.equal(f.query().runMode, null);
	f.fire("agent_start");
	assert.equal(f.query().runMode, "off");
	f.fire("agent_settled");
	assert.ok(f.snapshots.every((snapshot) => snapshot.contextRevision === 1));
	assert.deepEqual(f.snapshots.map((snapshot) => snapshot.runMode), [null, "off", null, "off", null]);
});

test("overlapping preflights and settlement fallback never publish transient idle modes", async () => {
	const f = fixture("plan");
	f.fire("session_start");
	f.fire("before_agent_start", preflight);
	f.setIdle(false);
	await f.command("discuss", "on");
	f.fire("before_agent_start", preflight);
	await f.command("quick", "on");
	f.fire("agent_settled");
	assert.equal(f.query().runMode, "discuss");
	assert.equal(f.query().selectedMode, "quick");
	assert.equal(f.query().pendingChange, true);
	const beforeFallback = f.snapshots.length;
	f.fire("agent_settled");
	assert.equal(f.query().runMode, "quick");
	assert.equal(f.query().pendingChange, false);
	assert.equal(f.snapshots.length, beforeFallback + 1);
	assert.equal(f.snapshots.at(-1)!.runMode, "quick");
	f.setIdle(true);
	f.fire("agent_settled");
	assert.equal(f.query().runMode, null);
});

test("same-mode tree restore revokes context; shutdown becomes unavailable before cleanup", () => {
	const f = fixture();
	f.fire("session_start");
	f.fire("session_tree");
	assert.equal(f.query().contextRevision, 2);
	assert.equal(f.query().selectedMode, "off");
	f.setBranch("quick");
	f.fire("session_tree");
	assert.equal(f.query().selectedMode, "quick");
	assert.equal(f.query().contextRevision, 3);
	f.order.length = 0;
	f.fire("session_shutdown");
	assert.deepEqual(f.order, ["snapshot", "tools"]);
	assert.equal(f.query().ready, false);
	assert.equal(f.query().contextRevision, 4);
	assert.deepEqual(f.activeTools(), ["read", "bash"]);
	assert.equal(f.persisted.length, 0);
	const replacement = fixture("discuss");
	replacement.setSession("session-b");
	replacement.fire("session_start");
	assert.notEqual(replacement.query().instanceId, f.query().instanceId);
	assert.equal(replacement.query().sessionId, "session-b");
	assert.equal(replacement.query().selectedMode, "discuss");
});
