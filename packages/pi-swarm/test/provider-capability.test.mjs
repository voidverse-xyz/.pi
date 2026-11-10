import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import {
	assertProviderSelection, createProviderCapability, PROVIDER_DATA_SCOPE, providerDescriptor, validateProviderDescriptor,
} from "../extensions/swarm/provider-capability.mjs";
import test from "node:test";
import { guardNetwork } from "./network-guard.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repository } from "./helpers.mjs";
import { createMockRuntime } from "./sdk-env.mjs";
import { SwarmHost } from "../extensions/swarm/host.mjs";
import { validateApproval } from "../extensions/swarm/approval-state.mjs";

const descriptor = () => ({ version: 1, provider: "swarm-mock", modelId: "scripted", api: "swarm-mock",
	endpoint: "https://swarm-mock.invalid", transport: "scripted-memory", outboundData: [...PROVIDER_DATA_SCOPE] });
const spec = { objective: "Offline readiness", criteria: ["Validated binding"], scope: ["Disposable fixture"] };
const approve = () => ({ approved: true, existingChanges: "preserve", reconciled: true });

function bus() {
	const events = new EventEmitter();
	let mode = { version: 1, instanceId: "provider1", revision: 1, contextRevision: 1, ready: true,
		sessionId: "owner1", selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false };
	events.on("pi-plan:query-mode", request => request.respond({ ...mode }));
	return { events, change(values) { mode = { ...mode, ...values, revision: mode.revision + 1 }; events.emit("pi-plan:mode-changed", { ...mode }); } };
}


test("provider descriptors are strict, detached, immutable, and cannot be deserialized as capabilities", () => {
	const input = descriptor();
	const cap = createProviderCapability(input);
	input.modelId = "changed"; input.outboundData.pop();
	assert.equal(providerDescriptor(cap).modelId, "scripted");
	assert.throws(() => cap.descriptor.outboundData.pop(), TypeError);
	assert.throws(() => providerDescriptor(structuredClone(cap)), { code: "PROVIDER" });
	for (const patch of [{ version: 2 }, { token: "not-allowed" }, { headers: {} }, { outboundData: [] },
		{ endpoint: "https://elsewhere.invalid" }, { transport: "trusted-runtime" }, { api: "openai-responses" }]) {
		assert.throws(() => createProviderCapability({ ...descriptor(), ...patch }), { code: "PROVIDER" });
	}
});

test("model, API, endpoint, headers, routing and sampling substitutions are denied", () => {
	const cap = createProviderCapability(descriptor());
	const selection = { provider: "swarm-mock", modelId: "scripted" };
	const model = { provider: "swarm-mock", id: "scripted", api: "swarm-mock", baseUrl: descriptor().endpoint };
	for (const patch of [{ id: "other" }, { provider: "other" }, { api: "other" }, { baseUrl: "https://other.invalid" },
		{ headers: {} }, { samplingParams: { model: "other" } }, { compat: {} }]) {
		assert.throws(() => assertProviderSelection(cap, selection, { getModel: () => ({ ...model, ...patch }) }), { code: "PROVIDER" });
	}
	assert.throws(() => assertProviderSelection(cap, { ...selection, modelId: "other" }, { getModel() { throw new Error("must not resolve"); } }), { code: "PROVIDER" });
});

test("approval replay refuses omitted or replaced provider agreements", () => {
	const first = { id: "approval1", action: "launch", existingChanges: "clean", workspaceFingerprint: "a".repeat(64), specificationFingerprint: "b".repeat(64), provider: descriptor() };
	validateApproval(first, "launch");
	const next = { ...first, id: "approval2", action: "resume" };
	validateApproval(next, "resume", [first]);
	const omitted = { ...next }; delete omitted.provider;
	assert.throws(() => validateApproval(omitted, "resume", [first]), { code: "PROVIDER" });
	assert.throws(() => validateApproval({ ...next, provider: { ...descriptor(), modelId: "other" } }, "resume", [first]), { code: "PROVIDER" });
});

test("offline SDK launch, resume, restart, mode revocation and restore retain fresh provider agreements", async t => {
	guardNetwork(t);
	const root = repository(t);
	const mock = await createMockRuntime(() => ({ text: "Scripted readiness result" }));
	const mode = bus();
	const cap = createProviderCapability(descriptor());
	const requests = [];
	const options = { events: mode.events, sessionId: "owner1", modelRuntime: mock.modelRuntime, mainModel: mock.model,
		providerCapability: cap, tickIntervalMs: 0, requestApproval(request) { requests.push(request); return approve(); } };
	const host = new SwarmHost(options);
	await host.launch({ workspace: root, runId: "run1", specification: spec });
	await host.recruit({ id: "worker", specialization: "Readiness", brief: "Check offline flow", reason: "Initial check" });
	host.wake("worker"); await host.idle();
	assert.equal(mock.calls.length, 1);
	await host.pause();
	assert.throws(() => host.wake("worker"), { code: "HOST_DENIED" });
	await host.resume();
	mode.change({ selectedMode: "plan", enforcedMode: "plan" });
	await host.idle();
	mode.change({ selectedMode: "off", enforcedMode: "off" });
	assert.throws(() => host.wake("worker"), { code: "HOST_DENIED" });
	await host.resume({ restart: true });
	assert.equal(host.snapshot().run.cycle, 2);
	assert.deepEqual(requests.map(request => request.action), ["launch", "resume", "restart"]);
	for (const request of requests) assert.deepEqual(request.provider, descriptor());
	const approvals = host.snapshot().run.hostApprovals;
	assert.equal(new Set(approvals.map(item => item.id)).size, 3);
	for (const approval of approvals) assert.deepEqual(approval.provider, descriptor());
	await host.close();
	const restored = new SwarmHost(options);
	await restored.restore({ workspace: root, runId: "run1" });
	assert.throws(() => restored.wake("worker"), { code: "HOST_DENIED" });
	await restored.resume();
	assert.equal(requests.length, 4);
	await restored.close();
});

test("missing native model fails before approval or storage", async t => {
	guardNetwork(t);
	const root = repository(t);
	const mode = bus();
	let reads = 0; let approvals = 0;
	const cap = createProviderCapability({ ...descriptor(), provider: "example", api: "openai-responses", transport: "pi-native", endpoint: "https://example.invalid/v1" });
	const host = new SwarmHost({ events: mode.events, sessionId: "owner1", providerCapability: cap,
		mainModel: { provider: "example", id: "scripted" }, modelRuntime: { getModel() { reads++; return undefined; } },
		requestApproval() { approvals++; return approve(); } });
	await assert.rejects(host.launch({ workspace: root, runId: "run1", specification: spec }), { code: "PROVIDER" });
	assert.equal(reads, 1); assert.equal(approvals, 0);
	assert.equal(existsSync(join(prepareLayout(root, "run1").stateRoot)), false);
	await host.close();
});

test("recorded provider agreement cannot be restored without its host capability", async t => {
	guardNetwork(t);
	const root = repository(t); const mode = bus(); const mock = await createMockRuntime([]);
	const options = { events: mode.events, sessionId: "owner1", modelRuntime: mock.modelRuntime, mainModel: mock.model,
		tickIntervalMs: 0, requestApproval: approve };
	const host = new SwarmHost({ ...options, providerCapability: createProviderCapability(descriptor()) });
	await host.launch({ workspace: root, runId: "run1", specification: spec });
	await host.close();
	const restored = new SwarmHost(options);
	await assert.rejects(restored.restore({ workspace: root, runId: "run1" }), { code: "PROVIDER" });
	assert.equal(mock.calls.length, 0);
	await restored.close();
});

test("approval answers cannot replace provider bindings or revive cancellation", async t => {
	guardNetwork(t);
	const root = repository(t); const mode = bus(); const mock = await createMockRuntime([]);
	let answer = () => ({ ...approve(), provider: descriptor() });
	const host = new SwarmHost({ events: mode.events, sessionId: "owner1", modelRuntime: mock.modelRuntime, mainModel: mock.model,
		providerCapability: createProviderCapability(descriptor()), tickIntervalMs: 0, requestApproval: request => answer(request) });
	const launch = () => host.launch({ workspace: root, runId: "run1", specification: spec });
	await assert.rejects(launch(), { code: "PROVIDER" });
	let release; let presented;
	const seen = new Promise(resolve => { presented = resolve; });
	answer = request => { presented(request); return new Promise(resolve => { release = resolve; }); };
	const pending = assert.rejects(launch(), { code: "CANCELLED" });
	const request = await seen;
	const paused = host.pause();
	assert.equal(request.signal.aborted, true);
	release(approve()); await pending; await paused;
	assert.equal(existsSync(join(prepareLayout(root, "run1").stateRoot)), false);
	assert.equal(mock.calls.length, 0);
	await host.close();
});

for (const substitution of ["endpoint", "implementation"]) test(`${substitution} substitution revokes an approved host before another worker dispatch`, async t => {
	guardNetwork(t);
	const root = repository(t); const mode = bus();
	const mock = await createMockRuntime([]);
	const host = new SwarmHost({ events: mode.events, sessionId: "owner1", modelRuntime: mock.modelRuntime, mainModel: mock.model,
		providerCapability: createProviderCapability(descriptor()), tickIntervalMs: 0, requestApproval: approve });
	await host.launch({ workspace: root, runId: "run1", specification: spec });
	const method = substitution === "endpoint" ? "getModel" : "streamSimple";
	const original = mock.modelRuntime[method];
	mock.modelRuntime[method] = substitution === "endpoint"
		? (...args) => ({ ...original.apply(mock.modelRuntime, args), baseUrl: "https://changed.invalid" })
		: () => { throw new Error("Replacement must never execute"); };
	assert.throws(() => host.wake("worker"), { code: "PROVIDER" });
	mock.modelRuntime[method] = original;
	await host.idle();
	assert.throws(() => host.wake("worker"), { code: "HOST_DENIED" });
	assert.equal(mock.calls.length, 0);
	await host.close();
});
