import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { repository } from "./helpers.mjs";
import { createMockRuntime } from "./sdk-env.mjs";
import { SwarmHost } from "../extensions/swarm/host.mjs";
import { SwarmSessions } from "../extensions/swarm/sessions.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { reduceEvent } from "../extensions/swarm/state.mjs";
import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import { openJournal } from "../extensions/swarm/store/journal.mjs";

const approve = () => ({ approved: true, attestation: { kind: "user-established-settlement", evidence: "Fixture sessions and execution have independently settled" } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, { stale = false, terminalIntent, exhausted = false, quietTerminal = false } = {}) {
	const root = repository(t);
	const mock = await createMockRuntime([]);
	const events = new EventEmitter();
	const make = (ask, sessionId = "owner1") => new SwarmHost({ events, sessionId, modelRuntime: mock.modelRuntime, mainModel: mock.model, requestApproval: ask, tickIntervalMs: 0 });
	const first = make(approve);
	await first.launch({ workspace: root, runId: "run1", specification: { objective: "Goal", criteria: ["Result"], scope: ["src"] } });
	await first.recruit({ id: "builder", specialization: "Build", brief: "Build work", reason: "Independent work" });
	await first.close();
	let state = first.snapshot().run;
	const layout = prepareLayout(root, "run1");
	const journal = openJournal(layout.journalPath, () => {});
	const append = (actor, type, payload, atMs = state.lastAtMs) => {
		const event = { version: 1, operationId: randomUUID(), actor, type, payload, expectedRevision: state.revision, cycle: state.cycle, generation: state.generation, atMs };
		state = reduceEvent(state, event); journal.append(event);
	};
	if (quietTerminal) {
		if (terminalIntent === "stop") append("owner", "run.stop", {});
		else append("system", "run.fail", { reason: "Fixture failure" });
	} else {
		if (exhausted) append("owner", "limits.update", { limits: { ...state.limits, durationMs: state.elapsedMs + 1 } });
		append("owner", "run.resume", { reconciled: true });
		append("system", "session.turn.start", { id: "turn1", workerId: "builder", kind: "prompt", messageIds: [], guidanceRevision: 0 });
		append("builder", "task.create", { id: "task1", title: "Implement", criteria: [0], dependencies: [] });
		append("builder", "task.claim", { taskId: "task1", kind: "build", assignmentId: "assignment1" });
		append("system", "workspace.start", { id: "execution1", taskId: "task1", assignmentId: "assignment1", kind: "shell", command: "never replay", paths: [], before: state.workspace.fingerprint });
		if (terminalIntent === "stop") append("owner", "run.stop", {});
		if (terminalIntent === "fail") append("system", "run.fail", { reason: "Fixture failure" });
		if (exhausted) append("system", "run.tick", {}, state.lastAtMs + 1);
	}
	journal.close();
	if (stale) {
		// Safely closed fixture; no live lease is stolen and no dead PID is guessed.
		mkdirSync(layout.ownerPath, { mode: 0o700 });
		writeFileSync(join(layout.ownerPath, "owner.json"), JSON.stringify({ version: 1, token: "fixture-closed", runId: "run1", pid: null, ownerSessionId: "owner1" }), { mode: 0o600 });
	}
	return { root, layout, state, make, mock };
}

for (const resume of [false, true]) test(`guided recovery ${resume ? "resumes" : "stays paused"} with exactly one approval and no replay`, async t => {
	const f = await fixture(t, { stale: true });
	const requests = [];
	const host = f.make(request => { requests.push(request); return approve(); });
	const result = await host.recover({ workspace: f.root, runId: "run1", resume });
	assert.equal(requests.length, 1);
	assert.equal(requests[0].action, "recover");
	assert.equal(requests[0].recovery.outcome, resume ? "resume" : "paused");
	assert.equal(requests[0].recovery.allowances.cycle, f.state.cycle);
	assert.equal(requests[0].recovery.allowances.elapsedMs, f.state.elapsedMs);
	assert.equal(requests[0].recovery.allowances.remainingDurationMs, f.state.limits.durationMs - f.state.elapsedMs);
	assert.equal(requests[0].recovery.allowances.remainingWorkerIdentities, f.state.limits.agents - f.state.workers.length);
	assert.equal(requests[0].recovery.allowances.remainingTaskCreations, f.state.limits.tasks - f.state.tasksCreated);
	assert.deepEqual(requests[0].recovery.allowances.taskAttempts, [{ taskId: "task1", remainingAttempts: f.state.limits.attempts }]);
	assert.equal(requests[0].specification.objective, "Goal");
	assert.equal(result.run.status, resume ? "running" : "paused");
	assert.equal(result.run.cycle, f.state.cycle);
	assert.equal(result.run.workspace.receipts[0].outcome, "unknown");
	assert.equal(result.run.sessions.history[0].outcome, "interrupted");
	assert.equal(result.run.settlementAttestations.length, 1);
	assert.deepEqual(result.recovery.completed, ["lease", "restore", "reconciliation", ...(resume ? ["continuation"] : [])]);
	assert.equal(result.ownershipHeld, true);
	assert.equal(result.recovery.resumed, resume);
	assert.equal(f.mock.calls.length, 0);
	await host.close();
});

for (const terminalIntent of ["stop", "fail"]) for (const sessionId of ["owner1", "owner2"]) test(`quiet ${terminalIntent} intent recovers in ${sessionId} without attaching a closed runtime`, async t => {
	const f = await fixture(t, { terminalIntent, quietTerminal: true }), host = f.make(approve, sessionId);
	const recovered = await host.recover({ workspace: f.root, runId: "run1" });
	assert.equal(recovered.run.status, terminalIntent === "stop" ? "stopped" : "failed");
	assert.equal(recovered.run.ownerSessionId, sessionId);
	assert.equal(recovered.ownershipHeld, false); assert.equal(recovered.recovery.settled, true);
	assert.deepEqual(recovered.recovery.completed, ["restore", "reconciliation"]);
	assert.equal(recovered.recovery.stage, "completed"); assert.equal(recovered.recovery.resumed, false);
	assert.equal(recovered.run.settlementAttestations.length, 1);
	assert.equal(recovered.run.settlementAttestations[0].evidence, approve().attestation.evidence);
	assert.equal(recovered.driver, null); assert.equal(f.mock.calls.length, 0);
	await host.close();
});

test("the recorded lease owner can recover a crash before journal adoption without cross-session takeover", async t => {
	const f = await fixture(t, { stale: true });
	const leaseFile = join(f.layout.ownerPath, "owner.json");
	writeFileSync(leaseFile, JSON.stringify({ ...JSON.parse(readFileSync(leaseFile, "utf8")), ownerSessionId: "owner2" }), { mode: 0o600 });
	const foreign = f.make(approve, "owner3");
	await assert.rejects(foreign.recover({ workspace: f.root, runId: "run1" }), { code: "OWNERSHIP" }); await foreign.close();
	let packet;
	const host = f.make(request => { packet = request; return approve(); }, "owner2");
	const recovered = await host.recover({ workspace: f.root, runId: "run1" });
	assert.equal(packet.recovery.journalOwnerSessionId, "owner1");
	assert.equal(packet.recovery.previousLease.ownerSessionId, "owner2");
	assert.equal(recovered.run.ownerSessionId, "owner2"); assert.equal(recovered.run.status, "paused");
	assert.equal(recovered.recovery.settled, true); assert.equal(f.mock.calls.length, 0);
	await host.close();
});

test("changed journal in the ownership attachment window is rejected before automatic recovery writes", async t => {
	const f = await fixture(t, { stale: true }), host = f.make(approve);
	const open = SwarmController.open;
	t.mock.method(SwarmController, "open", async function(options) {
		if (options.expectedState) {
			const journal = openJournal(f.layout.journalPath, () => {});
			journal.append({ version: 1, operationId: randomUUID(), actor: "owner", type: "run.redirect", payload: { text: "External journal update" },
				expectedRevision: f.state.revision, cycle: f.state.cycle, generation: f.state.generation, atMs: f.state.lastAtMs });
			journal.close();
		}
		return open.call(this, options);
	});
	await assert.rejects(host.recover({ workspace: f.root, runId: "run1", resume: true }), { code: "STALE" });
	const after = host.snapshot();
	assert.deepEqual(after.recovery.completed, ["lease"]); assert.equal(after.recovery.stage, "restore");
	assert.equal(after.ownershipHeld, false); assert.equal(after.recovery.resumed, false); assert.equal(f.mock.calls.length, 0);
	const records = readFileSync(f.layout.journalPath, "utf8").trim().split("\n").map(line => JSON.parse(line).payload);
	assert.equal(records.at(-1).type, "run.redirect");
	await host.close();
});

test("fresh recovery repairs a partial attachment without reacquiring its workspace runtime", async t => {
	const f = await fixture(t, { stale: true }), host = f.make(approve);
	const attach = SwarmSessions.attach; let fail = true;
	t.mock.method(SwarmSessions, "attach", async function(...args) {
		if (fail) { fail = false; throw new Error("Fixture SDK attachment failed"); }
		return attach.apply(this, args);
	});
	await assert.rejects(host.recover({ workspace: f.root, runId: "run1", resume: true }));
	assert.equal(host.snapshot().ownershipHeld, true); assert.equal(host.snapshot().recovery.stage, "restore");
	assert.deepEqual(host.snapshot().recovery.completed, ["lease"]);
	const recovered = await host.recover({ workspace: f.root, runId: "run1" });
	assert.equal(recovered.run.status, "paused"); assert.equal(recovered.recovery.settled, true);
	assert.deepEqual(recovered.recovery.completed, ["restore", "reconciliation"]);
	assert.equal(recovered.run.cycle, f.state.cycle); assert.equal(f.mock.calls.length, 0);
	await host.close();
});

for (const kind of ["denied", "evidence", "outcome", "specification", "drift", "lease", "cancel"]) test(`guided recovery ${kind} cannot consume stale ownership or journal`, async t => {
	const f = await fixture(t, { stale: true });
	const before = readFileSync(f.layout.journalPath, "utf8");
	const shown = deferred(); const answer = deferred();
	const host = f.make(request => { shown.resolve(request); return answer.promise; });
	const rejected = assert.rejects(host.recover({ workspace: f.root, runId: "run1" }));
	const request = await shown.promise;
	if (kind === "drift") writeFileSync(join(f.root, "new-file"), "preserved");
	if (kind === "lease") writeFileSync(join(f.layout.ownerPath, "owner.json"), JSON.stringify({ ...request.recovery.previousLease, token: "replacement" }), { mode: 0o600 });
	if (kind === "cancel") await host.pause({ timeoutMs: 10 });
	answer.resolve(kind === "denied" ? { approved: false } : kind === "evidence" ? { approved: true } : kind === "outcome" ? { ...approve(), outcome: "resume" } : kind === "specification" ? { ...approve(), specification: { ...request.specification, objective: "Changed" } } : approve());
	await rejected;
	assert.equal(readFileSync(f.layout.journalPath, "utf8"), before);
	assert.equal(host.snapshot().run, null);
	assert.ok(readFileSync(join(f.layout.ownerPath, "owner.json"), "utf8"));
	await host.close();
});

for (const leaseOwner of ["foreign", null]) test(`guided recovery cannot reclaim ${leaseOwner ?? "missing"} owning session`, async t => {
	const f = await fixture(t, { stale: true });
	const ownerPath = join(f.layout.ownerPath, "owner.json");
	const lease = JSON.parse(readFileSync(ownerPath, "utf8"));
	writeFileSync(ownerPath, JSON.stringify({ ...lease, ownerSessionId: leaseOwner }), { mode: 0o600 });
	let requests = 0;
	const host = f.make(() => { requests++; return approve(); });
	await assert.rejects(host.recover({ workspace: f.root, runId: "run1" }), { code: "OWNERSHIP" });
	assert.equal(requests, 0);
	assert.equal(host.snapshot().run, null);
	assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).ownerSessionId, leaseOwner);
	await host.close();
});

test("guided recovery cannot steal an explicitly live controller PID", async t => {
	const f = await fixture(t, { stale: true });
	const ownerPath = join(f.layout.ownerPath, "owner.json");
	const lease = JSON.parse(readFileSync(ownerPath, "utf8"));
	writeFileSync(ownerPath, JSON.stringify({ ...lease, pid: process.pid }), { mode: 0o600 });
	const before = readFileSync(f.layout.journalPath, "utf8");
	const host = f.make(approve);
	await assert.rejects(host.recover({ workspace: f.root, runId: "run1" }));
	assert.equal(readFileSync(f.layout.journalPath, "utf8"), before);
	assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).pid, process.pid);
	assert.equal(host.snapshot().run, null);
	await host.close();
});

for (const terminalIntent of ["stop", "fail"]) test(`guided recovery preserves ${terminalIntent} intent and rejects resume before approval`, async t => {
	const f = await fixture(t, { terminalIntent }); let requests = 0;
	const host = f.make(() => { requests++; return approve(); });
	await assert.rejects(host.recover({ workspace: f.root, runId: "run1", resume: true }), { code: "STATE" });
	assert.equal(requests, 0);
	const result = await host.recover({ workspace: f.root, runId: "run1" });
	assert.equal(result.run.status, terminalIntent === "stop" ? "stopped" : "failed");
	assert.equal(result.run.cycle, f.state.cycle);
	await assert.rejects(host.recover({ workspace: f.root, runId: "run1", resume: true }), { code: "STATE" });
	assert.equal(requests, 1); // Closed terminal recovery is never an implicit restart.
	await host.close();
});

test("guided recovery rejects exhausted budget without resetting time", async t => {
	const f = await fixture(t, { exhausted: true }); let requests = 0;
	const host = f.make(() => { requests++; return approve(); });
	await assert.rejects(host.recover({ workspace: f.root, runId: "run1", resume: true }), { code: "TIME_LIMIT" });
	assert.equal(requests, 0);
	const result = await host.recover({ workspace: f.root, runId: "run1" });
	assert.ok(result.run.elapsedMs >= f.state.limits.durationMs);
	assert.equal(result.run.cycle, 1);
	await host.close();
});

test("paused recovery remains available with unavailable model catalog", async t => {
	const f = await fixture(t);
	const original = f.mock.modelRuntime.getModel;
	f.mock.modelRuntime.getModel = () => { throw new Error("Provider unavailable"); };
	const host = f.make(approve);
	const result = await host.recover({ workspace: f.root, runId: "run1" });
	assert.equal(result.run.status, "paused");
	assert.equal(f.mock.calls.length, 0);
	f.mock.modelRuntime.getModel = original;
	await host.close();
});

test("attached guided recovery rejects revision drift and can retry only through fresh approval", async t => {
	const f = await fixture(t); const shown = deferred(); const answer = deferred(); let delayed = true;
	const host = f.make(request => delayed ? (shown.resolve(request), answer.promise) : approve());
	await host.restore({ workspace: f.root, runId: "run1" });
	const rejected = assert.rejects(host.recover({ workspace: f.root, runId: "run1" }), { code: "CANCELLED" });
	await shown.promise;
	await host.redirect("New guidance");
	answer.resolve(approve()); await rejected;
	assert.equal(host.snapshot().run.workspace.operations.length, 1);
	delayed = false;
	await host.recover({ workspace: f.root, runId: "run1" });
	await host.close();
});

test("already paused recovery without unresolved execution does not reconcile or replay", async t => {
	const f = await fixture(t);
	const host = f.make(approve);
	await host.recover({ workspace: f.root, runId: "run1" });
	const original = SwarmSessions.prototype.reconcile;
	SwarmSessions.prototype.reconcile = () => { throw new Error("No orphan reconciliation expected"); };
	t.after(() => { SwarmSessions.prototype.reconcile = original; });
	const result = await host.recover({ workspace: f.root, runId: "run1" });
	assert.equal(result.run.status, "paused");
	assert.equal(result.run.workspace.receipts.length, 1);
	assert.deepEqual(result.recovery.completed, ["reconciliation"]);
	result.recovery.completed.push("modified observer");
	assert.deepEqual(host.snapshot().recovery.completed, ["reconciliation"]);
	assert.equal(f.mock.calls.length, 0);
	SwarmSessions.prototype.reconcile = original;
	await host.close();
});

for (const timeout of [false, true]) test(`live uncertain recovery ${timeout ? "stays fenced on timeout" : "waits for actual SDK settlement"}`, async t => {
	const root = repository(t);
	const mock = await createMockRuntime([
		{ toolCalls: [{ name: "swarm_task", arguments: { action: "create", id: "task1", title: "Check", criteria: [0], dependencies: [] } }] },
		{ toolCalls: [{ name: "swarm_task", arguments: { action: "claim", taskId: "task1", kind: "build" } }] },
		{ toolCalls: [{ name: "bash", arguments: { command: "mock uncertain command" } }] },
	]);
	let requests = 0;
	const host = new SwarmHost({ events: new EventEmitter(), sessionId: "owner1", modelRuntime: mock.modelRuntime, mainModel: mock.model, requestApproval: () => { requests++; return approve(); }, runner: async () => ({ settled: false, exitCode: null }), tickIntervalMs: 0 });
	await host.launch({ workspace: root, runId: "run1", specification: { objective: "Goal", criteria: ["Result"], scope: ["src"] } });
	await host.recruit({ id: "builder", specialization: "Build", brief: "Build work", reason: "Independent work" });
	host.wake("builder");
	for (let i = 0; i < 200 && !host.snapshot().workspace.uncertain.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(host.snapshot().workspace.uncertain.length, 1);
	const original = SwarmSessions.prototype.pause;
	if (timeout) SwarmSessions.prototype.pause = async () => ({ settled: false });
	t.after(() => { SwarmSessions.prototype.pause = original; });
	const result = await host.recover({ workspace: root, runId: "run1", resume: true });
	SwarmSessions.prototype.pause = original;
	assert.equal(requests, 2); // Launch plus a single recovery approval.
	assert.equal(result.recovery.resumed, !timeout);
	assert.equal(result.recovery.stage, timeout ? "awaiting-settlement" : "completed");
	assert.equal(result.run.cycle, 1);
	if (timeout) assert.notEqual(result.run.status, "running");
	await host.pause();
	assert.equal(host.snapshot().run.workspace.receipts.at(-1).outcome, "unknown");
	await host.close();
});
