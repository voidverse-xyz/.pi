import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { repository } from "./helpers.mjs";
import { createMockRuntime } from "./sdk-env.mjs";
import { SwarmHost } from "../extensions/swarm/host.mjs";
import { SwarmError } from "../extensions/swarm/errors.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { SwarmSessions } from "../extensions/swarm/sessions.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { acquireLease, inspectReservation } from "../extensions/swarm/store/lease.mjs";
import { WorkspaceRuntime } from "../extensions/swarm/workspace.mjs";
import { prepareLayout } from "../extensions/swarm/store/layout.mjs";

const code = expected => error => error.code === expected;
const approved = request => ({ approved: true, reconciled: request.requiresReconciliation });
const specification = { objective: "Implement invitations", criteria: ["Invitations work"], scope: ["src"] };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function modeBus() {
	const events = new EventEmitter();
	let snapshot = { version: 1, instanceId: "instance1", revision: 1, contextRevision: 1, ready: true, sessionId: "owner1", selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false };
	events.on("pi-plan:query-mode", request => request.respond({ ...snapshot }));
	return { events, change(values) { snapshot = { ...snapshot, ...values, revision: snapshot.revision + 1 }; events.emit("pi-plan:mode-changed", { ...snapshot }); } };
}
async function fixture(t, options = {}) {
	const root = repository(t);
	const bus = modeBus();
	const mock = await createMockRuntime(options.script ?? []);
	const host = new SwarmHost({ events: bus.events, sessionId: "owner1", requestApproval: options.approval ?? approved, modelRuntime: mock.modelRuntime, mainModel: mock.model, tickIntervalMs: 0, approvalTimeoutMs: options.timeout ?? 1000, safetyTimeoutMs: 1000 });
	const launch = () => host.launch({ workspace: root, runId: "run1", specification: { ...specification, ...options.specification } });
	return { root, ...bus, mock, host, launch };
}

test("read-only host history does not create sessions, files or dispatch", async t => {
	const f = await fixture(t, { script: () => ({ text: "History evidence" }) });
	await f.launch();
	await f.host.recruit({ id: "worker", specialization: "Review", brief: "Inspect", reason: "Independent inspection" });
	const before = f.host.snapshot();
	const entries = f.host.history("worker");
	assert.deepEqual(f.host.snapshot(), before);
	assert.equal(f.mock.calls.length, 0);
	assert.ok(Array.isArray(entries));
	assert.throws(() => f.host.history("missing"), { code: "NOT_FOUND" });
	const binding = before.run.sessions.workers[0];
	const path = join(prepareLayout(f.root, "run1").stateRoot, "run1", "sessions", binding.sessionFile);
	// The open, unprompted session has no persisted history, and reading it writes nothing.
	// Persisted identity checks for unopened sessions are covered in sdk-driver.test.mjs.
	assert.deepEqual(entries, []);
	assert.equal(existsSync(path), false);
	await f.host.close();
});

test("launch waits for explicit human approval before creating storage or sessions", async t => {
	const decision = deferred(); const presented = deferred();
	const f = await fixture(t, { approval: request => { presented.resolve(request); return decision.promise; } });
	const launch = f.launch(); const request = await presented.promise;
	assert.equal(request.action, "launch");
	assert.equal(request.requiresExistingWorkDecision, undefined);
	assert.equal(request.existingChanges, "preserve");
	assert.match(request.workspaceFingerprint, /^[a-f0-9]{64}$/);
	assert.equal(request.runRevision, null);
	assert.match(request.integrations.confirmations, /Selected coding tools.*no Swarm operation prompts/);
	assert.equal(Object.isFrozen(request.integrations), true);
	assert.equal(f.mock.calls.length, 0);
	assert.equal(existsSync(join(prepareLayout(f.root, "run1").stateRoot)), false);
	decision.resolve(approved(request)); await launch;
	assert.equal(f.host.snapshot().run.status, "running");
	assert.equal(f.host.snapshot().run.hostApprovals[0].existingChanges, "preserve");
	assert.equal(f.mock.calls.length, 0);
	await f.host.close();
});

for (const action of ["pause", "close"]) {
	test(`${action} cancels pre-proposal inspection without authority and a new host can request fresh approval`, async t => {
		let prompts = 0;
		const f = await fixture(t, { approval: request => { prompts++; return approved(request); } });
		const rejected = assert.rejects(f.launch(), code("CANCELLED"));
		await new Promise(resolve => setTimeout(resolve, 0));
		await f.host[action]();
		await rejected;
		assert.equal(prompts, 0);
		assert.equal(f.host.snapshot().run, null);
		assert.equal(f.mock.calls.length, 0);
		assert.equal(existsSync(prepareLayout(f.root, "run1").stateRoot), false);
		await f.host.close();
		const fresh = new SwarmHost({ events: f.events, sessionId: "owner1", requestApproval: request => { prompts++; return approved(request); }, modelRuntime: f.mock.modelRuntime, mainModel: f.mock.model, tickIntervalMs: 0 });
		await fresh.launch({ workspace: f.root, runId: "run1", specification });
		assert.equal(prompts, 1);
		assert.equal(fresh.snapshot().run.hostApprovals.length, 1);
		await fresh.close();
	});
}

test("dirty checkout is preserved by default across launch, resume, restart and close", async t => {
	const requests = [];
	const f = await fixture(t, { approval: request => { requests.push(request); return approved(request); } });
	const path = join(f.root, "user.txt");
	writeFileSync(path, "user work\n");
	await f.launch();
	assert.equal(readFileSync(path, "utf8"), "user work\n");
	await f.host.pause();
	writeFileSync(path, "user work plus later changes\n");
	const pausedRevision = f.host.snapshot().run.revision;
	await f.host.resume();
	assert.equal(requests.at(-1).runRevision, pausedRevision);
	await f.host.pause({ stop: true });
	await f.host.resume({ restart: true });
	assert.deepEqual(requests.map(request => request.action), ["launch", "resume", "restart"]);
	assert.ok(requests.every(request => request.existingChanges === "preserve" && request.requiresExistingWorkDecision === undefined));
	assert.ok(f.host.snapshot().run.hostApprovals.every(approval => approval.existingChanges === "preserve"));
	await f.host.close();
	assert.equal(readFileSync(path, "utf8"), "user work plus later changes\n");
});

test("refusing a proposal preserves dirty work without creating run storage", async t => {
	const f = await fixture(t, { approval: () => ({ approved: false }) });
	writeFileSync(join(f.root, "user.txt"), "user work\n");
	await assert.rejects(f.launch(), code("AUTHORITY"));
	assert.equal(readFileSync(join(f.root, "user.txt"), "utf8"), "user work\n");
	assert.equal(existsSync(join(prepareLayout(f.root, "run1").stateRoot)), false);
	assert.equal(f.mock.calls.length, 0);
	await f.host.close();
});

test("approved launch edits are captured but are not inferred from mutable request data", async t => {
	const f = await fixture(t, { approval: request => ({ ...approved(request), specification: { ...request.specification, objective: "Human-edited objective" } }) });
	await f.launch();
	assert.equal(f.host.snapshot().run.objective, "Human-edited objective");
	await f.host.close();
});

for (const selectedMode of ["plan", "discuss", "quick"]) {
	test(`${selectedMode} denies launch before any approval or storage`, async t => {
		let prompts = 0;
		const f = await fixture(t, { approval: request => { prompts++; return approved(request); } });
		f.change({ selectedMode, enforcedMode: "off", pendingChange: true });
		await assert.rejects(f.launch(), code("MODE_DENIED"));
		assert.equal(prompts, 0);
		assert.equal(existsSync(join(prepareLayout(f.root, "run1").stateRoot)), false);
		await f.host.close();
	});
}

test("mode ABA and late approval cannot revive cancelled launch", async t => {
	const decision = deferred(); const presented = deferred();
	const f = await fixture(t, { approval: request => { presented.resolve(request); return decision.promise; } });
	const rejected = assert.rejects(f.launch()); await presented.promise;
	f.change({ selectedMode: "plan", enforcedMode: "plan" });
	f.change({ selectedMode: "off", enforcedMode: "off" });
	decision.resolve({ approved: true }); await rejected;
	assert.equal(existsSync(join(prepareLayout(f.root, "run1").stateRoot)), false);
	assert.equal(f.mock.calls.length, 0);
	await f.host.close();
});

test("external edits during approval require a fresh decision and are never rolled back", async t => {
	const decision = deferred(); const presented = deferred();
	const f = await fixture(t, { approval: request => { presented.resolve(request); return decision.promise; } });
	const rejected = assert.rejects(f.launch(), code("STALE")); const request = await presented.promise;
	writeFileSync(join(f.root, "new-user-work"), "preserve me");
	decision.resolve(approved(request)); await rejected;
	assert.equal(readFileSync(join(f.root, "new-user-work"), "utf8"), "preserve me");
	assert.equal(existsSync(join(prepareLayout(f.root, "run1").stateRoot)), false);
	await f.host.close();
});

test("stop during approved workspace revalidation cannot grant authority and requires fresh approval", async t => {
	let prompts = 0;
	let paused;
	let f;
	f = await fixture(t, { approval: request => {
		prompts++;
		if (prompts === 1) paused = new Promise(resolve => setTimeout(() => resolve(f.host.pause()), 0));
		return approved(request);
	} });
	await assert.rejects(f.launch(), code("CANCELLED"));
	await paused;
	assert.equal(f.host.snapshot().run, null);
	assert.equal(f.mock.calls.length, 0);
	await f.launch();
	assert.equal(prompts, 2);
	assert.equal(f.host.snapshot().run.hostApprovals.length, 1);
	await f.host.close();
});

test("approval timeout aborts its provider and ignores later completion", async t => {
	let signal;
	const decision = deferred();
	const f = await fixture(t, { timeout: 5, approval: request => { signal = request.signal; return decision.promise; } });
	await assert.rejects(f.launch(), code("CANCELLED"));
	assert.equal(signal.aborted, true);
	decision.resolve({ approved: true });
	await Promise.resolve();
	assert.equal(f.host.snapshot().run, null);
	await f.host.close();
});

test("restriction pauses a running host and Off does not automatically resume it", async t => {
	const f = await fixture(t);
	await f.launch();
	f.change({ selectedMode: "plan", enforcedMode: "off", pendingChange: true });
	await f.host.idle();
	assert.equal(f.host.snapshot().run.status, "paused");
	f.change({ selectedMode: "off", enforcedMode: "off", pendingChange: false });
	assert.throws(() => f.host.wake("builder"), code("HOST_DENIED"));
	await f.host.resume();
	assert.equal(f.host.snapshot().run.status, "running");
	assert.equal(f.host.snapshot().run.hostApprovals.at(-1).action, "resume");
	await f.host.close();
});

test("same-mode context restore revokes approval; harmless Off lifecycle does not", async t => {
	const f = await fixture(t);
	await f.launch();
	f.change({ runMode: "off" });
	assert.equal(f.host.snapshot().run.status, "running");
	f.change({ runMode: null });
	f.change({ contextRevision: 2 });
	await f.host.idle();
	assert.equal(f.host.snapshot().run.status, "paused");
	await f.host.close();
});

test("explicit restart approval resets cycle and reacquires stopped ownership", async t => {
	const f = await fixture(t);
	await f.launch(); await f.host.pause({ stop: true });
	assert.equal(f.host.snapshot().run.status, "stopped");
	await f.host.resume({ restart: true });
	assert.equal(f.host.snapshot().run.cycle, 2);
	assert.equal(f.host.snapshot().run.hostApprovals.at(-1).action, "restart");
	await f.host.close();
});

test("create-only launch cannot adopt another host's differently approved run", async t => {
	const decision = deferred(); const presented = deferred();
	const f = await fixture(t, { timeout: 5000, approval: request => { presented.resolve(request); return decision.promise; } });
	const launch = assert.rejects(f.launch(), code("DUPLICATE")); const request = await presented.promise;
	const other = new SwarmHost({ events: f.events, sessionId: "owner1", requestApproval: approved, modelRuntime: f.mock.modelRuntime, mainModel: f.mock.model, tickIntervalMs: 0 });
	await other.launch({ workspace: f.root, runId: "run1", specification: { ...specification, objective: "Another approved objective" } });
	await other.close(); decision.resolve(approved(request)); await launch;
	assert.equal(f.host.snapshot().run, null);
	await f.host.close();
});

for (const action of ["pause", "close"]) {
	test(`${action} accounts for a controller acquired after approval`, async t => {
		const entered = deferred(); const release = deferred();
		const original = SwarmController.open;
		t.after(() => { SwarmController.open = original; });
		SwarmController.open = async options => { const c = await original.call(SwarmController, options); entered.resolve(); await release.promise; return c; };
		const f = await fixture(t);
		const rejected = assert.rejects(f.launch(), code("CANCELLED")); await entered.promise;
		const stopped = f.host[action](); release.resolve(); await stopped; await rejected;
		assert.equal(f.host.snapshot().run.status, "paused");
		assert.equal(f.mock.calls.length, 0);
		if (action === "pause") await f.host.close();
		SwarmController.open = original;
		const reopened = await SwarmController.open({ workspace: f.root, runId: "run1", ownerSessionId: "owner1" });
		await reopened.close();
	});
}

test("pause cancels an approved continuation before it can regain execution authority", async t => {
	const f = await fixture(t); await f.launch(); await f.host.pause();
	const entered = deferred(); const release = deferred();
	const original = SwarmController.prototype.owner;
	t.after(() => { SwarmController.prototype.owner = original; });
	SwarmController.prototype.owner = async function(type, ...args) {
		const result = await original.call(this, type, ...args);
		if (type === "host.continue") { entered.resolve(); await release.promise; }
		return result;
	};
	const rejected = assert.rejects(f.host.resume(), code("CANCELLED")); await entered.promise;
	const paused = f.host.pause(); release.resolve(); await paused; await rejected;
	assert.equal(f.host.snapshot().run.status, "paused");
	assert.throws(() => f.host.wake("builder"), code("HOST_DENIED"));
	await f.host.close();
});

test("emergency stop drains the attached driver without waiting for stalled continuation", async t => {
	const f = await fixture(t); await f.launch(); await f.host.pause();
	const entered = deferred(); const release = deferred();
	const original = SwarmController.prototype.owner;
	t.after(() => { SwarmController.prototype.owner = original; release.resolve(); });
	SwarmController.prototype.owner = async function(type, ...args) {
		const result = await original.call(this, type, ...args);
		if (type === "host.continue") { entered.resolve(); await release.promise; }
		return result;
	};
	const rejected = assert.rejects(f.host.resume(), code("CANCELLED"));
	await entered.promise;
	const stopped = await f.host.pause({ stop: true, timeoutMs: 50 });
	assert.equal(stopped.settled, false, "pending preparation still retains ownership");
	assert.equal(f.host.snapshot().run.status, "stopped", "stop transition must not wait for preparation");
	assert.throws(() => f.host.wake("builder"), code("HOST_DENIED"));
	release.resolve(); await rejected; await f.host.close();
	assert.equal(f.mock.calls.length, 0);
});

test("close during terminal restart releases the newly acquired controller", async t => {
	const f = await fixture(t); await f.launch(); await f.host.pause({ stop: true });
	const entered = deferred(); const release = deferred();
	const original = SwarmController.open;
	t.after(() => { SwarmController.open = original; });
	SwarmController.open = async options => { const c = await original.call(SwarmController, options); entered.resolve(); await release.promise; return c; };
	const rejected = assert.rejects(f.host.resume({ restart: true }), code("CANCELLED")); await entered.promise;
	const closed = f.host.close(); release.resolve(); await closed; await rejected;
	SwarmController.open = original;
	const reopened = await SwarmController.open({ workspace: f.root, runId: "run1", ownerSessionId: "owner1" });
	assert.equal(reopened.snapshot().status, "stopped");
	await reopened.close();
});

const shellScript = [
	{ toolCalls: [{ id: "create", name: "swarm_task", arguments: { action: "create", id: "task1", title: "Feature", criteria: [0], dependencies: [] } }] },
	{ toolCalls: [{ id: "claim", name: "swarm_task", arguments: { action: "claim", taskId: "task1", kind: "build" } }] },
	{ toolCalls: [{ id: "shell", name: "bash", arguments: { command: "printf unsafe > marker" } }] },
	{ text: "Settled" },
];
async function wakeBuilder(f) {
	await f.host.recruit({ id: "builder", specialization: "build", brief: "Focused implementation", reason: "Approved work" });
	f.host.wake("builder");
}

test("without safety, the approved bounded tool policy authorizes SDK shell execution without prompts", async t => {
	const f = await fixture(t, { script: shellScript }); await f.launch(); await wakeBuilder(f); await f.host.idle();
	assert.equal(readFileSync(join(f.root, "marker"), "utf8"), "unsafe");
	assert.equal(f.host.snapshot().run.workspace.operations.length, 0);
	assert.equal(f.host.snapshot().run.workspace.receipts.at(-1).outcome, "succeeded");
	await f.host.close();
});

test("a read-only tool selection cannot acquire shell authorization", async t => {
	const f = await fixture(t, { script: shellScript, specification: { codingTools: ["read"] } });
	await f.launch(); await wakeBuilder(f); await f.host.idle();
	assert.equal(existsSync(join(f.root, "marker")), false);
	assert.equal(f.host.snapshot().run.workspace.receipts.length, 0);
	assert.deepEqual(f.host.snapshot().run.sessions.codingTools, ["read"]);
	assert.ok(f.mock.calls.some(call => call.context.messages.some(message => message.role === "toolResult" && message.toolName === "bash" && message.isError)));
	await f.host.close();
});

for (const policy of ["deny", "duplicate", "malformed"]) {
	test(`an independently installed safety provider ${policy} never falls back to run authorization`, async t => {
		const f = await fixture(t, { script: shellScript });
		await f.launch();
		let calls = 0;
		f.events.on("swarm:confirm-request", request => {
			const provider = () => { calls++; return { approved: false }; };
			request.claim(policy === "malformed" ? {} : provider);
			if (policy === "duplicate") request.claim(provider);
		});
		await wakeBuilder(f); await f.host.idle();
		assert.equal(existsSync(join(f.root, "marker")), false);
		assert.equal(f.host.snapshot().run.workspace.operations.length, 0);
		assert.equal(calls, policy === "deny" ? 1 : 0);
		await f.host.close();
	});
}

test("an observed safety provider disappearing cannot restore policy fallback", async t => {
	const script = [...shellScript.slice(0, 2),
		{ toolCalls: [{ id: "first", name: "bash", arguments: { command: "printf approved > first-marker" } }] },
		{ toolCalls: [{ id: "second", name: "bash", arguments: { command: "printf bypass > second-marker" } }] },
		{ text: "Settled" }];
	const f = await fixture(t, { script });
	await f.launch();
	f.events.on("swarm:confirm-request", request => request.claim(() => {
		f.events.removeAllListeners("swarm:confirm-request");
		return { approved: true };
	}));
	await wakeBuilder(f); await f.host.idle();
	assert.equal(readFileSync(join(f.root, "first-marker"), "utf8"), "approved");
	assert.equal(existsSync(join(f.root, "second-marker")), false);
	assert.equal(f.host.snapshot().run.workspace.receipts.length, 1);
	await f.host.pause();
	await assert.rejects(f.host.resume(), code("AUTHORITY"));
	await f.host.close();
});

test("stop cancels external safety approval and late approval cannot run a command", async t => {
	const decision = deferred(); const presented = deferred();
	const f = await fixture(t, { script: shellScript });
	f.events.on("swarm:confirm-request", request => request.claim(value => { presented.resolve(value); return decision.promise; }));
	await f.launch(); await wakeBuilder(f);
	const request = await presented.promise;
	await f.host.pause({ stop: true });
	assert.equal(request.signal.aborted, true);
	decision.resolve({ approved: true });
	await f.host.idle();
	assert.equal(existsSync(join(f.root, "marker")), false);
	assert.equal(f.host.snapshot().run.status, "stopped");
	await f.host.close();
});

test("emergency stop kills a native Bash child process and settles its operation", async t => {
	const command = `node -e "require('node:fs').writeFileSync('worker-child.pid', String(process.pid)); setInterval(()=>{},1000)"`;
	const f = await fixture(t, { script: [...shellScript.slice(0, 2),
		{ toolCalls: [{ id: "shell", name: "bash", arguments: { command } }] }] });
	let pid;
	t.after(async () => {
		if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
		await f.host.close();
	});
	f.events.on("swarm:confirm-request", request => request.claim(() => ({ approved: true })));
	await f.launch(); await wakeBuilder(f);
	const path = join(f.root, "worker-child.pid");
	for (let i = 0; i < 500 && !existsSync(path); i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(existsSync(path), "native child started");
	pid = Number(readFileSync(path, "utf8"));
	assert.ok(Number.isInteger(pid) && pid > 0);
	const result = await f.host.pause({ stop: true });
	assert.equal(result.settled, true);
	assert.equal(f.host.snapshot().run.status, "stopped");
	assert.deepEqual(f.host.snapshot().driver.active, []);
	assert.equal(f.host.snapshot().run.workspace.operations.length, 0);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "child process must be dead, not just marked stopped");
	pid = undefined;
});

test("mode revocation during a durable execution-start gap prevents the side effect", async t => {
	const entered = deferred(); const release = deferred();
	const original = SwarmController.prototype.system;
	t.after(() => { SwarmController.prototype.system = original; });
	SwarmController.prototype.system = async function(type, ...args) {
		const result = await original.call(this, type, ...args);
		if (type === "workspace.start") { entered.resolve(); await release.promise; }
		return result;
	};
	const f = await fixture(t, { script: shellScript });
	f.events.on("swarm:confirm-request", request => request.claim(() => ({ approved: true })));
	await f.launch(); await wakeBuilder(f); await entered.promise;
	f.change({ selectedMode: "quick", enforcedMode: "off", pendingChange: true });
	release.resolve(); await f.host.idle();
	assert.equal(existsSync(join(f.root, "marker")), false);
	assert.equal(f.host.snapshot().run.status, "paused");
	assert.equal(f.host.snapshot().run.workspace.operations.length, 0);
	await f.host.close();
});

const sequentialSpecification = objective => ({ objective, criteria: ["Inspection complete"], scope: ["Read only"], codingTools: ["read"] });
const sequentialDelay = () => new Promise(resolve => setTimeout(resolve, 2));
async function sequentialUntil(predicate) {
	for (let i = 0; i < 1000; i++) { if (predicate()) return; await sequentialDelay(); }
	assert.fail("Worker did not settle");
}
async function sequentialFixture(t) {
	const root = repository(t);
	const mock = await createMockRuntime(() => ({ text: "Prior objective history" }));
	const requests = [];
	let approve = true;
	const host = new SwarmHost({ events: new EventEmitter(), sessionId: "owner1", tickIntervalMs: 0,
		modelRuntime: mock.modelRuntime, mainModel: mock.model,
		requestApproval: request => { requests.push(request); return { approved: approve }; } });
	t.after(() => host.close());
	const launch = runId => host.launch({ workspace: root, runId, specification: sequentialSpecification(runId) });
	await launch("prior");
	await host.recruit({ id: "worker", specialization: "Inspect", brief: "Read", reason: "History proof" });
	host.wake("worker");
	await sequentialUntil(() => mock.calls.length === 1 && !host.snapshot().driver.active.length);
	await host.pause({ stop: true });
	return { root, mock, host, requests, launch, rejectApproval: () => { approve = false; }, approve: () => { approve = true; } };
}

for (const kind of ["storage", "lease"]) test(`${kind} failure after retiring driver preserves old history and requires a new approval`, async t => {
	const f = await sequentialFixture(t);
	const history = f.host.history("worker");
	assert.ok(history.length);
	const journal = prepareLayout(f.root, "prior").journalPath;
	const priorBytes = readFileSync(journal, "utf8");
	const open = SwarmController.open;
	const close = SwarmSessions.prototype.close;
	let retired = false, competingLease;
	t.mock.method(SwarmSessions.prototype, "close", async function () { await close.call(this); retired = true; });
	const injection = t.mock.method(SwarmController, "open", async options => {
		assert.equal(retired, true, "failure occurs after old driver retirement");
		if (kind === "lease") {
			competingLease = acquireLease(prepareLayout(f.root, "competing"), { ownerSessionId: "foreign" });
			return open.call(SwarmController, options);
		}
		throw Object.assign(new Error("injected storage failure"), { code: "EIO" });
	});
	await assert.rejects(f.launch("next"));
	assert.equal(f.host.snapshot().run.runId, "prior");
	assert.equal(f.host.snapshot().transition.stage, "opening");
	assert.deepEqual(f.host.history("worker"), history);
	assert.equal(readFileSync(journal, "utf8"), priorBytes);
	assert.throws(() => f.host.wake("worker"), { code: "HOST_DENIED" });
	assert.equal(f.mock.calls.length, 1);
	injection.mock.restore();
	if (competingLease) {
		await assert.rejects(f.launch("retry"), { code: "OWNERSHIP" });
		competingLease.release({ retainReservation: false });
	}
	f.rejectApproval();
	const before = f.requests.length;
	await assert.rejects(f.launch("retry"), { code: "AUTHORITY" });
	assert.equal(f.requests.length, before + 1, "retry needs a freshly inspected approval");
	assert.deepEqual(f.host.history("worker"), history);
	assert.equal(readFileSync(journal, "utf8"), priorBytes);
	assert.equal(f.mock.calls.length, 1);
	f.approve();
	await f.launch("retry");
	assert.equal(f.requests.length, before + 2);
	assert.equal(f.host.snapshot().run.runId, "retry");
	assert.equal(f.host.snapshot().run.workers.length, 0);
	assert.equal(f.host.snapshot().transition.workerContexts, "fresh");
	assert.equal(readFileSync(journal, "utf8"), priorBytes);
	assert.equal(f.mock.calls.length, 1, "launch itself never replays prior workers");
});

test("real post-acquisition journal failure retains history, releases never-dispatched reservation and retries with fresh approval", async t => {
	const f = await sequentialFixture(t);
	const history = f.host.history("worker");
	const priorJournal = prepareLayout(f.root, "prior").journalPath;
	const priorBytes = readFileSync(priorJournal, "utf8");
	const original = SwarmController.open;
	const injection = t.mock.method(SwarmController, "open", options => original.call(SwarmController, { ...options,
		journalIo: { writeAll() { throw new Error("Injected journal write failure"); }, sync() {} } }));
	await assert.rejects(f.launch("storage-fault"));
	assert.equal(f.host.snapshot().run.runId, "prior");
	assert.equal(f.host.snapshot().transition.stage, "opening");
	assert.equal(inspectReservation(prepareLayout(f.root, "storage-fault")), null);
	assert.ok(existsSync(prepareLayout(f.root, "storage-fault").journalPath), "failed creation journal is retained, not deleted");
	assert.deepEqual(f.host.history("worker"), history);
	assert.equal(readFileSync(priorJournal, "utf8"), priorBytes);
	assert.throws(() => f.host.wake("worker"), { code: "HOST_DENIED" });
	assert.equal(f.mock.calls.length, 1);
	injection.mock.restore();
	f.rejectApproval();
	await assert.rejects(f.launch("retry"), { code: "AUTHORITY" });
	assert.deepEqual(f.host.history("worker"), history);
	f.approve();
	await f.launch("retry");
	assert.equal(f.host.snapshot().run.runId, "retry");
	assert.equal(f.mock.calls.length, 1);
	assert.equal(readFileSync(priorJournal, "utf8"), priorBytes);
});

test("new controller created before SDK attachment fails can stop and retry in the same host", async t => {
	const f = await sequentialFixture(t);
	const priorJournal = prepareLayout(f.root, "prior").journalPath;
	const priorBytes = readFileSync(priorJournal, "utf8");
	const attach = t.mock.method(SwarmSessions, "attach", async () => { throw new SwarmError("PROVIDER", "Injected attachment failure"); });
	await assert.rejects(f.launch("partial"), { code: "PROVIDER" });
	const partial = f.host.snapshot();
	assert.equal(partial.run.runId, "partial");
	assert.equal(partial.run.status, "paused");
	assert.equal(partial.driver, null);
	assert.equal(partial.ownershipHeld, true);
	assert.equal(partial.transition.stage, "attached");
	assert.equal(readFileSync(priorJournal, "utf8"), priorBytes);
	assert.throws(() => f.host.wake("worker"), { code: "HOST_DENIED" });
	assert.equal(f.mock.calls.length, 1);
	await assert.rejects(f.launch("blocked"), { code: "STATE" });
	assert.deepEqual(await f.host.pause({ stop: true }), { settled: true });
	assert.equal(f.host.snapshot().run.status, "stopped");
	assert.equal(f.host.snapshot().ownershipHeld, false);
	attach.mock.restore();
	f.rejectApproval();
	await assert.rejects(f.launch("retry"), { code: "AUTHORITY" });
	assert.equal(f.host.snapshot().run.runId, "partial");
	f.approve();
	await f.launch("retry");
	assert.equal(f.host.snapshot().run.runId, "retry");
	assert.equal(readFileSync(priorJournal, "utf8"), priorBytes);
	assert.equal(f.mock.calls.length, 1);
});

for (const obstruction of ["queued", "claims", "pending", "active", "sdk-busy"]) test(`${obstruction} prevents replacement before approval without cancellation or disposal`, async t => {
	const f = await sequentialFixture(t);
	const before = f.host.snapshot();
	const history = f.host.history("worker");
	const approvals = f.requests.length;
	const driverSnapshot = SwarmSessions.prototype.snapshot;
	const workspaceSnapshot = WorkspaceRuntime.prototype.snapshot;
	let closes = 0;
	const close = SwarmSessions.prototype.close;
	t.mock.method(SwarmSessions.prototype, "close", async function () { closes++; return close.call(this); });
	if (obstruction === "queued") {
		// The driver guard must check the actual queue, not just host snapshot active turns.
		t.mock.method(SwarmSessions.prototype, "snapshot", function () { return { ...driverSnapshot.call(this), queued: ["worker"] }; });
	} else if (obstruction === "sdk-busy") {
		t.mock.method(SwarmSessions.prototype, "snapshot", function () { return { ...driverSnapshot.call(this), sdkIdle: false }; });
	} else {
		t.mock.method(WorkspaceRuntime.prototype, "snapshot", function () {
			const state = workspaceSnapshot.call(this);
			return { ...state, coordination: { ...state.coordination, [obstruction]: [{ owner: "held-owner" }] } };
		});
	}
	await assert.rejects(f.launch("next"), { code: "UNSETTLED" });
	assert.equal(f.requests.length, approvals);
	assert.equal(closes, 0);
	assert.deepEqual(f.host.snapshot().run, before.run);
	assert.deepEqual(f.host.history("worker"), history);
	assert.equal(f.mock.calls.length, 1);
});
