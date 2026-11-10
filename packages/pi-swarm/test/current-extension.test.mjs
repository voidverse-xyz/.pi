import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { repository } from "./helpers.mjs";
import { guardNetwork } from "./network-guard.mjs";
import { mainAgentAction } from "./main-agent-actions.mjs";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { SwarmError } from "../extensions/swarm/errors.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { atomicJson } from "../extensions/swarm/store/files.mjs";
import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCurrentSwarmExtension } from "../extensions/swarm/extension.mjs";
import { acquireLease, inspectLease } from "../extensions/swarm/store/lease.mjs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { InMemoryCredentialStore, createAssistantMessageEventStream, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";

async function fixture(t, { policy = true, entries = [], root, hold = false, settlement } = {}) {
	guardNetwork(t);
	const credentials = new InMemoryCredentialStore(); await credentials.modify("entry-fixture", () => ({ type: "api_key", key: "memory-fixture" }));
	const source = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const model = { id: "first", name: "Entry fixture", provider: "entry-fixture", api: "openai-responses", baseUrl: "https://entry.invalid/v1", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const calls = [], signals = [], providers = []; let auth = 0; const originalAuth = source.getAuth.bind(source); source.getAuth = (...args) => { auth++; return originalAuth(...args); };
	const contexts = [];
	const stream = (selected, _context, options) => {
		contexts.push(structuredClone(_context.messages));
		assert.equal(options.apiKey, "memory-fixture"); calls.push({ model: selected.id, reasoning: options.reasoning }); signals.push(options.signal); providers.push(selected.provider);
		const output = createAssistantMessageEventStream();
		const message = { role: "assistant", content: [{ type: "text", text: "Offline answer" }], api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		if (hold) void (async () => { if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true })); message.stopReason = "aborted"; output.push({ type: "error", reason: "aborted", error: message }); output.end(); })();
		else if (settlement) void (async () => {
			await Promise.race([settlement, new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }))]);
			if (options.signal.aborted) { message.stopReason = "aborted"; output.push({ type: "error", reason: "aborted", error: message }); }
			else output.push({ type: "done", reason: "stop", message });
			output.end();
		})();
		else { output.push({ type: "done", reason: "stop", message }); output.end(); } return output;
	};
	source.registerNativeProvider(createProvider({ id: model.provider, models: [model, { ...model, id: "second" }], auth: { apiKey: envApiKeyAuth("Fixture", []) }, api: { stream, streamSimple: stream } }));
	await credentials.modify("entry-other", () => ({ type: "api_key", key: "memory-fixture" }));
	source.registerNativeProvider(createProvider({ id: "entry-other", models: [{ ...model, provider: "entry-other", id: "review-model", baseUrl: "https://entry-other.invalid/v1" }], auth: { apiKey: envApiKeyAuth("Fixture", []) }, api: { stream, streamSimple: stream } }));
	const events = new EventEmitter(), handlers = new Map(), notices = [], replies = [];
	if (policy) events.on("pi-plan:query-mode", request => request.respond({ version: 1, instanceId: "entry-policy", revision: 1, contextRevision: 1, ready: true, sessionId: "owner1", selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false }));
	let slash; let thinking = "high"; const terminalListeners = new Set(), statuses = new Map(); let editorText = "";
	const dialog = () => assert.fail("Swarm-owned modal dialog forbidden");
	const ctx = { cwd: root ?? repository(t), mode: "tui", hasUI: true, model: undefined, isIdle: () => true, modelRegistry: new ModelRegistry(source),
		sessionManager: { getSessionId: () => "owner1", getSessionFile: () => "owner.jsonl", getEntries: () => entries, getBranch: () => entries },
		ui: { custom: dialog, input: dialog, select: dialog, confirm: dialog, notify: text => notices.push(text),
			onTerminalInput: listener => { terminalListeners.add(listener); return () => terminalListeners.delete(listener); }, getEditorText: () => editorText, setEditorText: text => { editorText = text; }, setStatus: (key, value) => statuses.set(key, value) } };
	const tools = new Map(), messages = [], renderers = new Map(), updates = [];
	const pi = { registerMessageRenderer: (type, renderer) => renderers.set(type, renderer), registerEntryRenderer: (type, renderer) => renderers.set(type, renderer), registerTool: tool => tools.set(tool.name, tool), sendMessage: (message, options) => messages.push({ message, options }), events, on: (name, fn) => handlers.set(name, fn), registerCommand: (_name, value) => { slash = value; }, getThinkingLevel: () => thinking, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
	assert.equal(createCurrentSwarmExtension()(pi), undefined);
	const event = (name, data = {}) => handlers.get(name)?.(data, ctx), input = text => event("input", { source: "interactive", text });
	const update = value => updates.push(value.content[0].text), tool = (name, args, signal) => tools.get(name).execute("call", args, signal, update, ctx);
	const consume = p => tool(p.action === "start" ? "swarm_start" : "swarm_control", { ...(p.action === "start" ? {} : { action: p.action }), proposalId: p.proposalId });
	const command = text => mainAgentAction(tools, ctx, text, update, async p => { const reply = replies.shift(); await input(typeof reply === "function" ? await reply(p) : reply ?? (p.action === "reconcile" ? "I confirm settlement: Independently verified all listed execution stopped" : "start")); });
	t.after(() => event("session_shutdown"));
	return { tools, tool, consume, input, command, updates, messages, renderers, ctx, source, calls, contexts, signals, providers, replies, entries, event, events, notices, terminalListeners, statuses, auth: () => auth,
		terminal: data => { for (const listener of terminalListeners) { const result = listener(data); if (result) return result; } }, select(id) { ctx.model = source.getModel(model.provider, id); }, thinking(value) { thinking = value; },
		slash: args => slash.handler(args, ctx), status: async () => { await command("status"); return notices.at(-1).startsWith("{") ? JSON.parse(notices.at(-1)) : { status: "unattached" }; } };
}
async function until(predicate) { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail("Worker did not settle"); }

test("normal entry registers synchronously without model/auth; status and history are inert", async t => {
	const f = await fixture(t); assert.deepEqual([...f.tools.keys()], ["swarm_start", "swarm_wait", "swarm_status", "swarm_control", "swarm_history"]);
	for (const name of ["swarm_status", "swarm_history", "swarm_status"]) assert.equal((await f.tool(name, {})).details.status, "unattached");
	assert.equal(f.auth(), 0); assert.equal(f.calls.length, 0); await assert.rejects(f.command("start goal")); f.select("first"); f.ctx.sessionManager.getSessionFile = () => undefined; await assert.rejects(f.command("start goal")); assert.equal(f.auth(), 0);
});
for (const missing of [false, true]) test(`stale storage runtime refuses launch before approval or mutation (missing check=${missing})`, async t => {
	const f = await fixture(t); f.select("first");
	const original = SwarmController.assertStorageRuntime;
	if (missing) {
		SwarmController.assertStorageRuntime = undefined;
		t.after(() => { SwarmController.assertStorageRuntime = original; });
	} else t.mock.method(SwarmController, "assertStorageRuntime", () => { throw new SwarmError("RUNTIME_STALE", "Private underlying diagnostic must not escape"); });
	const result = await f.tool("swarm_start", { objective: "No live retry" });
	assert.equal(result.isError, true);
	assert.equal(result.details.diagnostic.code, "RUNTIME_STALE");
	assert.match(result.details.error, /cold-start it and resume this same session/);
	assert.doesNotMatch(result.details.error, /Private underlying diagnostic/);
	assert.equal(result.details.awaitingConfirmation, undefined);
	assert.equal(result.details.pendingAuthorization, undefined);
	assert.equal(result.details.status, "unattached");
	assert.equal(existsSync(prepareLayout(f.ctx.cwd, "probe").stateRoot), false);
	assert.equal(f.entries.length, 0);
	assert.equal(f.auth(), 0);
	assert.equal(f.calls.length, 0);
});

test("stale-runtime fencing preserves emergency stop and refuses continuation before approval", async t => {
	const f = await fixture(t, { hold: true }); f.select("first");
	await f.command("start bounded offline objective");
	await until(() => f.calls.length === 1);
	const runId = (await f.tool("swarm_status", {})).details.runId;
	t.mock.method(SwarmController, "assertStorageRuntime", () => { throw new SwarmError("RUNTIME_STALE", "Stale test runtime"); });
	const stopped = await f.tool("swarm_control", { action: "stop" });
	assert.equal(stopped.isError, undefined);
	assert.equal(stopped.details.status, "stopped");
	assert.deepEqual(stopped.details.unsettled, { turns: 0, operations: 0, assignments: 0 });
	const journal = prepareLayout(f.ctx.cwd, runId).journalPath;
	const bytes = readFileSync(journal, "utf8");
	for (const action of ["resume", "restart", "recover"]) {
		const result = await f.tool("swarm_control", { action });
		assert.equal(result.isError, true);
		assert.equal(result.details.diagnostic.code, "RUNTIME_STALE");
		assert.equal(result.details.awaitingConfirmation, undefined);
		assert.equal(result.details.runId, runId);
		assert.equal(readFileSync(journal, "utf8"), bytes);
	}
	assert.equal(f.calls.length, 1);
});

test("native launch waits for owner chat but never blocks a tool or asks a modal", async t => {
	const f = await fixture(t, { hold: true }); f.select("first");
	const result = await f.tool("swarm_start", { objective: "Approved fixture goal" }), p = result.details;
	assert.equal(result.isError, undefined); assert.equal(p.awaitingConfirmation, true); assert.equal(f.auth(), 0); assert.equal(f.calls.length, 0);
	assert.match(f.updates[0], /^Inspecting Swarm workspace before approval/); assert.match(p.agreement, /^Swarm approval packet: LAUNCH \(Pi native provider\)/);
	assert.match(p.agreement, /Selected coding tools are authorized/); assert.match(result.content[0].text, /Type start to proceed with this Swarm configuration\./);
	await f.input("start"); assert.equal((await f.consume(p)).details.status, "running"); await until(() => f.calls.length === 1);
	assert.equal((await f.tool("swarm_status", {})).details.status, "running"); const auth = f.auth();
	assert.equal((await f.tool("swarm_history", { workerId: "planner", limit: 1 })).details.persistedOnly, true); assert.equal(f.auth(), auth);
	assert.deepEqual(f.messages, [], "Routine launch progress stays passive"); assert.ok(f.messages.every(item => item.options.triggerTurn === false));
	const stop = await f.tool("swarm_control", { action: "stop" }); assert.equal(stop.details.status, "stopped"); assert.equal(stop.details.unsettled.turns, 0);
});
for (const text of ["yes", "confirm", "YES!", "Start", "START", " start", "start ", "start\n", "start\r\n", "start.", "start!", "start now", '"start"']) test(`native launch rejects nonexact approval ${JSON.stringify(text)}`, async t => {
	const f = await fixture(t); f.select("first");
	const p = (await f.tool("swarm_start", { objective: "Never approved" })).details;
	await f.input(text);
	assert.equal((await f.consume(p)).isError, true);
	await f.input("start"); assert.equal((await f.consume(p)).isError, true);
	assert.equal(f.auth(), 0); assert.equal(f.calls.length, 0);
	assert.equal(existsSync(prepareLayout(f.ctx.cwd, "run1").stateRoot), false);
});
test("missing and unconfirmed proposals return actionable distinct diagnostics without dispatch", async t => {
	const f = await fixture(t); f.select("first");
	const p = (await f.tool("swarm_start", { objective: "Current proposal" })).details;
	const unconfirmed = await f.consume(p);
	assert.equal(unconfirmed.details.diagnostic.code, "PROPOSAL_UNCONFIRMED");
	assert.match(unconfirmed.details.error, /explicit owner confirmation/);
	await f.input("not approval");
	const revoked = await f.consume(p);
	assert.equal(revoked.details.diagnostic.code, "PROPOSAL_REQUIRED");
	assert.match(revoked.details.error, /Prepare a fresh proposal/);
	assert.equal(f.auth(), 0);
	assert.equal(f.calls.length, 0);
});
test("literal complete agreement renders at narrow widths without expansion", async t => {
	const f = await fixture(t); f.select("first");
	const objective = '**literal** `name` [label](https://example.invalid/full/destination) \\path\\file\nnext "quoted" ``` fence 界';
	const p = (await f.tool("swarm_start", { objective })).details, content = p.agreement;
	const packet = JSON.parse(content.slice(content.indexOf("{\n"), content.indexOf("\nProvider agreement"))); assert.equal(packet.objective, objective);
	assert.ok(content.includes("Existing changes:") && content.includes('"transport": "pi-native"'));
	for (const expanded of [false, true]) { const component = f.renderers.get("swarm-agreement")({ content }, { expanded }, {}); assert.ok(component instanceof Text);
		for (const width of [12, 24, 60, 80, 120]) { const lines = component.render(width); assert.ok(lines.every(line => visibleWidth(line) <= width)); assert.equal(lines.join("").replace(/\s/g, ""), content.replace(/\s/g, "")); }
	} assert.equal(f.auth(), 0);
});
test("agreement and main tool renderers sanitize controls and never collapse packet lines", async t => {
	const f = await fixture(t), text = Array.from({ length: 60 }, (_, i) => `packet-line-${i}`).join("\n") + "\n\x1b[2J\u202eend";
	for (const name of ["swarm_start", "swarm_control"]) { const view = f.tools.get(name).renderResult({ content: [{ type: "text", text }], details: {} }, { expanded: false, isPartial: true }, { fg: (_color, line) => line }); const rendered = view.render(80).map(line => line.trimEnd()).join("\n"); for (let i = 0; i < 60; i++) assert.ok(rendered.includes(`packet-line-${i}`)); assert.ok(rendered.endsWith("\\u001b[2J\\u202eend")); }
	const rendered = f.renderers.get("swarm-agreement")({ content: "\x1b[2J\x9b31m\r\u202eend" }).render(100).join("\n"); assert.match(rendered, /\\u001b\[2J\\u009b31m\\u000d\\u202eend/);
});
for (const refusal of ["owner", "session-file", "registry", "cwd", "rpc", "stop", "mode", "reload", "changed-file", "prompt", "custom-prompt"])  test(`pending native start rejects ${refusal} context drift`, async t => {
	const f = await fixture(t); f.select("first"); writeFileSync(join(f.ctx.cwd, "user.txt"), "Preserve me"); const root = f.ctx.cwd;
	const p = (await f.tool("swarm_start", { objective: "Never approved" })).details; assert.equal(p.awaitingConfirmation, true);
	if (refusal === "owner") f.ctx.sessionManager.getSessionId = () => "foreign";
	if (refusal === "session-file") f.ctx.sessionManager.getSessionFile = () => "other.jsonl"; if (refusal === "registry") f.ctx.modelRegistry = new ModelRegistry(f.source); if (refusal === "cwd") f.ctx.cwd = join(root, "other"); if (refusal === "rpc") f.ctx.mode = "rpc";
	if (refusal === "stop") await f.command("stop"); if (refusal === "mode") f.events.emit("pi-plan:mode-changed", { version: 1, instanceId: "entry-policy", revision: 2, contextRevision: 1, ready: true, sessionId: "owner1", selectedMode: "plan", enforcedMode: "plan", runMode: null, pendingChange: false });
	if (refusal === "reload") await f.event("session_shutdown"); if (refusal === "changed-file") writeFileSync(join(root, "user.txt"), "Changed"); if (refusal === "prompt" || refusal === "custom-prompt") await f.event("ui_prompt_start", { kind: refusal === "prompt" ? "select" : "custom" });
	await f.input("start"); assert.equal((await f.consume(p)).isError, true); assert.equal(f.auth(), 0); assert.equal(f.calls.length, 0); assert.equal(existsSync(prepareLayout(root, "run1").stateRoot), false);
});
test("proposal preserves exact provider implementation binding across chat turns", async t => {
	const f = await fixture(t); f.select("first"); const p = (await f.tool("swarm_start", { objective: "goal" })).details;
	const previous = f.source.stream; f.source.stream = (...args) => previous.apply(f.source, args); await f.input("start");
	assert.equal((await f.consume(p)).isError, true); assert.equal(f.auth(), 0); assert.equal(f.calls.length, 0);
});
test("tool cancellation consumes approval permanently and makes no auth calls", async t => {
	const f = await fixture(t); f.select("first"); const p = (await f.tool("swarm_start", { objective: "goal" })).details; await f.input("start");
	const signal = new AbortController(); signal.abort(); assert.equal((await f.tool("swarm_start", { proposalId: p.proposalId }, signal.signal)).isError, true);
	await f.command("pause"); assert.equal((await f.consume(p)).isError, true); assert.equal(f.auth(), 0);
});
test("aborting a completed proposal turn revokes it but a fresh proposal can launch", async t => {
	const f = await fixture(t, { hold: true }); f.select("first");
	const turn = new AbortController();
	const cancelled = (await f.tool("swarm_start", { objective: "Cancelled proposal turn" }, turn.signal)).details;
	assert.equal(cancelled.awaitingConfirmation, true);
	turn.abort();
	await f.input("start");
	assert.equal((await f.consume(cancelled)).isError, true);
	assert.equal(f.auth(), 0);
	assert.equal(f.calls.length, 0);

	const fresh = (await f.tool("swarm_start", { objective: "Fresh approved proposal" })).details;
	assert.equal(fresh.awaitingConfirmation, true);
	await f.input("start");
	assert.equal((await f.consume(fresh)).details.status, "running");
	await until(() => f.calls.length === 1);
	const stopped = await f.tool("swarm_control", { action: "stop" });
	assert.equal(stopped.details.status, "stopped");
	assert.deepEqual(stopped.details.unsettled, { turns: 0, operations: 0, assignments: 0 });
});
test("non-Git launch and continuation preserve the project without setup/disposition dialogs", async t => {
	const root = mkdtempSync(join(tmpdir(), "swarm-chat-")); t.after(() => rmSync(root, { recursive: true, force: true })); writeFileSync(join(root, "user.txt"), "Preserve me"); writeFileSync(join(root, ".gitignore"), "# rules\r\n", { mode: 0o640 });
	const f = await fixture(t, { root, hold: true, policy: false }); f.select("first"); await f.command("start Fixture \u001b[31m \u202e goal"); await until(() => f.calls.length === 1);
	assert.ok(f.updates.every(text => !/[\x1b\u202e]/.test(text))); assert.equal(readFileSync(join(root, "user.txt"), "utf8"), "Preserve me"); assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "# rules\r\n"); assert.equal(existsSync(join(root, ".git")), false);
	await f.command("pause"); for (const action of ["resume", "restart"]) { await f.command(action); await until(() => f.calls.length === (action === "resume" ? 2 : 3)); await f.command("pause"); }
	f.replies.push("no"); await assert.rejects(f.command("resume")); assert.equal(f.calls.length, 3);
});
test("cancelled non-Git proposal never creates runtime state", async t => {
	const root = mkdtempSync(join(tmpdir(), "swarm-plain-")); t.after(() => rmSync(root, { recursive: true, force: true })); writeFileSync(join(root, "source.txt"), "preserve\n");
	const f = await fixture(t, { root, policy: false }); f.select("first"); f.replies.push("no"); await assert.rejects(f.command("start goal")); assert.deepEqual(readdirSync(root), ["source.txt"]); assert.equal(existsSync(prepareLayout(root, "run1").stateRoot), false); assert.equal(f.auth(), 0);
});
test("normal entry captures current model/thinking after cancellation and pins it on continuation", async t => {
	const f = await fixture(t); f.select("first"); f.replies.push("no"); await assert.rejects(f.command("start cancelled")); f.select("second"); f.thinking("low");
	await f.command("start current selection"); await until(() => f.calls.length === 1); assert.deepEqual(f.calls[0], { model: "second", reasoning: "low" }); await f.command("pause"); f.select("first"); await f.event("model_select"); await f.command("resume"); await until(() => f.calls.length === 2); assert.equal(f.calls[1].model, "second");
});
for (const event of ["model_select", "thinking_level_select"]) test(`${event} leaves pending, confirmed and running Swarm selections pinned`, async t => {
	const f = await fixture(t, { hold: true }); f.select("first");
	const p = (await f.tool("swarm_start", { objective: "goal" })).details;
	f.select("second"); f.thinking("low"); await f.event(event);
	await f.input("start"); f.select("first"); f.thinking("off"); await f.event(event);
	assert.equal((await f.consume(p)).isError, undefined); await until(() => f.calls.length === 1);
	assert.deepEqual(f.calls[0], { model: "first", reasoning: "high" });
	f.select("second"); f.thinking("low"); await f.event(event);
	assert.equal((await f.status()).status, "running"); assert.equal(f.signals[0].aborted, false);
	assert.deepEqual((await f.tool("swarm_status", {})).details.model, { provider: "entry-fixture", modelId: "first", thinkingLevel: "high" });
	await f.command("pause"); await f.command("resume"); await until(() => f.calls.length === 2);
	assert.deepEqual(f.calls[1], { model: "first", reasoning: "high" });
});
test("reload restores paused with no auth; fork stays unattached", async t => {
	const f = await fixture(t); f.select("first"); await f.command("start goal"); await until(() => f.calls.length === 1); await f.event("session_shutdown");
	const next = await fixture(t, { entries: f.entries, root: f.ctx.cwd }); next.select("first"); await next.event("session_start", { reason: "reload" }); assert.equal((await next.status()).status, "paused"); assert.equal(next.auth(), 0); assert.equal(next.calls.length, 0); await next.command("stop"); await next.event("session_shutdown");
	const fork = await fixture(t, { entries: f.entries, root: f.ctx.cwd }); fork.select("first"); await fork.event("session_start", { reason: "fork" }); assert.equal((await fork.status()).status, "unattached");
});
test("same-session vetoed navigation regains observation on explicit continuation", async t => {
	const f = await fixture(t, { hold: true }); f.select("first"); await f.command("start goal"); await until(() => f.calls.length === 1); assert.deepEqual(await f.event("session_before_switch"), { cancel: false }); await f.command("resume"); await until(() => f.calls.length === 2); assert.deepEqual(f.messages, [], "Continuation progress stays passive");
});
test("cancelled no-run preparation does not strand a different session", async t => {
	const f = await fixture(t, { policy: false }); f.select("first"); await f.tool("swarm_start", { objective: "old" }); await f.event("session_before_switch"); f.ctx.sessionManager.getSessionId = () => "other-owner"; await f.event("session_start"); assert.equal((await f.tool("swarm_start", { objective: "new" })).details.awaitingConfirmation, true); assert.equal(f.auth(), 0);
});
test("raw emergency stop cancels pending chat proposal and late start cannot dispatch", async t => {
	const f = await fixture(t); f.select("first"); await f.event("session_start"); const p = (await f.tool("swarm_start", { objective: "goal" })).details;
	for (const key of "/swarm stop") assert.equal(f.terminal(key), undefined); assert.deepEqual(f.terminal("\r"), { consume: true }); await until(() => f.notices.some(text => text.startsWith("Swarm stopped."))); await f.input("start"); assert.equal((await f.consume(p)).isError, true); assert.equal(f.ctx.ui.getEditorText(), ""); assert.equal(f.calls.length, 0);
});
test("raw and slash emergency stop settle native work despite external dialog focus", async t => {
	const f = await fixture(t, { hold: true }); f.select("first"); await f.event("session_start"); await f.command("start goal"); await until(() => f.calls.length === 1); await f.event("ui_prompt_start", { kind: "select" }); assert.deepEqual(f.terminal("/swarm stop\r"), { consume: true }); await until(() => f.notices.some(text => text.startsWith("Swarm stopped.")));
	assert.equal((await f.status()).status, "stopped"); await f.slash("stop"); assert.equal(f.calls.length, 1); await f.event("session_start"); assert.equal(f.terminalListeners.size, 1); await f.event("session_shutdown"); assert.equal(f.terminalListeners.size, 0);
});
test("independent launch default and per-worker override are disclosed before any request", async t => {
	const f = await fixture(t); f.select("first");
	const p = (await f.tool("swarm_start", {
		objective: "Different worker settings", model: { thinkingLevel: "medium" },
		workerModels: [{ workerId: "planner", selection: { modelId: "second", thinkingLevel: "low" } }]
	})).details;
	assert.equal(p.awaitingConfirmation, true); assert.equal(f.auth(), 0);
	assert.match(p.agreement, /All approved worker providers\/models/);
	assert.match(p.agreement, /"workerId": "planner"/);
	await f.input("start"); assert.equal((await f.consume(p)).isError, undefined);
	await until(() => f.calls.length === 1);
	assert.deepEqual(f.calls[0], { model: "second", reasoning: "low" });
	const status = (await f.tool("swarm_status", {})).details;
	assert.deepEqual(status.model, { provider: "entry-fixture", modelId: "first", thinkingLevel: "medium" });
	assert.deepEqual(status.workers[0].model, { provider: "entry-fixture", modelId: "second", thinkingLevel: "low" });
});

test("a different worker provider is disclosed and remains independently pinned", async t => {
	const f = await fixture(t); f.select("first");
	const p = (await f.tool("swarm_start", { objective: "Independent provider", workerModels: [{ workerId: "planner", selection: { provider: "entry-other", modelId: "review-model", thinkingLevel: "medium" } }] })).details;
	assert.equal(f.auth(), 0); assert.match(p.agreement, /https:\/\/entry-other.invalid\/v1/);
	assert.match(p.agreement, /"provider": "entry-fixture"/); assert.match(p.agreement, /"provider": "entry-other"/);
	await f.input("start"); assert.equal((await f.consume(p)).isError, undefined);
	await until(() => f.calls.length === 1); assert.equal(f.providers[0], "entry-other");
	assert.deepEqual(f.calls[0], { model: "review-model", reasoning: "medium" });
	const settings = (await f.tool("swarm_control", { action: "configure", workerModels: [] })).details;
	await f.input("start"); assert.equal((await f.consume(settings)).isError, undefined);
	assert.equal((await f.tool("swarm_control", { action: "send", to: "planner", text: "Continue with the default" })).isError, undefined);
	await until(() => f.calls.length === 2); assert.equal(f.providers[1], "entry-fixture");
	assert.deepEqual(f.calls[1], { model: "first", reasoning: "high" });
});

test("cancelled or stale settings proposals leave the existing model unchanged", async t => {
	const f = await fixture(t); f.select("first"); await f.command("start goal");
	await until(() => f.calls.length === 1);
	let p = (await f.tool("swarm_control", { action: "configure", model: { modelId: "second" } })).details;
	await f.input("no"); assert.equal((await f.consume(p)).isError, true);
	assert.equal((await f.tool("swarm_status", {})).details.model.modelId, "first");
	p = (await f.tool("swarm_control", { action: "configure", model: { modelId: "second" } })).details;
	await f.input("start"); writeFileSync(join(f.ctx.cwd, "changed.txt"), "External modification");
	const stale = await f.consume(p); assert.equal(stale.isError, true); assert.equal(stale.details.diagnostic.code, "STALE");
	assert.equal((await f.tool("swarm_status", {})).details.model.modelId, "first");
});

test("stop cancels a pending model-change drain without granting new settings", async t => {
	const f = await fixture(t, { hold: true }); f.select("first"); await f.command("start goal");
	await until(() => f.calls.length === 1);
	const configure = f.tool("swarm_control", { action: "configure", model: { modelId: "second" } });
	await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.signals[0].aborted, false);
	assert.equal((await f.tool("swarm_control", { action: "stop" })).isError, undefined);
	assert.equal((await configure).isError, true);
	const status = (await f.tool("swarm_status", {})).details;
	assert.equal(status.status, "stopped"); assert.equal(status.model.modelId, "first");
	assert.equal(status.unsettled.turns, 0);
});

test("paused configuration does not resume execution", async t => {
	const f = await fixture(t); f.select("first"); await f.command("start goal");
	await until(() => f.calls.length === 1); await f.command("pause");
	const p = (await f.tool("swarm_control", { action: "configure", model: { modelId: "second", thinkingLevel: "medium" } })).details;
	await f.input("start"); assert.equal((await f.consume(p)).isError, undefined);
	assert.equal((await f.tool("swarm_status", {})).details.status, "paused"); assert.equal(f.calls.length, 1);
	await f.command("resume"); await until(() => f.calls.length === 2);
	assert.deepEqual(f.calls[1], { model: "second", reasoning: "medium" });
});

test("user-requested configure requires fresh consent and preserves worker history and budgets", async t => {
	const f = await fixture(t); f.select("first"); await f.command("start goal");
	await until(() => f.calls.length === 1);
	const before = (await f.tool("swarm_status", {})).details;
	const history = (await f.tool("swarm_history", { workerId: "planner" })).details;
	const p = (await f.tool("swarm_control", { action: "configure", model: { modelId: "second", thinkingLevel: "low" } })).details;
	assert.equal(p.awaitingConfirmation, true); assert.equal(f.calls.length, 1);
	assert.equal((await f.tool("swarm_status", {})).details.model.modelId, "first");
	assert.equal((await f.consume(p)).isError, true, "a tool call alone cannot approve settings");
	await f.input("start"); assert.equal((await f.consume(p)).isError, undefined);
	const changed = (await f.tool("swarm_status", {})).details;
	assert.equal(changed.status, "running"); assert.equal(changed.cycle, before.cycle);
	assert.deepEqual(changed.model, { provider: "entry-fixture", modelId: "second", thinkingLevel: "low" });
	assert.equal((await f.tool("swarm_history", { workerId: "planner" })).details.total, history.total);
	assert.equal((await f.tool("swarm_control", { action: "send", to: "planner", text: "Continue with the requested settings" })).isError, undefined);
	await until(() => f.calls.length === 2); assert.deepEqual(f.calls[1], { model: "second", reasoning: "low" });
});

test("configuration waits for an active turn without aborting its provider", async t => {
	let settle; const settlement = new Promise(resolve => { settle = resolve; });
	const f = await fixture(t, { settlement }); f.select("first"); await f.command("start goal");
	await until(() => f.calls.length === 1);
	let finished = false;
	const preparing = f.tool("swarm_control", { action: "configure", workerModels: [{ workerId: "planner", selection: { modelId: "second", thinkingLevel: "off" } }] }).then(result => { finished = true; return result; });
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.equal(finished, false); assert.equal(f.signals[0].aborted, false);
	settle(); const p = (await preparing).details; assert.equal(p.awaitingConfirmation, true);
	assert.equal(f.signals[0].aborted, false);
	await f.input("start"); const configured = await f.consume(p); assert.equal(configured.isError, undefined, configured.details.error);
	assert.equal((await f.tool("swarm_control", { action: "send", to: "planner", text: "Use the approved override" })).isError, undefined);
	await until(() => f.calls.length === 2); assert.deepEqual(f.calls[1], { model: "second", reasoning: undefined });
});

test("restore after changed or absent main selection retains configured default and overrides", async t => {
	const first = await fixture(t, { policy: false }); first.select("first");
	const launch = (await first.tool("swarm_start", { objective: "goal", workerModels: [{ workerId: "planner", selection: { modelId: "second", thinkingLevel: "low" } }] })).details;
	await first.input("start"); assert.equal((await first.consume(launch)).isError, undefined);
	await until(() => first.calls.length === 1); await first.event("session_shutdown");
	const next = await fixture(t, { policy: false, entries: first.entries, root: first.ctx.cwd });
	await next.event("session_start", { reason: "reload" });
	const status = (await next.tool("swarm_status", {})).details;
	assert.equal(status.status, "paused"); assert.equal(status.model.modelId, "first");
	assert.equal(status.workers[0].model.modelId, "second"); assert.equal(next.auth(), 0);
	next.select("second"); next.thinking("off"); await next.command("resume");
	await until(() => next.calls.length === 1); assert.deepEqual(next.calls[0], { model: "second", reasoning: "low" });
});

for (const model of [{ modelId: "missing" }, { thinkingLevel: "unsupported" }, { provider: "unknown", modelId: "first" }]) test(`invalid independent selection ${JSON.stringify(model)} cannot authorize execution`, async t => {
	const f = await fixture(t); f.select("first");
	assert.equal((await f.tool("swarm_start", { objective: "goal", model })).isError, true);
	assert.equal(f.auth(), 0); assert.equal(f.calls.length, 0);
});

test("linked guided recovery inspects before attaching and works without a main model", async t => {
	const first = await fixture(t, { policy: false }); first.select("first");
	await first.command("start linked recovery"); await until(() => first.calls.length === 1);
	await first.event("session_shutdown");
	const runId = first.entries[0].data.runId, layout = prepareLayout(first.ctx.cwd, runId);
	acquireLease(layout, { ownerSessionId: "owner1" });
	atomicJson(join(layout.ownerPath, "owner.json"), { ...inspectLease(layout), pid: null });
	const before = readFileSync(layout.journalPath);
	const next = await fixture(t, { policy: false, entries: first.entries, root: first.ctx.cwd });
	await next.event("session_start", { reason: "reload" });
	const p = (await next.tool("swarm_control", { action: "recover" })).details;
	assert.equal(p.awaitingConfirmation, true); assert.deepEqual(readFileSync(layout.journalPath), before);
	assert.equal(next.auth(), 0); assert.equal(next.calls.length, 0);
	await next.input("I confirm recovery: independently verified that all previous commands and processes stopped");
	const recovered = await next.consume(p);
	assert.equal(recovered.isError, undefined, recovered.details.error);
	assert.equal(recovered.details.status, "paused"); assert.equal(recovered.details.recovery.ownershipHeld, true);
	assert.equal(recovered.details.model.modelId, "first"); assert.equal(next.auth(), 0); assert.equal(next.calls.length, 0);
});

test("restore by run ID adopts paused in another session without dispatch", async t => {
	const first = await fixture(t, { policy: false }); first.select("first"); await first.command("start goal"); await until(() => first.calls.length === 1); const runId = first.entries[0].data.runId; await first.event("session_shutdown");
	const next = await fixture(t, { policy: false, root: first.ctx.cwd }); next.select("first"); next.ctx.sessionManager.getSessionId = () => "second-owner"; await next.command(`restore ${runId}`); assert.equal((await next.tool("swarm_status", {})).details.runId, runId); assert.equal(next.calls.length, 0); next.replies.push("no"); await assert.rejects(next.command("resume")); await next.command("resume"); await until(() => next.calls.length === 1);
});
test("stale lease recovery requires owner evidence and revalidates exact lease", async t => {
	const f = await fixture(t, { policy: false }), layout = prepareLayout(f.ctx.cwd, "crashed"); acquireLease(layout, { ownerSessionId: "owner1" }); const lease = inspectLease(layout); atomicJson(join(layout.ownerPath, "owner.json"), { ...lease, pid: null });
	let p = (await f.tool("swarm_control", { action: "reconcile", runId: "crashed" })).details; assert.match(p.agreement, /owner1/); await f.input("start"); assert.equal((await f.consume(p)).isError, true); assert.ok(inspectLease(layout));
	p = (await f.tool("swarm_control", { action: "reconcile", runId: "crashed" })).details; await f.input("I confirm settlement: independently checked all previous controller commands and processes stopped"); assert.equal((await f.consume(p)).isError, undefined); assert.equal(inspectLease(layout), null); assert.equal(f.auth(), 0);
});
for (const leaseOwner of ["foreign-owner", null]) test(`stale controller lease with owner ${leaseOwner} cannot be released from this session`, async t => {
	const f = await fixture(t, { policy: false }), layout = prepareLayout(f.ctx.cwd, "foreign-crash"); acquireLease(layout, { ownerSessionId: leaseOwner }); const expected = inspectLease(layout); atomicJson(join(layout.ownerPath, "owner.json"), { ...expected, pid: null });
	const result = await f.tool("swarm_control", { action: "reconcile", runId: "foreign-crash" }); assert.equal(result.isError, true); assert.equal(result.details.diagnostic.code, "OWNERSHIP");
	await f.input("I confirm settlement: independently checked all processes stopped"); assert.deepEqual(inspectLease(layout), { ...expected, pid: null }); assert.equal(f.auth(), 0); assert.equal(f.calls.length, 0);
});
test("restore/recovery reject invalid IDs at the tool boundary", async t => { const f = await fixture(t, { policy: false }); f.select("first"); for (const args of [{ action: "restore" }, { action: "restore", runId: "../escape" }, { action: "reconcile", runId: "../escape" }]) assert.equal((await f.tool("swarm_control", args)).isError, true); assert.equal(f.calls.length, 0); });
test("failure diagnostics are safe and approval cannot be supplied in tool fields", async t => {
	const f = await fixture(t, { policy: false }); assert.deepEqual((await f.tool("swarm_start", { objective: "goal" })).details.diagnostic, { code: "MODEL", phase: "setup", message: "Select an available physical model before starting." }); f.select("first"); assert.equal((await f.tool("swarm_start", { objective: "goal", approved: true })).isError, true);
	const { registerMainTools } = await import("../extensions/swarm/main-tools.mjs"); const tools = new Map(); registerMainTools({ registerTool: tool => tools.set(tool.name, tool) }, { chatControl: async () => { throw new Error("provider token /private/path \x1b[2J"); } }); const r = await tools.get("swarm_start").execute("call", {}, undefined, undefined, {}); assert.deepEqual(r.details.diagnostic, { code: "FAILED", phase: "setup", message: "The Swarm operation failed; inspect status before continuing." }); assert.equal(JSON.stringify(r).includes("private/path"), false);
});
test("main sends worker/board mail only within its approved team; mail is never chat consent", async t => {
	const f = await fixture(t, { policy: false }); f.select("first"); assert.equal((await f.tool("swarm_control", { action: "send", to: "planner", text: "Before approval" })).isError, true); await f.command("start team"); await until(() => f.calls.length === 1);
	assert.equal((await f.tool("swarm_control", { action: "send", to: "planner", text: "Focused follow-up", topic: "Review" })).isError, undefined); assert.equal((await f.tool("swarm_control", { action: "send", to: "board", text: "Shared finding", topic: "Review" })).isError, undefined);
	const page = await f.tool("swarm_history", { channel: "messages", topic: "Review", limit: 1 }); assert.equal(page.details.total, 2); assert.equal(page.details.nextOffset, 1); await f.command("pause"); assert.equal((await f.tool("swarm_control", { action: "send", to: "planner", text: "Paused" })).isError, true);
	const p = (await f.tool("swarm_control", { action: "resume" })).details; await f.event("input", { source: "extension", text: "start" }); assert.equal((await f.consume(p)).isError, true);
});
test("mail renderer shows semantic conversation without private protocol fields", async t => {
	const f = await fixture(t), view = f.renderers.get("swarm-agent-mail")({ content: "INTERNAL_CONTEXT", details: { runId: "PRIVATE_RUN", messageIds: ["PRIVATE_ID"], messages: [{ from: "builder", to: "main", text: "Please review \x1b[2J", topic: "Auth", cycle: 1 }] } }, { expanded: false }, { fg: (_role, value) => value, bg: (_role, value) => value });
	const text = view.render(80).join("\n"); assert.match(text, /builder → Main agent.*Auth/); assert.match(text, /Please review this|Please review/); assert.doesNotMatch(text, /INTERNAL_CONTEXT|PRIVATE_RUN|PRIVATE_ID|cycle/);
});


for (const [mode, percent, expected] of [[undefined, 10, "fork"], ["focus", 10, "focus"], ["fork", 80, "fork"], [undefined, 30, "focus"]]) {
	test(`main-selected Swarm context ${mode ?? "auto"} at ${percent}% is disclosed and pinned through approval`, async t => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const f = await fixture(t); f.select("first");
		const parent = SessionManager.inMemory(f.ctx.cwd);
		parent.appendMessage({ role: "user", content: "PINNED_PARENT_CONTEXT_DETAIL", timestamp: 1 });
		f.ctx.getContextUsage = () => ({ percent });
		f.ctx.sessionManager.buildSessionProjection = () => parent.buildSessionProjection();
		f.ctx.sessionManager.getLeafId = () => parent.getLeafId();
		const proposal = (await f.tool("swarm_start", { objective: "Inspect approved worker context", ...(mode ? { contextMode: mode } : {}) })).details;
		assert.equal(proposal.awaitingConfirmation, true);
		assert.match(proposal.agreement, new RegExp(`"mode": "${expected}"`));
		if (expected === "fork") assert.match(proposal.agreement, /inspected main-chat snapshot will be sent as background/);
		assert.doesNotMatch(proposal.agreement, /PINNED_PARENT_CONTEXT_DETAIL/, "approval shows metadata, not a second transcript dump");
		assert.equal(f.calls.length, 0);
		parent.appendMessage({ role: "user", content: "LATER_OWNER_MESSAGE_NOT_IN_APPROVED_SNAPSHOT", timestamp: 2 });
		await f.input("start"); assert.equal((await f.consume(proposal)).isError, undefined);
		await until(() => f.calls.length === 1);
		assert.equal(JSON.stringify(f.contexts[0]).includes("PINNED_PARENT_CONTEXT_DETAIL"), expected === "fork");
		assert.doesNotMatch(JSON.stringify(f.contexts[0]), /LATER_OWNER_MESSAGE_NOT_IN_APPROVED_SNAPSHOT/);
		const status = (await f.tool("swarm_status", {})).details;
		assert.equal(status.context.mode, expected); assert.equal(status.context.requested, mode ?? "auto");
		assert.doesNotMatch(JSON.stringify(status), /PINNED_PARENT_CONTEXT_DETAIL/);
	});
}
