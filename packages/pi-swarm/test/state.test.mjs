import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, reduceEvent } from "../extensions/swarm/state.mjs";
import { machine } from "./helpers.mjs";

const code = expected => error => error.code === expected;

function setup(limits) {
	const m = machine(limits);
	m.start(); m.worker("builder"); m.worker("reviewer");
	return m;
}

test("defaults, replay, and pure immutable transitions", () => {
	const m = setup();
	assert.deepEqual(m.state.limits, DEFAULT_LIMITS);
	const before = structuredClone(m.state);
	const reference = m.state;
	m.task("schema");
	assert.deepEqual(reference, before);
	assert.deepEqual(m.events.reduce(reduceEvent, null), m.state);
	assert.equal(m.state.workers[0].specialization, "specialist builder");
});

test("strict event schemas and approved criteria reject malformed input", () => {
	const m = setup();
	assert.throws(() => m.send("owner", "task.create", { id: "t", title: "T", criteria: [8], dependencies: [] }), code("SCOPE"));
	assert.throws(() => m.send("owner", "run.redirect", { text: "x", tools: ["bash"] }), code("INPUT"));
	assert.throws(() => m.task("t", ["missing"]), code("NOT_FOUND"));
	assert.throws(() => m.worker("owner"), code("INPUT"));
	assert.throws(() => m.send("owner", "run.pause", {}, { version: 99 }), code("INPUT"));
});

test("workers cannot authorize lifecycle, budgets, or runtime settlement", () => {
	const m = setup();
	for (const [type, payload] of [["run.pause", {}], ["run.restart", { reconciled: true }], ["limits.update", { limits: DEFAULT_LIMITS }], ["run.settle", {}]]) {
		assert.throws(() => m.send("builder", type, payload), code("AUTHORITY"));
	}
});

test("agent recruitment checks capacity, observed revision, and uniqueness", () => {
	const m = setup({ agents: 2, active: 2 });
	assert.throws(() => m.worker("third"), code("AGENT_LIMIT"));
	const n = setup();
	assert.throws(() => n.send("builder", "worker.create", { id: "new", specialization: "database", brief: "work", reason: "independent", workloadRevision: 0 }), code("REVISION"));
	assert.throws(() => n.worker("builder"), code("DUPLICATE"));
	n.send("builder", "worker.create", { id: "new", specialization: "database", brief: "work", reason: "independent", workloadRevision: n.state.revision });
	assert.equal(n.state.workers.length, 3);
});

test("task ceiling prevents growth but not execution of existing tasks", () => {
	const m = setup({ tasks: 1 });
	m.task("schema");
	assert.throws(() => m.task("extra"), code("TASK_LIMIT"));
	m.claim("builder", "schema");
	assert.equal(m.state.tasks[0].status, "assigned");
});

test("claims are revision-fenced and dependencies must finish first", () => {
	const m = setup();
	m.task("schema"); m.task("api", ["schema"]);
	assert.throws(() => m.claim("builder", "api"), code("DEPENDENCY"));
	const revision = m.state.revision;
	m.claim("builder", "schema");
	assert.throws(() => m.send("reviewer", "task.claim", { taskId: "schema", kind: "build", assignmentId: "late" }, { expectedRevision: revision }), code("REVISION"));
	assert.throws(() => m.claim("reviewer", "schema"), code("OWNERSHIP"));
});

test("reporting does not release an active slot until runtime settlement", () => {
	const m = setup({ active: 1 });
	m.task("schema"); m.task("api"); m.claim("builder", "schema");
	m.send("builder", "task.submit", { taskId: "schema", summary: "candidate" });
	assert.equal(m.state.tasks[0].status, "assigned");
	assert.throws(() => m.claim("reviewer", "api"), code("ACTIVE_LIMIT"));
	m.settle("schema"); m.claim("reviewer", "api");
	assert.equal(m.state.tasks[0].status, "submitted");
});

test("independent review is required and completion requires trusted verification", () => {
	const m = setup(); m.task("schema"); m.claim("builder", "schema");
	m.send("builder", "task.submit", { taskId: "schema", summary: "candidate" }); m.settle("schema");
	assert.throws(() => m.claim("builder", "schema", "review"), code("INDEPENDENCE"));
	assert.throws(() => m.send("system", "run.verify"), code("INCOMPLETE"));
	m.claim("reviewer", "schema", "review");
	m.send("reviewer", "task.review", { taskId: "schema", approved: true, summary: "Mock review evidence" }); m.settle("schema");
	m.send("system", "run.verify");
	assert.throws(() => m.send("owner", "run.complete", { evidence: "x" }), code("AUTHORITY"));
	m.send("system", "run.complete", { evidence: "mock-checks-receipt" });
	assert.equal(m.state.status, "completed");
});

test("failed attempts block at three; yields do not consume attempts", () => {
	const m = setup(); m.task("schema");
	m.claim("builder", "schema"); m.send("builder", "task.yield", { taskId: "schema", blocker: null }); m.settle("schema");
	assert.equal(m.state.tasks[0].failures, 0);
	for (let i = 0; i < 3; i++) {
		m.claim("builder", "schema");
		m.send("builder", "task.fail", { taskId: "schema", reason: "failed attempt" }); m.settle("schema");
	}
	assert.equal(m.state.tasks[0].status, "blocked");
	assert.equal(m.state.tasks[0].failureHistory.length, 3);
	assert.throws(() => m.send("owner", "task.unblock", { taskId: "schema" }), code("STATE"));
});

test("rejected review returns the task for correction and consumes one attempt", () => {
	const m = setup(); m.task("schema"); m.claim("builder", "schema");
	m.send("builder", "task.submit", { taskId: "schema", summary: "candidate" }); m.settle("schema");
	m.claim("reviewer", "schema", "review");
	m.send("reviewer", "task.review", { taskId: "schema", approved: false, summary: "Missing constraint" }); m.settle("schema");
	assert.equal(m.state.tasks[0].status, "ready");
	assert.equal(m.state.tasks[0].failures, 1);
});

test("pause fences old workers and does not pretend pending work settled", () => {
	const m = setup(); m.task("schema"); m.claim("builder", "schema");
	const generation = m.state.generation;
	const assignmentId = m.state.tasks[0].assignment.id;
	m.send("owner", "run.pause");
	assert.throws(() => m.send("builder", "task.submit", { taskId: "schema", summary: "late" }, { generation }), code("FENCED"));
	assert.throws(() => m.send("system", "run.settle"), code("UNSETTLED"));
	assert.throws(() => m.send("system", "assignment.settle", { taskId: "schema", assignmentId: "wrong" }), code("FENCED"));
	m.send("system", "assignment.settle", { taskId: "schema", assignmentId });
	m.send("system", "run.settle");
	assert.equal(m.state.status, "paused");
	assert.equal(m.state.tasks[0].status, "interrupted");
	assert.throws(() => m.send("owner", "run.resume", { reconciled: false }), code("STATE"));
});

test("assignment IDs cannot be reused to accept late settlement callbacks", () => {
	const m = setup(); m.task("schema"); m.claim("builder", "schema");
	const assignmentId = m.state.tasks[0].assignment.id;
	m.send("builder", "task.yield", { taskId: "schema", blocker: null }); m.settle("schema");
	assert.throws(() => m.send("builder", "task.claim", { taskId: "schema", kind: "build", assignmentId }), code("DUPLICATE"));
});

test("runtime counts wall time, excludes paused time, and pause does not renew allowance", () => {
	const m = setup({ durationMs: 100 });
	m.time = 40; m.send("owner", "run.pause"); m.send("system", "run.settle");
	m.time = 5000; m.send("owner", "run.resume", { reconciled: true });
	assert.equal(m.state.elapsedMs, 40);
	m.time = 5060; m.send("system", "run.tick");
	assert.equal(m.state.status, "pausing");
	m.send("system", "run.settle");
	assert.throws(() => m.send("owner", "run.resume", { reconciled: true }), code("TIME_LIMIT"));
	m.send("owner", "run.restart", { reconciled: true });
	assert.equal(m.state.elapsedMs, 0);
	assert.equal(m.state.cycle, 2);
	assert.equal(m.state.cycles[0].elapsedMs, 100);
});

for (const status of ["paused", "stopped", "completed", "failed"]) {
	test(`explicit restart from ${status} resets allowances and preserves history`, () => {
		const m = setup(); m.task("done"); m.finish("done");
		if (status === "completed") {
			m.send("system", "run.verify"); m.send("system", "run.complete", { evidence: "mock" });
		} else {
			m.task("unfinished"); m.claim("builder", "unfinished");
			m.send("builder", "task.fail", { taskId: "unfinished", reason: "attempt failed" }); m.settle("unfinished");
			const type = { paused: "run.pause", stopped: "run.stop", failed: "run.fail" }[status];
			m.send("owner", type, status === "failed" ? { reason: "driver failed" } : {});
			m.send("system", "run.settle");
		}
		m.time = 10000; m.send("owner", "run.restart", { reconciled: true });
		assert.equal(m.state.status, "running"); assert.equal(m.state.cycle, 2);
		assert.equal(m.state.elapsedMs, 0); assert.equal(m.state.tasks[0].status, "done");
		assert.equal(m.state.tasksCreated, status === "completed" ? 0 : 1);
		if (status !== "completed") {
			assert.equal(m.state.tasks[1].failures, 0);
			assert.equal(m.state.tasks[1].failureHistory.length, 1);
		}
	});
}

test("recovery does not charge offline time and still requires settlement", () => {
	const m = setup(); m.task("schema"); m.claim("builder", "schema");
	m.time = 20; m.send("system", "run.tick");
	m.time = 100000; m.send("system", "run.recover");
	assert.equal(m.state.elapsedMs, 20);
	assert.equal(m.state.status, "pausing");
	assert.throws(() => m.send("owner", "run.restart", { reconciled: true }), code("STATE"));
});

test("user guidance is durable, reaches every worker, and cannot restart a stopped run", () => {
	const m = setup(); m.task("schema");
	m.send("owner", "run.redirect", { text: "Use the existing email template" });
	assert.throws(() => m.claim("builder", "schema"), code("GUIDANCE"));
	assert.throws(() => m.send("reviewer", "message.send", { to: "builder", text: "old guidance" }), code("GUIDANCE"));
	m.send("builder", "worker.ack", { revision: 1 }); m.claim("builder", "schema");
	m.worker("later"); assert.equal(m.state.workers.at(-1).guidanceRevision, 1);
	m.send("owner", "run.stop"); m.settle("schema"); m.send("system", "run.settle");
	m.send("owner", "run.redirect", { text: "New guidance while stopped" });
	assert.equal(m.state.status, "stopped");
});

test("any peer can message another; messages do not occupy assignment slots", () => {
	const m = setup();
	m.send("builder", "message.send", { to: "reviewer", text: "Please inspect the schema" });
	m.send("reviewer", "message.send", { to: "builder", text: "Which constraint?" });
	assert.equal(m.state.messages.length, 2);
	assert.equal(m.state.tasks.filter(task => task.assignment).length, 0);
});

test("time moving backwards and malformed limits fail closed", () => {
	const m = setup(); m.time = 10; m.send("system", "run.tick"); m.time = 5;
	assert.throws(() => m.send("system", "run.tick"), code("CLOCK"));
	assert.throws(() => machine({ active: 9 }), code("INPUT"));
	assert.throws(() => machine({ tasks: 0 }), code("INPUT"));
});
