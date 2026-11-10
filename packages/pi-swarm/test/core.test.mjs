import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, fsyncSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { acquireLease } from "../extensions/swarm/store/lease.mjs";
import { privateDirectory, writeAll } from "../extensions/swarm/store/files.mjs";
import { openJournal } from "../extensions/swarm/store/journal.mjs";
import { repository, machine } from "./helpers.mjs";

const code = expected => error => error.code === expected;
const specification = { objective: "Build invitations", criteria: ["Invitations work"], scope: ["src"] };

for (const reservedRunId of ["new-run", "foreign-run"]) test(`fresh creation preserves ambiguous pre-existing reservation ${reservedRunId}`, async t => {
	const root = repository(t);
	const layout = prepareLayout(root, reservedRunId);
	const lease = acquireLease(layout, { ownerSessionId: "prior-owner" });
	lease.release(); // Retains a reservation without a live lease or run directory.
	const bytes = readFileSync(layout.reservationPath, "utf8");
	await assert.rejects(SwarmController.open({ workspace: root, runId: "new-run", ownerSessionId: "session1", create: specification, createOnly: true }), code("RESERVED"));
	assert.equal(readFileSync(layout.reservationPath, "utf8"), bytes);
	assert.equal(existsSync(layout.ownerPath), false, "inspection never acquires ownership");
	assert.equal(existsSync(prepareLayout(root, "new-run").runRoot), false);
});

async function fixture(t, limits) {
	const root = repository(t);
	let now = 0;
	const options = { workspace: root, runId: "run1", ownerSessionId: "session1", clock: () => now };
	const c = await SwarmController.open({ ...options, create: { ...specification, limits } });
	return { root, c, options, set time(value) { now = value; } };
}
async function register(c, id) {
	await c.owner("worker.create", { id, specialization: id, brief: "Focused work", reason: "Independent work", workloadRevision: c.snapshot().revision });
	return c.worker(id);
}
async function createTask(c, id) {
	return c.owner("task.create", { id, title: id, criteria: [0], dependencies: [] });
}
async function settleTask(c, taskId) {
	const task = c.snapshot().tasks.find(task => task.id === taskId);
	await c.system("assignment.settle", { taskId, assignmentId: task.assignment.id });
}
async function pause(c) {
	await c.owner("run.pause");
	for (const task of c.snapshot().tasks.filter(task => task.assignment)) await settleTask(c, task.id);
	await c.system("run.settle");
}

test("durable observers are read-only, isolated from commits and removable", async t => {
	const { c } = await fixture(t);
	const events = [];
	const unsubscribe = c.subscribe(event => {
		assert.equal(c.snapshot().revision, event.revision);
		assert.deepEqual(Object.keys(event).sort(), ["revision", "type"]);
		assert.ok(Object.isFrozen(event));
		events.push(event);
		throw new Error("Presentation failed");
	});
	await c.owner("run.resume", { reconciled: true });
	assert.equal(events.length, 1);
	await assert.rejects(c.close(), { code: "UNSETTLED" });
	await createTask(c, "task1");
	assert.equal(events.length, 2, "failed close must retain observation of the still-owned run");
	unsubscribe();
	await pause(c);
	assert.equal(events.length, 2);
	await c.close();
});

test("durable model-free workflow releases ownership only after settlement", async t => {
	const { c, root } = await fixture(t);
	await c.owner("run.resume", { reconciled: true });
	const builder = await register(c, "builder");
	const reviewer = await register(c, "reviewer");
	await createTask(c, "schema");
	await builder.dispatch("task.claim", { taskId: "schema", kind: "build", assignmentId: "build1" });
	await builder.dispatch("task.submit", { taskId: "schema", summary: "Mock candidate" });
	await settleTask(c, "schema");
	await reviewer.dispatch("task.claim", { taskId: "schema", kind: "review", assignmentId: "review1" });
	await reviewer.dispatch("task.review", { taskId: "schema", approved: true, summary: "Mock independent review" });
	await settleTask(c, "schema");
	await c.system("run.verify");
	await c.system("run.complete", { evidence: "mock-final-receipt" });
	assert.equal(c.snapshot().status, "completed");
	assert.equal(existsSync(join(prepareLayout(root, "run1").stateRoot, "reservation.json")), false);
	const next = await SwarmController.open({ workspace: root, runId: "run2", ownerSessionId: "session2", create: specification });
	await next.close(); await c.close();
});

test("paused history can be reopened only by the same owner and remains reserved", async t => {
	const { c, options, root } = await fixture(t);
	await c.owner("run.resume", { reconciled: true });
	await register(c, "builder"); await createTask(c, "schema");
	await pause(c); const before = c.snapshot(); await c.close();
	await assert.rejects(SwarmController.open({ ...options, runId: "other", create: specification }), /another running or paused swarm/);
	await assert.rejects(SwarmController.open({ ...options, ownerSessionId: "different" }), code("AUTHORITY"));
	const reopened = await SwarmController.open(options);
	assert.deepEqual(reopened.snapshot(), before);
	const copy = reopened.snapshot(); copy.objective = "changed";
	assert.notEqual(reopened.snapshot().objective, "changed");
	await reopened.owner("run.stop"); await reopened.system("run.settle");
	assert.equal(existsSync(join(prepareLayout(root, "run1").stateRoot, "reservation.json")), false);
	await reopened.close();
});

test("concurrent claims are serialized and revision checks cannot be bypassed", async t => {
	const { c } = await fixture(t);
	await c.owner("run.resume", { reconciled: true });
	const first = await register(c, "first"); const second = await register(c, "second");
	await createTask(c, "schema"); const expectedRevision = c.snapshot().revision;
	const outcomes = await Promise.allSettled([
		first.dispatch("task.claim", { taskId: "schema", kind: "build", assignmentId: "a1" }, { expectedRevision }),
		second.dispatch("task.claim", { taskId: "schema", kind: "build", assignmentId: "a2" }, { expectedRevision }),
	]);
	assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
	assert.equal(outcomes[1].reason.code, "REVISION");
	await pause(c); await c.close();
});

test("idempotent retries survive lifecycle generation changes and replay", async t => {
	const { c, options } = await fixture(t);
	await c.owner("run.resume", { reconciled: true });
	const receipt = await c.owner("run.pause", {}, { operationId: "pause-once" });
	const retry = await c.owner("run.pause", {}, { operationId: "pause-once" });
	assert.deepEqual(retry, receipt);
	await assert.rejects(c.owner("run.stop", {}, { operationId: "pause-once" }), code("DUPLICATE"));
	await c.system("run.settle"); await c.close();
	const reopened = await SwarmController.open(options);
	assert.deepEqual(await reopened.owner("run.pause", {}, { operationId: "pause-once" }), receipt);
	assert.equal(reopened.snapshot().status, "paused");
	await reopened.close();
});

test("queued commands capture input and worker capabilities stay generation-fenced", async t => {
	const { c } = await fixture(t);
	await c.owner("run.resume", { reconciled: true });
	const builder = await register(c, "builder");
	const payload = { id: "schema", title: "Original", criteria: [0], dependencies: [] };
	const operation = c.owner("task.create", payload); payload.title = "Changed";
	await operation; assert.equal(c.snapshot().tasks[0].title, "Original");
	await pause(c); await c.owner("run.resume", { reconciled: true });
	await assert.rejects(builder.dispatch("message.send", { to: "owner", text: "late" }), code("FENCED"));
	await c.worker("builder").dispatch("message.send", { to: "owner", text: "current" });
	await pause(c); await c.close();
});

test("restart resets allowance, preserves history, and respects a different checkout owner", async t => {
	const f = await fixture(t);
	await f.c.owner("run.resume", { reconciled: true });
	f.time = 100; await f.c.owner("run.stop"); await f.c.system("run.settle");
	const other = await SwarmController.open({ ...f.options, runId: "run2", create: specification });
	await assert.rejects(SwarmController.open(f.options), { code: "EEXIST" });
	await other.owner("run.stop"); await other.system("run.settle");
	const restarted = await SwarmController.open(f.options);
	assert.equal(restarted.snapshot().status, "stopped");
	await restarted.owner("run.restart", { reconciled: true });
	assert.equal(restarted.snapshot().elapsedMs, 0);
	assert.equal(restarted.snapshot().cycles[0].elapsedMs, 100);
	await pause(restarted); await restarted.close();
});

test("duration expiry is journaled before more worker work can be dispatched", async t => {
	const f = await fixture(t, { durationMs: 100 });
	await f.c.owner("run.resume", { reconciled: true });
	const builder = await register(f.c, "builder");
	f.time = 100;
	await assert.rejects(builder.dispatch("message.send", { to: "owner", text: "late" }), code("FENCED"));
	assert.equal(f.c.snapshot().status, "pausing");
	assert.equal(f.c.snapshot().messages.length, 0);
	await f.c.system("run.settle"); await f.c.close();
	const reopened = await SwarmController.open(f.options);
	assert.equal(reopened.snapshot().status, "paused");
	assert.equal(reopened.snapshot().elapsedMs, 100);
	await reopened.close();
});

test("failed fsync publishes no state and fences all further writes", async t => {
	const root = repository(t); let fail = false;
	const io = { writeAll, sync(fd) { if (fail) throw new Error("injected fsync failure"); fsyncSync(fd); } };
	const c = await SwarmController.open({ workspace: root, runId: "run1", ownerSessionId: "session1", create: specification, clock: () => 0, journalIo: io });
	const before = c.snapshot(); fail = true;
	await assert.rejects(c.owner("run.resume", { reconciled: true }), /injected/);
	assert.deepEqual(c.snapshot(), before);
	await assert.rejects(c.owner("run.resume", { reconciled: true }), code("FAULT"));
	await assert.rejects(c.close(), code("FAULT"));
	assert.equal(existsSync(join(prepareLayout(root, "run1").stateRoot, "controller.lock")), true);
});

test("controller refuses validly checksummed but invalid state transitions", async t => {
	const root = repository(t);
	const layout = prepareLayout(root, "run1"); const lease = acquireLease(layout); privateDirectory(layout.runRoot);
	const journal = openJournal(layout.journalPath, lease.assertOwned);
	journal.append({ version: 99, type: "unsupported" }); journal.close(); lease.release();
	const before = readFileSync(layout.journalPath);
	await assert.rejects(SwarmController.open({ workspace: root, runId: "run1", ownerSessionId: "session1" }), code("INPUT"));
	assert.deepEqual(readFileSync(layout.journalPath), before);
	assert.equal(existsSync(layout.reservationPath), true);
});

test("recovery of recorded running state pauses without replaying task actions", async t => {
	const root = repository(t);
	const layout = prepareLayout(root, "run1"); const lease = acquireLease(layout); privateDirectory(layout.runRoot);
	const journal = openJournal(layout.journalPath, lease.assertOwned);
	const m = machine();
	m.events[0].payload.workspaceRoot = root;
	m.start();
	for (const event of m.events) journal.append(event);
	journal.close(); lease.release();
	const c = await SwarmController.open({ workspace: root, runId: "run1", ownerSessionId: "session1", clock: () => 10000 });
	assert.equal(c.snapshot().status, "paused");
	assert.equal(c.snapshot().elapsedMs, 0);
	assert.equal(c.snapshot().cycle, 1);
	await c.close();
});

test("unsettled recovery stays fenced and cannot close or restart", async t => {
	const root = repository(t);
	const layout = prepareLayout(root, "run1"); const lease = acquireLease(layout); privateDirectory(layout.runRoot);
	const journal = openJournal(layout.journalPath, lease.assertOwned);
	const m = machine(); m.events[0].payload.workspaceRoot = root;
	m.start(); m.worker("builder"); m.task("schema"); m.claim("builder", "schema");
	for (const event of m.events) journal.append(event);
	journal.close(); lease.release();
	const c = await SwarmController.open({ workspace: root, runId: "run1", ownerSessionId: "session1", clock: () => 10000 });
	assert.equal(c.snapshot().status, "pausing");
	await assert.rejects(c.owner("run.restart", { reconciled: true }), code("STATE"));
	await assert.rejects(c.close(), code("UNSETTLED"));
	await settleTask(c, "schema"); await c.system("run.settle"); await c.close();
});

test("uncommitted source and staged index content remain untouched by storage", async t => {
	const { c, root } = await fixture(t);
	const source = join(root, "source.txt"); writeFileSync(source, "user work\n");
	execFileSync("git", ["-C", root, "add", "source.txt"]);
	writeFileSync(source, "more user work\n");
	const index = readFileSync(join(root, ".git", "index"));
	await c.close();
	assert.equal(readFileSync(source, "utf8"), "more user work\n");
	assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
});
