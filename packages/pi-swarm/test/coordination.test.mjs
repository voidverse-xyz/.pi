import test from "node:test";
import assert from "node:assert/strict";
import { coordinationHandoffs } from "../extensions/swarm/coordination.mjs";

function fixture() {
	return {
		status: "running", cycle: 1, generation: 0, guidanceRevision: 0, limits: { attempts: 3, agents: 4 },
		workers: [{ id: "builder" }, { id: "reviewer" }],
		workspace: { operations: [], contributors: ["builder"], candidates: [], fingerprint: "snapshot" },
		tasks: [{ id: "first", status: "submitted", assignment: null, pending: null, blocker: null, failures: 0, dependencies: [], contributors: ["builder"] },
			{ id: "next", status: "ready", assignment: null, pending: null, blocker: null, failures: 0, dependencies: ["first"], contributors: [] }],
	};
}

test("only independent idle workers are offered settled review work", () => {
	const state = fixture();
	const handoffs = coordinationHandoffs(state);
	assert.deepEqual(handoffs.map(item => item.workerId), ["reviewer"]);
	assert.match(handoffs[0].reason, /independent review/);
	assert.deepEqual(coordinationHandoffs(state, new Set(["reviewer"])), []);
	state.tasks[0].assignment = { workerId: "builder" }; state.tasks[0].pending = { kind: "submit" };
	assert.deepEqual(coordinationHandoffs(state), [], "unsettled reports cannot admit a reviewer");
});

test("dependency settlement wakes a contributor and each transition is offered once", () => {
	const state = fixture(); state.tasks[0].status = "done";
	const handoffs = coordinationHandoffs(state, new Set(), new Set(), "reviewer");
	assert.deepEqual(handoffs.map(item => item.workerId), ["builder"]);
	assert.match(handoffs[0].reason, /dependencies have settled/);
	assert.deepEqual(coordinationHandoffs(state, new Set(), new Set(handoffs.map(item => item.key))), []);
	state.guidanceRevision++; assert.equal(coordinationHandoffs(state, new Set(), new Set(handoffs.map(item => item.key))).length, 1);
});

test("missing reviewer requests bounded peer recruitment rather than self approval", () => {
	const state = fixture(); state.workers.pop();
	const handoffs = coordinationHandoffs(state);
	assert.equal(handoffs.length, 1); assert.equal(handoffs[0].workerId, "builder");
	assert.match(handoffs[0].reason, /Recruit.*approved limits.*capacity blocker/);
});

test("paused, unknown, exhausted and blocked work never receives an automatic handoff", () => {
	const state = fixture(); state.status = "paused";
	assert.deepEqual(coordinationHandoffs(state), []);
	state.status = "running"; state.workspace.operations.push({ uncertain: true });
	assert.deepEqual(coordinationHandoffs(state), []);
	state.workspace.operations = []; state.tasks[0].failures = 3;
	assert.deepEqual(coordinationHandoffs(state), []);
	state.tasks[0].failures = 0; state.tasks[0].blocker = "owner decision";
	assert.deepEqual(coordinationHandoffs(state), []);
});

test("final verification wake requires every task and workspace operation to settle", () => {
	const state = fixture(); for (const task of state.tasks) task.status = "done";
	const handoffs = coordinationHandoffs(state);
	assert.equal(handoffs.length, 1); assert.match(handoffs[0].reason, /swarm_finish/);
	assert.deepEqual(coordinationHandoffs(state, new Set(["builder"])), [], "queued mail or active work precedes final handoff");
	state.workspace.operations.push({ uncertain: false }); assert.deepEqual(coordinationHandoffs(state), []);
});
