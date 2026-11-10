import test from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { repository } from "./helpers.mjs";
import { createMockRuntime } from "./sdk-env.mjs";
import { SwarmHost } from "../extensions/swarm/host.mjs";
import { reduceEvent } from "../extensions/swarm/state.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import { openJournal } from "../extensions/swarm/store/journal.mjs";
import { createProviderCapability, PROVIDER_DATA_SCOPE } from "../extensions/swarm/provider-capability.mjs";

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const approve = () => ({ approved: true, reconciled: true, attestation: { kind: "user-established-settlement", evidence: "Fixture has no remaining sessions or processes" } });
async function orphanFixture(t, approval = approve, withProvider = false) {
	const root = repository(t); const mock = await createMockRuntime([]); const events = new EventEmitter();
	events.on("pi-plan:query-mode", request => request.respond({ version: 1, instanceId: "mode1", revision: 1, contextRevision: 1, ready: true, sessionId: "owner1", selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false }));
	const providerCapability = withProvider ? createProviderCapability({ version: 1, provider: mock.model.provider, modelId: mock.model.id, api: mock.model.api,
		endpoint: mock.model.baseUrl, transport: "scripted-memory", outboundData: [...PROVIDER_DATA_SCOPE] }) : undefined;
	const make = ask => new SwarmHost({ events, sessionId: "owner1", modelRuntime: mock.modelRuntime, mainModel: mock.model, providerCapability, requestApproval: ask, tickIntervalMs: 0 });
	const first = make(approve);
	await first.launch({ workspace: root, runId: "run1", specification: { objective: "Goal", criteria: ["Result"], scope: ["src"] } });
	await first.recruit({ id: "builder", specialization: "Build", brief: "Build approved work", reason: "Independent work" });
	await first.close();
	// Simulate journaled interrupted execution on a safely closed fixture only.
	// No controller lease is stolen or deleted, and no real process is inferred dead.
	let state = first.snapshot().run;
	const journal = openJournal(join(prepareLayout(root, "run1").stateRoot, "run1", "events.jsonl"), () => {});
	const append = (actor, type, payload) => {
		const event = { version: 1, operationId: randomUUID(), actor, type, payload, expectedRevision: state.revision, cycle: state.cycle, generation: state.generation, atMs: state.lastAtMs };
		state = reduceEvent(state, event); journal.append(event);
	};
	append("owner", "run.resume", { reconciled: true });
	append("system", "session.turn.start", { id: "turn1", workerId: "builder", kind: "prompt", messageIds: [], guidanceRevision: 0 });
	append("builder", "task.create", { id: "task1", title: "Implement", criteria: [0], dependencies: [] });
	append("builder", "task.claim", { taskId: "task1", kind: "build", assignmentId: "assignment1" });
	append("system", "workspace.start", { id: "execution1", taskId: "task1", assignmentId: "assignment1", kind: "shell", command: "never replay this", paths: [], before: state.workspace.fingerprint });
	journal.close();
	const host = make(approval);
	await host.restore({ workspace: root, runId: "run1" });
	return { root, mock, host, make };
}

test("host restores orphan execution fenced, records user evidence, and retires without replay", async t => {
	const f = await orphanFixture(t);
	assert.equal(f.host.snapshot().run.status, "pausing");
	await assert.rejects(f.host.resume(), { code: "STATE" });
	assert.deepEqual(await f.host.reconcile(), { settled: true });
	const state = f.host.snapshot().run;
	assert.equal(state.status, "paused");
	assert.equal(state.workspace.receipts[0].outcome, "unknown");
	assert.equal(state.sessions.history[0].outcome, "interrupted");
	assert.equal(state.settlementAttestations[0].authority, "user-established-settlement");
	assert.equal(state.tasks[0].assignment, null);
	assert.equal(f.mock.calls.length, 0);
	await f.host.resume(); assert.equal(f.host.snapshot().run.cycle, 1);
	await f.host.close();
});

for (const answer of [{ approved: true, settled: true }, { approved: true, attestation: { kind: "user-established-settlement", evidence: "" } }, { approved: true, attestation: { kind: "process-missing", evidence: "No PID" } }]) {
	test("bare or malformed settlement assertions cannot retire orphan intent", async t => {
		let valid = false;
		const f = await orphanFixture(t, request => valid ? approve(request) : answer);
		await assert.rejects(f.host.reconcile(), { code: "UNSETTLED" });
		assert.equal(f.host.snapshot().run.workspace.operations.length, 1);
		assert.equal(f.host.snapshot().run.settlementAttestations, undefined);
		valid = true; await f.host.reconcile(); await f.host.close();
	});
}

for (const action of ["cancel", "drift", "revision"]) {
	test(`reconciliation ${action} race preserves orphan intent`, async t => {
		const shown = deferred(); const answer = deferred(); let delayed = true;
		const f = await orphanFixture(t, request => { if (!delayed) return approve(request); shown.resolve(request); return answer.promise; });
		const reconciliation = assert.rejects(f.host.reconcile()); const request = await shown.promise;
		if (action === "cancel") await f.host.pause({ timeoutMs: 10 });
		if (action === "drift") writeFileSync(join(f.root, "external-work"), "preserve");
		if (action === "revision") await f.host.redirect("Updated guidance during recovery");
		answer.resolve(approve(request)); await reconciliation;
		assert.equal(f.host.snapshot().run.workspace.operations.length, 1);
		delayed = false; await f.host.reconcile(); await f.host.close();
	});
}

test("provider implementation failure does not block settlement-only reconciliation", async t => {
	const f = await orphanFixture(t, approve, true);
	const stream = f.mock.modelRuntime.streamSimple;
	f.mock.modelRuntime.streamSimple = () => { throw new Error("Replacement must never execute"); };
	assert.deepEqual(await f.host.reconcile(), { settled: true });
	assert.equal(f.mock.calls.length, 0);
	await assert.rejects(f.host.resume(), { code: "PROVIDER" });
	f.mock.modelRuntime.streamSimple = stream;
	await f.host.close();
});

test("failed shutdown retains ownership and host reconciliation access", async t => {
	const f = await orphanFixture(t);
	await assert.rejects(f.host.close(), { code: "UNSETTLED" });
	await assert.rejects(SwarmController.open({ workspace: f.root, runId: "run1", ownerSessionId: "owner1" }));
	await f.host.reconcile();
	await f.host.close();
	const c = await SwarmController.open({ workspace: f.root, runId: "run1", ownerSessionId: "owner1" });
	assert.equal(c.snapshot().status, "paused"); await c.close();
});

test("pause during durable attestation does not release uncertain evidence", async t => {
	const f = await orphanFixture(t); const entered = deferred(); const release = deferred();
	const original = SwarmController.prototype.owner;
	t.after(() => { SwarmController.prototype.owner = original; });
	SwarmController.prototype.owner = async function(type, ...args) {
		const value = await original.call(this, type, ...args);
		if (type === "host.attest") { entered.resolve(); await release.promise; }
		return value;
	};
	const rejected = assert.rejects(f.host.reconcile(), { code: "CANCELLED" }); await entered.promise;
	const pause = f.host.pause({ timeoutMs: 10 }); release.resolve(); await rejected; await pause;
	assert.equal(f.host.snapshot().run.workspace.operations.length, 1);
	SwarmController.prototype.owner = original;
	await f.host.reconcile(); await f.host.close();
});
