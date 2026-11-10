import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repository } from "./helpers.mjs";
import {
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { requestSafety } from "../extensions/swarm/host-gates.mjs";
import { reduceWorkspace } from "../extensions/swarm/workspace-state.mjs";
import { statusText } from "../extensions/swarm/ui.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { WorkspaceRuntime } from "../extensions/swarm/workspace.mjs";

const code = expected => error => error.code === expected;
const success = { exitCode: 0, stdout: "", stderr: "", settled: true, aborted: false };
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
async function fixture(t, options = {}) {
	const root = repository(t);
	writeFileSync(join(root, "source.txt"), "original\n");
	let now = 0;
	const config = { workspace: root, runId: "run1", ownerSessionId: "session1", clock: () => now };
	const c = await SwarmController.open({ ...config, create: { objective: "Build feature", criteria: ["Works"], scope: ["source.txt"], limits: options.limits } });
	const runtime = await WorkspaceRuntime.attach(c, { authorize: async () => true, ...options });
	await c.owner("run.resume", { reconciled: true });
	for (const id of ["builder", "reviewer", "other"]) {
		await c.owner("worker.create", { id, specialization: id, brief: "Focus", reason: "Independent work", workloadRevision: c.snapshot().revision });
	}
	await c.owner("task.create", { id: "task1", title: "Feature", criteria: [0], dependencies: [] });
	await c.worker("builder").dispatch("task.claim", { taskId: "task1", kind: "build", assignmentId: "build1" });
	return { root, c, runtime, worker: runtime.worker("builder"), config, set time(value) { now = value; } };
}
async function drain(f) {
	if (["running", "verifying"].includes(f.c.snapshot().status)) await f.c.owner("run.pause");
	for (const task of f.c.snapshot().tasks.filter(task => task.assignment)) await f.runtime.settle(task.id);
	if (["pausing", "stopping", "failing"].includes(f.c.snapshot().status)) await f.c.system("run.settle");
	await f.c.close();
}
async function candidate(f) {
	const result = await f.worker.shell("printf verified");
	await f.worker.submit("Candidate", [result.executionId]);
	await f.runtime.settle("task1");
	await f.c.worker("reviewer").dispatch("task.claim", { taskId: "task1", kind: "review", assignmentId: "review1" });
	return f.runtime.worker("reviewer");
}

test("actual guarded edits, verification command, independent review and final completion", async t => {
	const f = await fixture(t);
	f.worker.claim(["source.txt"]); await f.worker.read("source.txt");
	await f.worker.edit("source.txt", [{ oldText: "original", newText: "implemented" }]);
	const reviewer = await candidate(f);
	await reviewer.review(true, "Checked requirements and test relevance");
	await f.runtime.settle("task1");
	const final = await f.runtime.finalCheck("test -f source.txt");
	assert.equal(final.exitCode, 0);
	assert.equal(f.c.snapshot().status, "completed");
	assert.equal(f.c.snapshot().completionEvidence, final.executionId);
	assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "implemented\n");
	assert.equal(f.c.snapshot().workspace.receipts.length, 3);
	assert.equal(f.runtime.snapshot().coordination.active.length, 0);
});

test("nested native paths share claim and fresh-read identities through actual IO", async t => {
	const f = await fixture(t);
	mkdirSync(join(f.root, "Source"));
	const target = join(f.root, "Source", "File.txt");
	writeFileSync(target, "original\n");
	const claim = f.worker.claim([target]);
	assert.equal(claim.paths[0], process.platform === "win32" ? "source/file.txt" : "Source/File.txt");
	const readPath = process.platform === "win32" ? "SOURCE\\File.txt" : "Source/File.txt";
	const editPath = process.platform === "win32" ? "Source\\FILE.txt" : target;
	await f.worker.read(readPath);
	await f.worker.edit(editPath, [{ oldText: "original", newText: "implemented" }]);
	assert.equal(readFileSync(target, "utf8"), "implemented\n");
	assert.equal(f.c.snapshot().workspace.receipts.at(-1).paths[0], process.platform === "win32" ? "Source/FILE.txt" : "Source/File.txt");
	await f.worker.write(target, "updated\n");
	assert.equal(readFileSync(target, "utf8"), "updated\n");
	await drain(f);
});

test("claims and fresh post-acquisition reads are required; stale edits preserve user work", async t => {
	const f = await fixture(t);
	await f.worker.read("source.txt");
	await assert.rejects(f.worker.write("source.txt", "bad"), code("CLAIM_REQUIRED"));
	f.worker.claim(["source.txt"]);
	await assert.rejects(f.worker.write("source.txt", "bad"), code("STALE"));
	await f.worker.read("source.txt"); writeFileSync(join(f.root, "source.txt"), "user change\n");
	await assert.rejects(f.worker.write("source.txt", "bad"), code("STALE"));
	assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "user change\n");
	assert.equal(f.c.snapshot().workspace.operations.length, 0);
	await drain(f);
});

test("ignored explicit mutation targets retain stale checks and receipt fingerprints", async t => {
	const f = await fixture(t);
	writeFileSync(join(f.root, ".gitignore"), "/ignored.txt\n");
	writeFileSync(join(f.root, "ignored.txt"), "original");
	f.worker.claim(["ignored.txt"]);
	await f.worker.read("ignored.txt");
	writeFileSync(join(f.root, "ignored.txt"), "owner work");
	await assert.rejects(f.worker.write("ignored.txt", "bad"), code("STALE"));
	assert.equal(readFileSync(join(f.root, "ignored.txt"), "utf8"), "owner work");
	await f.worker.read("ignored.txt");
	await f.worker.write("ignored.txt", "approved change");
	const receipt = f.c.snapshot().workspace.receipts.at(-1);
	assert.notEqual(receipt.before, receipt.after);
	await drain(f);
});

test("host authorization defaults closed and late approval cannot revive paused work", async t => {
	const approval = deferred(); const entered = deferred();
	let launches = 0;
	const f = await fixture(t, { authorize: async () => { entered.resolve(); return approval.promise; }, runner: async () => { launches++; return success; } });
	const command = f.worker.shell("test");
	const rejected = assert.rejects(command);
	await entered.promise; await f.c.owner("run.pause"); approval.resolve(true);
	await rejected;
	assert.equal(launches, 0);
	assert.equal(f.c.snapshot().workspace.operations.length, 0);
	await drain(f);
	const root = repository(t);
	const c = await SwarmController.open({ workspace: root, runId: "closed1", ownerSessionId: "owner1", create: { objective: "x", criteria: ["x"], scope: ["x"] } });
	await WorkspaceRuntime.attach(c);
	await assert.rejects(WorkspaceRuntime.attach(c), code("OWNERSHIP"));
	await c.close();
});

test("pause retains execution ownership until the runner actually settles", async t => {
	const started = deferred(); const release = deferred();
	const f = await fixture(t, { runner: async ({ signal }) => { started.resolve(signal); await release.promise; return success; } });
	const command = f.worker.shell("long check"); const rejected = assert.rejects(command);
	const signal = await started.promise;
	await f.c.owner("run.pause");
	assert.equal(signal.aborted, true);
	assert.equal(f.c.snapshot().workspace.operations.length, 1);
	await assert.rejects(f.runtime.settle("task1"), code("UNSETTLED"));
	await assert.rejects(f.c.system("assignment.settle", { taskId: "task1", assignmentId: "build1" }), code("UNSETTLED"));
	await assert.rejects(f.c.system("run.settle"), code("UNSETTLED"));
	release.resolve(); await rejected;
	assert.equal(f.c.snapshot().workspace.operations.length, 0);
	assert.equal(f.c.snapshot().workspace.receipts.at(-1).outcome, "cancelled");
	await drain(f);
});

test("unsettled command result keeps its lease until explicit settlement attestation", async t => {
	const f = await fixture(t, { runner: async () => ({ ...success, settled: false }) });
	const command = f.worker.shell("background work"); const rejected = assert.rejects(command);
	const deadline = performance.now() + 5000;
	while (f.c.snapshot().status !== "pausing" && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(f.c.snapshot().status, "pausing");
	const id = f.c.snapshot().workspace.operations[0].id;
	assert.equal(f.runtime.snapshot().coordination.active.length, 1);
	assert.throws(() => f.runtime.confirmSettled(id, { settled: false }), code("AUTHORITY"));
	f.runtime.confirmSettled(id, { settled: true }); await rejected;
	assert.equal(f.c.snapshot().workspace.receipts.at(-1).outcome, "unknown");
	await drain(f);
});

test("successful textual claims and failed commands are not verification evidence", async t => {
	const f = await fixture(t);
	await assert.rejects(f.worker.submit("trust me", ["invented"]), code("EVIDENCE"));
	await assert.rejects(f.c.worker("builder").dispatch("task.submit", { taskId: "task1", summary: "no evidence" }), code("EVIDENCE"));
	const failed = await f.worker.shell("printf 'all tests passed'; exit 7");
	assert.equal(failed.exitCode, 7);
	await assert.rejects(f.worker.submit("looks successful", [failed.executionId]), code("EVIDENCE"));
	await drain(f);
});

test("external changes invalidate receipts and submitted candidates without rollback", async t => {
	const f = await fixture(t);
	const checked = await f.worker.shell("true");
	writeFileSync(join(f.root, "source.txt"), "external\n");
	await assert.rejects(f.worker.submit("stale", [checked.executionId]), code("EVIDENCE"));
	const reviewer = await candidate(f);
	writeFileSync(join(f.root, "source.txt"), "more external\n");
	await assert.rejects(reviewer.review(true, "stale review"), code("EVIDENCE"));
	assert.equal(f.c.snapshot().tasks[0].candidate, null);
	assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "more external\n");
	await drain(f);
});

test("a reviewer who edits becomes a contributor and needs a different reviewer", async t => {
	const f = await fixture(t);
	const reviewer = await candidate(f);
	reviewer.claim(["source.txt"]); await reviewer.read("source.txt");
	await reviewer.write("source.txt", "review correction\n");
	assert.equal(f.c.snapshot().tasks[0].assignment.kind, "build");
	assert.ok(f.c.snapshot().tasks[0].contributors.includes("reviewer"));
	await assert.rejects(reviewer.review(true, "self approve"), code("STATE"));
	const checked = await reviewer.shell("true");
	await reviewer.submit("Corrected candidate", [checked.executionId]); await f.runtime.settle("task1");
	await assert.rejects(f.c.worker("reviewer").dispatch("task.claim", { taskId: "task1", kind: "review", assignmentId: "self-review" }), code("INDEPENDENCE"));
	await f.c.worker("other").dispatch("task.claim", { taskId: "task1", kind: "review", assignmentId: "other-review" });
	await f.runtime.worker("other").review(true, "Independent correction review"); await f.runtime.settle("task1");
	await f.runtime.finalCheck("true");
	assert.equal(f.c.snapshot().status, "completed");
});

test("source-writing final checks cannot complete the run", async t => {
	const f = await fixture(t);
	const reviewer = await candidate(f); await reviewer.review(true, "Reviewed"); await f.runtime.settle("task1");
	await assert.rejects(f.runtime.finalCheck("printf changed > source.txt"), code("EVIDENCE"));
	assert.notEqual(f.c.snapshot().status, "completed");
	assert.equal(f.c.snapshot().tasks[0].status, "ready");
	await drain(f);
});

test("guidance fences pending authorization and requires fresh reads after acknowledgment", async t => {
	const approval = deferred(); const entered = deferred();
	const f = await fixture(t, { authorize: async () => { entered.resolve(); return approval.promise; } });
	f.worker.claim(["source.txt"]); await f.worker.read("source.txt");
	const edit = f.worker.write("source.txt", "late"); const rejected = assert.rejects(edit);
	await entered.promise; await f.c.owner("run.redirect", { text: "Do not use the pending change" });
	approval.resolve(true); await rejected;
	await f.c.worker("builder").dispatch("worker.ack", { revision: 1 });
	f.worker.claim(["source.txt"]);
	await assert.rejects(f.worker.write("source.txt", "no fresh read"), code("STALE"));
	assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "original\n");
	await drain(f);
});

test("rejected candidates cannot be resubmitted through raw bound dispatch", async t => {
	const f = await fixture(t);
	const reviewer = await candidate(f);
	await reviewer.review(false, "Needs correction"); await f.runtime.settle("task1");
	await f.c.worker("builder").dispatch("task.claim", { taskId: "task1", kind: "build", assignmentId: "retry1" });
	await assert.rejects(f.c.worker("builder").dispatch("task.submit", { taskId: "task1", summary: "Reuse rejected evidence" }), code("EVIDENCE"));
	assert.equal(f.c.snapshot().workspace.candidates.length, 0);
	await drain(f);
});

test("cross-task authors cannot independently approve the shared workspace", async t => {
	const f = await fixture(t);
	f.worker.claim(["source.txt"]); await f.worker.read("source.txt");
	await f.worker.write("source.txt", "implementation for another task\n");
	await candidate(f);
	await f.c.owner("task.create", { id: "task2", title: "Second feature", criteria: [0], dependencies: [] });
	await f.c.worker("other").dispatch("task.claim", { taskId: "task2", kind: "build", assignmentId: "build2" });
	const second = f.runtime.worker("other");
	const result = await second.shell("true");
	await second.submit("Existing implementation", [result.executionId]); await f.runtime.settle("task2");
	await assert.rejects(f.c.worker("builder").dispatch("task.claim", { taskId: "task2", kind: "review", assignmentId: "cross-self-review" }), code("INDEPENDENCE"));
	await drain(f);
});

test("reconciliation attributes interrupted reviewer mutations conservatively", async t => {
	const f = await fixture(t);
	await candidate(f);
	const before = f.c.snapshot().workspace.fingerprint;
	await f.c.system("workspace.start", { id: "interrupted-write", taskId: "task1", assignmentId: "review1", kind: "write", command: null, paths: ["source.txt"], before });
	writeFileSync(join(f.root, "source.txt"), "interrupted reviewer edit\n");
	await f.c.owner("run.pause");
	await assert.rejects(f.c.system("assignment.settle", { taskId: "task1", assignmentId: "review1" }), code("UNSETTLED"));
	await f.runtime.reconcile({ settled: true });
	assert.ok(f.c.snapshot().workspace.contributors.includes("reviewer"));
	assert.ok(f.c.snapshot().tasks[0].contributors.includes("reviewer"));
	assert.equal(f.c.snapshot().workspace.receipts.at(-1).outcome, "unknown");
	await drain(f);
	const reopened = await SwarmController.open(f.config);
	assert.ok(reopened.snapshot().workspace.contributors.includes("reviewer"));
	assert.equal(reopened.snapshot().workspace.operations.length, 0);
	await reopened.close();
});

test("deadline expiry during execution still records settlement under the new generation", async t => {
	const ready = deferred(); const release = deferred();
	const f = await fixture(t, { limits: { durationMs: 100 }, runner: async () => { ready.resolve(); await release.promise; return success; } });
	const command = f.worker.shell("slow"); const rejected = assert.rejects(command);
	await ready.promise; f.time = 100; release.resolve(); await rejected;
	assert.equal(f.c.snapshot().status, "pausing");
	assert.equal(f.c.snapshot().workspace.operations.length, 0);
	assert.equal(f.c.snapshot().workspace.receipts.at(-1).outcome, "cancelled");
	await drain(f);
});


test("ignored-file observation scope survives a controller reload", async t => {
	const f = await fixture(t);
	writeFileSync(join(f.root, ".gitignore"), "/ignored.txt\n");
	writeFileSync(join(f.root, "ignored.txt"), "original");
	f.worker.claim(["ignored.txt"]); await f.worker.read("ignored.txt");
	await f.worker.write("ignored.txt", "approved change");
	const checked = await f.worker.shell("true");
	await f.worker.submit("Candidate including ignored target", [checked.executionId]);
	await f.runtime.settle("task1");
	await drain(f);
	const controller = await SwarmController.open(f.config);
	try {
		const runtime = await WorkspaceRuntime.attach(controller, { authorize: async () => true });
		await controller.owner("run.resume", { reconciled: true });
		await controller.worker("reviewer").dispatch("task.claim", { taskId: "task1", kind: "review", assignmentId: "review-reloaded" });
		await runtime.worker("reviewer").review(true, "Reload retained the same scoped evidence");
		await runtime.settle("task1");
		assert.equal(controller.snapshot().tasks[0].status, "done");
		await controller.owner("run.pause");
		await controller.system("run.settle");
	} finally { await controller.close(); }
});

test("concurrent claimant edit and rejected submission preserve progress and strict freshness", async t => {
	const f = await fixture(t, { runner: async () => success });
	const checked = await f.worker.shell("offline verification");
	await f.c.owner("task.create", { id: "task2", title: "Other work", criteria: [0], dependencies: [] });
	await f.c.worker("other").dispatch("task.claim", { taskId: "task2", kind: "build", assignmentId: "build2" });
	const other = f.runtime.worker("other");
	other.claim(["source.txt"]); await other.read("source.txt");
	await assert.rejects(f.worker.submit("not queued", [checked.executionId]), error => {
		assert.equal(error.code, "BUSY");
		assert.match(error.message, /"workerId":"other"/);
		assert.match(error.message, /"stage":"claims-held"/);
		assert.ok(!error.message.includes("source.txt"));
		return true;
	});
	assert.equal(f.runtime.snapshot().coordination.pending.length, 0);
	await other.edit("source.txt", [{ oldText: "original", newText: "created after verification" }]);
	other.release();
	for (let attempt = 0; attempt < 3; attempt++) {
		await assert.rejects(f.worker.submit("stale", [checked.executionId]), { code: "EVIDENCE", message: "Verification receipt rejected: stale-before-and-after" });
		assert.equal(f.runtime.snapshot().coordination.active.length, 0);
		assert.equal(f.runtime.snapshot().coordination.pending.length, 0);
		assert.equal(f.c.snapshot().tasks[0].pending, null);
	}
	const current = await f.worker.shell("offline current verification");
	await f.worker.submit("current", [current.executionId]); await f.runtime.settle("task1");
	assert.equal(f.c.snapshot().tasks[0].status, "submitted");
	await drain(f);
});

test("receipt rejection diagnoses every unchanged safety predicate without leaking receipt data", async t => {
	const f = await fixture(t, { runner: async () => success });
	const checked = await f.worker.shell("offline verification");
	const initial = f.c.snapshot();
	const event = { actor: "system", type: "workspace.candidate", payload: {
		taskId: "task1", assignmentId: "build1", fingerprint: initial.workspace.fingerprint, receipts: [checked.executionId],
	} };
	const changed = "a".repeat(64) === initial.workspace.fingerprint ? "b".repeat(64) : "a".repeat(64);
	for (const [fields, reason] of [
		[{ kind: "write" }, "wrong-kind"], [{ taskId: "task2" }, "wrong-task"], [{ assignmentId: "other" }, "wrong-assignment"],
		[{ outcome: "failed" }, "unsuccessful-outcome"], [{ outcome: "unknown" }, "unsuccessful-outcome"], [{ exitCode: 7 }, "unsuccessful-exit"],
		[{ cycle: 0 }, "wrong-cycle"], [{ generation: 99 }, "wrong-generation"], [{ guidanceRevision: 1 }, "changed-guidance"],
		[{ before: changed }, "stale-before"], [{ after: changed }, "stale-after"], [{ before: changed, after: changed }, "stale-before-and-after"],
	]) {
		const state = structuredClone(initial);
		Object.assign(state.workspace.receipts[0], fields);
		assert.throws(() => reduceWorkspace(state, event), { code: "EVIDENCE", message: `Verification receipt rejected: ${reason}` });
	}
	const missing = structuredClone(initial); missing.workspace.receipts = [];
	assert.throws(() => reduceWorkspace(missing, event), { code: "EVIDENCE", message: "Verification receipt rejected: missing-receipt" });
	reduceWorkspace(structuredClone(initial), event);
	await drain(f);
});

test("queued submission exposes active Safety stage and cancellation waits for approval settlement", async t => {
	let requests = 0; const entered = deferred(); const approval = deferred();
	const f = await fixture(t, { runner: async () => success, authorize: async () => {
		if (++requests === 1) return true;
		entered.resolve(); return approval.promise;
	} });
	await f.c.owner("task.create", { id: "task2", title: "Other work", criteria: [0], dependencies: [] });
	await f.c.worker("other").dispatch("task.claim", { taskId: "task2", kind: "build", assignmentId: "build2" });
	const other = f.runtime.worker("other");
	const receipt = await other.shell("private fixture command");
	const shell = f.worker.shell("another private fixture command"); const rejectedShell = assert.rejects(shell);
	await entered.promise;
	const submit = other.submit("queued behind approval", [receipt.executionId]); const rejectedSubmit = assert.rejects(submit);
	const status = f.runtime.coordinationStatus();
	assert.equal(status.active[0].workerId, "builder"); assert.equal(status.active[0].purpose, "shell");
	assert.equal(status.active[0].stage, "approval"); assert.equal(status.pending[0].purpose, "submit");
	assert.equal(status.pending[0].stage, "queued");
	const mainStatus = statusText({ run: f.c.snapshot(), workspace: f.runtime.snapshot(), errors: [] });
	assert.match(mainStatus, /"stage": "approval"/); assert.ok(!mainStatus.includes("private fixture command"));
	await f.c.owner("run.pause"); await rejectedSubmit;
	assert.equal(f.runtime.coordinationStatus().active[0].cancellationRequested, true);
	await assert.rejects(f.runtime.settle("task1"), code("UNSETTLED"));
	approval.resolve(true); await rejectedShell;
	assert.equal(f.c.snapshot().workspace.operations.length, 0);
	for (const id of ["task1", "task2"]) await f.runtime.settle(id);
	await f.c.system("run.settle");
	assert.equal(f.runtime.coordinationStatus().counts.active, 0);
	await f.c.owner("run.resume", { reconciled: true });
	await f.c.worker("builder").dispatch("task.unblock", { taskId: "task1" });
	await f.c.worker("builder").dispatch("task.claim", { taskId: "task1", kind: "build", assignmentId: "after-resume" });
	const resumed = f.runtime.worker("builder"); resumed.claim(["source.txt"]);
	await assert.rejects(resumed.write("source.txt", "without fresh read"), code("STALE"));
	await resumed.read("source.txt"); resumed.release();
	await drain(f);
});

test("concurrent same-assignment authorization requests settle one denial without reprompting", async t => {
	const entered = deferred(); const decision = deferred(); let requests = 0;
	const f = await fixture(t, { authorize: async () => { requests++; entered.resolve(); return decision.promise; } });
	f.worker.claim(["source.txt"]); await f.worker.read("source.txt");
	const first = assert.rejects(f.worker.write("source.txt", "first"), code("AUTHORITY"));
	await entered.promise;
	const second = assert.rejects(f.worker.write("source.txt", "second"), code("AUTHORITY"));
	const third = assert.rejects(f.worker.write("source.txt", "third"), code("AUTHORITY"));
	assert.equal(requests, 1);
	decision.resolve(false); await Promise.all([first, second, third]);
	assert.equal(requests, 1);
	assert.equal(f.runtime.coordinationStatus().counts.active, 0);
	assert.equal(f.c.snapshot().workspace.operations.length, 0);
	assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "original\n");
	f.worker.release(); await drain(f);
});

for (const refusal of ["denied", "timed-out"]) test(`Safety ${refusal} cannot re-prompt even after changed guidance`, async t => {
	let requests = 0;
	const events = { emit(_name, { claim }) { requests++; claim(() => refusal === "denied" ? { approved: false } : new Promise(() => {})); } };
	const f = await fixture(t, { authorize: async request => (await requestSafety({ events,
		request: { agent: request.workerId, tool: request.kind, path: request.paths[0] }, signal: request.signal, timeoutMs: 10,
	})).approved });
	f.worker.claim(["source.txt"]); await f.worker.read("source.txt");
	await assert.rejects(f.worker.write("source.txt", "denied"), code("AUTHORITY"));
	for (let i = 0; i < 3; i++) await assert.rejects(f.worker.shell("no retry"), code("AUTHORITY"));
	await f.c.owner("run.redirect", { text: "Refined objective, not new permission" });
	await f.c.worker("builder").dispatch("worker.ack", { revision: 1 });
	await assert.rejects(f.worker.shell("still no retry"), code("AUTHORITY"));
	assert.equal(requests, 1);
	f.worker.claim(["source.txt"]); await f.worker.read("source.txt"); f.worker.release();
	await f.c.worker("builder").dispatch("task.yield", { taskId: "task1", blocker: "Owner policy decision needed" });
	await f.runtime.settle("task1");
	assert.equal(f.c.snapshot().tasks[0].assignment, null);
	assert.equal(f.runtime.coordinationStatus().counts.claims, 0);
	assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "original\n");
	await drain(f);
});

for (const action of ["fail", "yield"]) test(`${action} report retains claims until actual assignment settlement`, async t => {
	const f = await fixture(t);
	f.worker.claim(["source.txt"]); await f.worker.read("source.txt");
	await f.c.worker("builder").dispatch(`task.${action}`, { taskId: "task1", ...(action === "fail" ? { reason: "Reported failure" } : { blocker: null }) });
	assert.equal(f.runtime.coordinationStatus().counts.claims, 1);
	assert.ok(f.c.snapshot().tasks[0].assignment);
	await f.runtime.settle("task1");
	assert.equal(f.runtime.coordinationStatus().counts.claims, 0);
	assert.equal(f.c.snapshot().tasks[0].assignment, null);
	assert.equal(f.c.snapshot().tasks[0].failures, action === "fail" ? 1 : 0);
	await drain(f);
});
