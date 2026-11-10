import {
	createAssistantMessageEventStream, createProvider, envApiKeyAuth, InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { assertProviderSelection, createProviderCapability } from "../extensions/swarm/provider-capability.mjs";
import { createNativeRuntime } from "../extensions/swarm/native-provider.mjs";
import { createNativeSwarmExtension } from "../extensions/swarm/extension.mjs";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { repository } from "./helpers.mjs";
import { guardNetwork } from "./network-guard.mjs";
import { SwarmHost } from "../extensions/swarm/host.mjs";

const context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
const specification = { objective: "Native offline integration", criteria: ["Public SDK delegation"], scope: ["Disposable fixture"] };
const approve = () => ({ approved: true, existingChanges: "preserve", reconciled: true });
const worker = { id: "worker", specialization: "Integration", brief: "Check native runtime", reason: "Initial verification" };
function bus() {
	const events = new EventEmitter();
	let mode = { version: 1, instanceId: "native-policy", revision: 1, contextRevision: 1, ready: true,
		sessionId: "owner1", selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false };
	events.on("pi-plan:query-mode", request => request.respond({ ...mode }));
	return { events, change(values) { mode = { ...mode, ...values, revision: mode.revision + 1 }; events.emit("pi-plan:mode-changed", { ...mode }); } };
}

async function fixture(script = () => ({ text: "Native fixture answer" }), registry = false) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("native-fixture", () => ({ type: "api_key", key: "memory-fixture-key" }));
	const source = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const model = { id: "native-model", name: "Native fixture", api: "openai-responses", provider: "native-fixture",
		baseUrl: "https://native.invalid/v1", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192,
		headers: { "X-Fixture": "host-configured" }, compat: { supportsDeveloperRole: true },
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
	const calls = [];
	const dispatch = (selected, transcript, options) => {
		const stream = createAssistantMessageEventStream();
		const call = { model: selected, context: transcript, options, index: calls.length };
		calls.push(call);
		const message = { role: "assistant", content: [], api: selected.api, provider: selected.provider, model: selected.id,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
			stopReason: "pending", timestamp: Date.now() };
		void (async () => {
			try {
				stream.push({ type: "start", partial: message });
				const step = await script(call);
				options.signal?.throwIfAborted();
				if (step.tool) {
					const toolCall = { type: "toolCall", id: `call-${call.index}`, name: "swarm_status", arguments: {} };
					message.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				} else {
					message.content.push({ type: "text", text: step.text });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: message });
				}
				message.stopReason = step.tool ? "toolUse" : "stop";
				stream.push({ type: "done", reason: message.stopReason, message });
			} catch (error) {
				message.stopReason = options.signal?.aborted ? "aborted" : "error";
				message.errorMessage = error.message;
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} finally { stream.end(); }
		})();
		return stream;
	};
	source.registerNativeProvider(createProvider({ id: model.provider, auth: { apiKey: envApiKeyAuth("Fixture", []) },
		models: [model], api: { stream: dispatch, streamSimple: dispatch } }));
	const mainModel = source.getModel(model.provider, model.id);
	const input = { ...(registry ? { modelRegistry: new ModelRegistry(source) } : { modelRuntime: source }), mainModel, thinkingLevel: "high" };
	const native = await createNativeRuntime(input);
	return { source, input, native, calls, bound: native.modelRuntime };
}

for (const registry of [false, true]) for (const method of ["stream", "streamSimple", "complete", "completeSimple"]) {
	test(`native ${registry ? "registry" : "runtime"} ${method} delegates public auth and options`, async t => {
		guardNetwork(t);
		const f = await fixture(undefined, registry);
		assert.equal(f.calls.length, 0);
		let headersSeen;
		const value = f.bound[method](f.native.mainModel, context, { reasoning: "high", headers: { "X-Request": "fixture" },
			transformHeaders(headers) { headersSeen = headers; return { ...headers, "X-Transform": "preserved" }; } });
		const result = await (value.result ? value.result() : value);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(result.usage.totalTokens, 15);
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0].options.apiKey, "memory-fixture-key");
		assert.equal(headersSeen["X-Fixture"], "host-configured");
		assert.equal(f.calls[0].options.headers["X-Transform"], "preserved");
		assert.equal(f.calls[0].options.headers["X-Request"], "fixture");
		assert.equal(f.calls[0].options.reasoning, "high");
		assert.equal(f.native.modelRuntime, f.source);
	});
}

test("native construction and factory do not create runtimes, resolve credentials or discover resources", async t => {
	guardNetwork(t);
	const f = await fixture();
	const original = ModelRuntime.create;
	ModelRuntime.create = () => { throw new Error("unexpected runtime creation"); };
	t.after(() => { ModelRuntime.create = original; });
	f.source.getAuth = () => { throw new Error("unexpected credential lookup"); };
	f.source.refresh = () => { throw new Error("unexpected discovery"); };
	const extension = await createNativeSwarmExtension(f.input);
	const handlers = new Map(); let command;
	extension({ registerMessageRenderer() {}, registerEntryRenderer() {}, registerTool() {}, on: (name, fn) => handlers.set(name, fn), registerCommand: (_name, value) => { command = value; } });
	await command.handler("status", { hasUI: false });
	await handlers.get("session_start")({ reason: "start" }, { sessionManager: { getEntries: () => [], getBranch: () => [] } });
	assert.equal(f.calls.length, 0);
});

test("native capabilities retain selection checks without wrapping the host runtime", async t => {
 guardNetwork(t);
 const f = await fixture();
 const selection = { provider: f.native.mainModel.provider, modelId: f.native.mainModel.id, thinkingLevel: "high" };
 assert.throws(() => assertProviderSelection(structuredClone(f.native.providerCapability), selection, f.native.modelRuntime), { code: "PROVIDER" });
 assert.equal(assertProviderSelection(f.native.providerCapability, selection, f.source).id, selection.modelId);
 assert.throws(() => assertProviderSelection(f.native.providerCapability, { ...selection, modelId: "wrong" }, f.source), { code: "PROVIDER" });
 await assert.rejects(createNativeRuntime({ modelRuntime: {}, mainModel: f.native.mainModel }), { code: "PROVIDER" });
 for (const endpoint of ["https://user:secret@example.com/", "https://example.com/?secret=x", "https://example.com/#secret"]) {
  assert.throws(() => createProviderCapability({ ...f.native.providerCapability.descriptor, endpoint }), { code: "PROVIDER" });
 }
 assert.equal(f.calls.length, 0);
});

test("native SDK follows tools, compacts and restores paused with fresh durable approvals", async t => {
	guardNetwork(t);
	const root = repository(t); const mode = bus(); const approvals = [];
	const f = await fixture(call => call.index === 0 ? { tool: true } : { text: "Native summary" });
	const options = { ...f.native, events: mode.events, sessionId: "owner1", tickIntervalMs: 0,
		requestApproval(request) { approvals.push(request); return approve(); } };
	const host = new SwarmHost(options);
	await host.launch({ workspace: root, runId: "run1", specification });
	await host.recruit(worker);
	host.wake("worker", "Decision context ".repeat(15000)); await host.idle();
	assert.equal(f.calls.length, 2, JSON.stringify(host.snapshot().driver));
	assert.ok(f.calls[1].context.messages.some(message => message.role === "toolResult"));
	host.wake("worker", "More context ".repeat(15000)); await host.idle();
	await host.compact("worker"); await host.idle();
	assert.equal(f.calls.length, 4, JSON.stringify(host.snapshot().driver));
	assert.ok(host.history("worker").some(entry => entry.type === "compaction"));
	assert.equal(host.snapshot().run.sessions.selection.thinkingLevel, "high");
	assert.ok(!JSON.stringify(host.snapshot()).includes("memory-fixture-key"));
	await host.close();
	const restored = new SwarmHost(options);
	await restored.restore({ workspace: root, runId: "run1" });
	assert.equal(f.calls.length, 4);
	assert.throws(() => restored.wake("worker"), { code: "HOST_DENIED" });
	await restored.resume(); restored.wake("worker"); await restored.idle();
	await restored.pause(); await restored.resume({ restart: true });
	assert.equal(restored.snapshot().run.cycle, 2);
	assert.deepEqual(approvals.map(value => value.action), ["launch", "resume", "restart"]);
	assert.equal(new Set(restored.snapshot().run.hostApprovals.map(value => value.id)).size, 3);
	assert.ok(approvals.every(value => value.provider.transport === "pi-native"));
	await restored.close();
});

for (const compaction of [false, true]) test(`native ${compaction ? "compaction" : "prompt"} abort retains SDK settlement and ownership`, async t => {
	guardNetwork(t);
	const root = repository(t); const mode = bus();
	let start, release;
	const ready = new Promise(resolve => { start = resolve; });
	const f = await fixture(call => {
		if (compaction && call.index < 2) return { text: "Prior context" };
		start(call);
		return new Promise(resolve => { release = () => resolve({ text: "Late result" }); });
	});
	const host = new SwarmHost({ ...f.native, events: mode.events, sessionId: "owner1", tickIntervalMs: 0, requestApproval: approve });
	await host.launch({ workspace: root, runId: "run1", specification }); await host.recruit(worker);
	if (compaction) {
		host.wake("worker", "Context ".repeat(25000)); await host.idle();
		host.wake("worker", "More context ".repeat(25000)); await host.idle();
	}
	const pending = compaction ? host.compact("worker") : host.wake("worker");
	const request = await ready;
	assert.equal((await host.pause({ timeoutMs: 5 })).settled, false);
	assert.equal(request.options.signal.aborted, true);
	assert.equal(host.snapshot().run.sessions.turns.length, 1);
	release(); await pending; await host.idle();
	assert.equal(host.snapshot().run.sessions.turns.length, 0);
	assert.ok(!host.history("worker").some(entry => entry.type === "compaction"));
	assert.throws(() => host.wake("worker"), { code: "HOST_DENIED" });
	await host.close();
});

test("native snapshot uses explicit thinking override and refuses virtual routing", async t => {
	guardNetwork(t);
	const f = await fixture();
	const selected = await createNativeRuntime({ ...f.input, override: { thinkingLevel: "low" } });
	assert.equal(selected.thinkingLevel, "low");
	f.input.mainModel = { ...f.input.mainModel, id: "other" };
	assert.equal(selected.mainModel.id, "native-model");
	await assert.rejects(createNativeRuntime(f.input), { code: "PROVIDER" });
	const model = f.source.getModel("native-fixture", "native-model");
	model.api = "pi-virtual";
	await assert.rejects(createNativeRuntime({ modelRuntime: f.source, mainModel: model }), { code: "PROVIDER" });
});

test("native metadata change during human approval denies launch before any request", async t => {
	guardNetwork(t);
	const root = repository(t); const mode = bus(); const f = await fixture();
	const host = new SwarmHost({ ...f.native, events: mode.events, sessionId: "owner1", tickIntervalMs: 0,
		requestApproval() { f.source.getModel("native-fixture", "native-model").headers.Changed = "routing"; return approve(); } });
	await assert.rejects(host.launch({ workspace: root, runId: "run1", specification }), { code: "PROVIDER" });
	assert.equal(host.snapshot().run, null); assert.equal(f.calls.length, 0);
	await host.close();
});

test("native runtime budget cancels an in-flight SDK request", async t => {
	guardNetwork(t);
	// The driver tick is intentionally unref'ed; emulate the live host event loop.
	const keepAlive = setInterval(() => {}, 1000);
	t.after(() => clearInterval(keepAlive));
	const root = repository(t); const mode = bus();
	const f = await fixture(call => new Promise(resolve => {
		call.options.signal.addEventListener("abort", () => resolve({ text: "Cancelled" }), { once: true });
	}));
	const host = new SwarmHost({ ...f.native, events: mode.events, sessionId: "owner1", tickIntervalMs: 5, requestApproval: approve });
	await host.launch({ workspace: root, runId: "run1", specification: { ...specification, limits: { durationMs: 500 } } });
	await host.recruit(worker); host.wake("worker"); await host.idle();
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].options.signal.aborted, true);
	assert.equal(host.snapshot().run.status, "paused");
	assert.equal(host.snapshot().run.sessions.turns.length, 0);
	await host.close();
});

test("native mode revocation prevents SDK tool follow-up and Off never renews approval", async t => {
	guardNetwork(t);
	const root = repository(t); const mode = bus();
	const f = await fixture(() => { mode.change({ selectedMode: "plan", enforcedMode: "plan" }); return { tool: true }; });
	const host = new SwarmHost({ ...f.native, events: mode.events, sessionId: "owner1", tickIntervalMs: 0, requestApproval: approve });
	await host.launch({ workspace: root, runId: "run1", specification }); await host.recruit(worker);
	host.wake("worker"); await host.idle();
	assert.equal(f.calls.length, 1);
	mode.change({ selectedMode: "off", enforcedMode: "off" });
	assert.throws(() => host.wake("worker"), { code: "HOST_DENIED" });
	await host.close();
});
