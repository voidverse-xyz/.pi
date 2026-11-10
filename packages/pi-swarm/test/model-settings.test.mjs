import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { machine } from "./helpers.mjs";
import { reduceEvent } from "../extensions/swarm/state.mjs";
import { validateApproval } from "../extensions/swarm/approval-state.mjs";
import { PROVIDER_DATA_SCOPE } from "../extensions/swarm/provider-capability.mjs";
import { resolveModelSettings, effectiveWorkerSelection, providerAgreements } from "../extensions/swarm/model-settings.mjs";

const selection = { provider: "swarm-mock", modelId: "model", thinkingLevel: "medium" };
const native = modelId => ({ version: 1, transport: "pi-native", provider: "native", modelId, api: "responses", endpoint: null, outboundData: [...PROVIDER_DATA_SCOPE] });
const approval = (id, action = "configure", extra = {}) => ({ id, action, workspaceFingerprint: "a".repeat(64), specificationFingerprint: "b".repeat(64), existingChanges: "preserve", ...extra });
const code = expected => error => error.code === expected;

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
}
function configurePayload(state, chosen = selection, workerModels = []) {
	const spec = { objective: state.objective, criteria: state.criteria, scope: state.scope, limits: state.limits,
		model: chosen, codingTools: state.sessions.codingTools, instructions: state.sessions.instructions, workerModels };
	return { selection: chosen, workerModels, approval: approval("configure-1", "configure", {
		specificationFingerprint: createHash("sha256").update(JSON.stringify(canonical(spec))).digest("hex"),
	}) };
}
function configured() {
	const m = machine();
	m.send("owner", "sessions.configure", { selection, instructions: "", codingTools: [] });
	return m;
}

test("partial settings resolve against the pinned default and canonicalize worker overrides", () => {
	const result = resolveModelSettings({ thinkingLevel: "high" }, [
		{ workerId: "z", selection: { modelId: "other" } }, { workerId: "a", selection: {} },
	], selection);
	assert.deepEqual(result.model, { ...selection, thinkingLevel: "high" });
	assert.deepEqual(result.workerModels.map(entry => entry.workerId), ["a", "z"]);
	assert.equal(result.workerModels[1].selection.thinkingLevel, "high");
	assert.deepEqual(resolveModelSettings(undefined, undefined, selection, result.workerModels).workerModels, result.workerModels);
	assert.deepEqual(resolveModelSettings(undefined, [], selection, result.workerModels).workerModels, []);
	assert.deepEqual(effectiveWorkerSelection({ selection, workerModels: result.workerModels }, "z"), result.workerModels[1].selection);
	assert.equal(effectiveWorkerSelection({ selection }, "missing"), selection);
	for (const workerId of ["owner", "system", "../a", ""]) assert.throws(() => resolveModelSettings(undefined, [{ workerId, selection: {} }], selection), code("INPUT"));
	assert.throws(() => resolveModelSettings(undefined, [{ workerId: "a", selection: {} }, { workerId: "a", selection: {} }], selection), code("DUPLICATE"));
	assert.throws(() => resolveModelSettings({ arbitrary: true }, [], selection), code("INPUT"));
});

test("configure replaces agreements while continuation preserves all prior descriptors", () => {
	const prior = approval("launch", "launch", { provider: native("one"), providers: [native("one"), native("two")] });
	assert.deepEqual(providerAgreements(prior), prior.providers);
	assert.deepEqual(providerAgreements({ provider: prior.provider }), [prior.provider]);
	assert.deepEqual(providerAgreements({}), []);
	validateApproval(approval("change"), "configure", [prior]);
	assert.throws(() => validateApproval(approval("resume", "resume", { provider: native("one") }), "resume", [prior]), code("PROVIDER"));
	validateApproval(approval("resume", "resume", { provider: native("one"), providers: [...prior.providers] }), "resume", [prior]);
	assert.throws(() => validateApproval(approval("bad", "configure", { providers: [native("one"), native("one")] }), "configure"), code("PROVIDER"));
});

test("atomic configure preserves execution records and counters on paused and running runs", () => {
	for (const running of [false, true]) {
		const m = configured();
		m.start();
		m.task("existing-task");
		if (!running) {
			m.send("owner", "run.pause");
			m.send("system", "run.settle");
		}
		const before = structuredClone(m.state);
		const chosen = { ...selection, thinkingLevel: "high" };
		m.send("owner", "host.configure", configurePayload(m.state, chosen));
		assert.deepEqual(m.state.sessions.selection, chosen);
		for (const key of ["status", "cycle", "generation", "tasks", "completionEvidence", "workers"]) assert.deepEqual(m.state[key], before[key]);
		assert.equal(m.state.hostApprovals.at(-1).action, "configure");
		assert.equal(before.sessions.workerModels, undefined);
		assert.deepEqual(m.events.reduce(reduceEvent, null), m.state);
	}
});

test("configure rejects unsettled work, invalid agreements, stale fingerprints and extra schema fields atomically", () => {
	const m = configured();
	const before = structuredClone(m.state);
	const payload = configurePayload(m.state);
	for (const invalid of [{ ...payload, extra: true }, { ...payload, approval: approval("bad") }, { ...payload, selection: { ...selection, provider: "arbitrary" } }]) {
		assert.throws(() => m.send("owner", "host.configure", invalid));
		assert.deepEqual(m.state, before);
	}
	assert.throws(() => m.send("system", "host.configure", payload), code("AUTHORITY"));
	for (const [field, records] of [["sessions", { ...before.sessions, turns: [{ id: "turn" }] }], ["workspace", { operations: [{ id: "operation" }] }]]) {
		const state = { ...before, [field]: records };
		const event = { ...m.events.at(-1), type: "host.configure", payload, expectedRevision: state.revision, operationId: "reject" };
		assert.throws(() => reduceEvent(state, event), code("UNSETTLED"));
	}
});

test("configure validates native defaults and overrides against replacement descriptor collection", () => {
	const m = configured();
	const chosen = { provider: "native", modelId: "one", thinkingLevel: "high" };
	const workerModels = [{ workerId: "future", selection: { ...chosen, modelId: "two" } }];
	const payload = configurePayload(m.state, chosen, workerModels);
	payload.approval.providers = [native("one")];
	assert.throws(() => m.send("owner", "host.configure", payload), code("INPUT"));
	payload.approval.providers.push(native("two"));
	m.send("owner", "host.configure", payload);
	assert.deepEqual(m.state.sessions.workerModels, workerModels);
});

test("session configure adds overrides only in the explicit schema variant", () => {
	const m = machine();
	m.send("owner", "sessions.configure", { selection, instructions: "", codingTools: [], workerModels: [{ workerId: "future", selection }] });
	assert.deepEqual(m.state.sessions.workerModels, [{ workerId: "future", selection }]);
});
