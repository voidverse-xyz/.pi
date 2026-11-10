// Replay actual PTY-produced durable events, not continuation request envelopes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reduceEvent } from "../../extensions/swarm/state.mjs";

const records = readFileSync(process.argv[2], "utf8").trim().split("\n").map(JSON.parse);
let state = null;
let resumes = 0;
let restarts = 0;
for (const { payload: event } of records) {
	const previous = state;
	state = reduceEvent(state, event);
	assert.equal(state.objective, "Edited terminal goal");
	assert.deepEqual(state.criteria, ["Observable outcome"]);
	assert.deepEqual(state.scope, ["Only disposable project"]);
	if (event.type !== "host.continue") continue;
	assert.equal(state.status, "running");
	if (!event.payload.restart) {
		resumes++;
		assert.equal(state.cycle, 1);
		assert.equal(state.elapsedMs, previous.elapsedMs);
		assert.equal(state.tasksCreated, previous.tasksCreated);
		assert.deepEqual(state.cycles, []);
		continue;
	}
	restarts++;
	assert.equal(state.cycle, 2);
	assert.equal(state.generation, previous.generation + 1);
	assert.ok(previous.elapsedMs > 0, "Restart must reset a consumed time allowance");
	assert.equal(state.elapsedMs, 0);
	assert.equal(state.tasksCreated, 0); // No tasks exist before this fixture's restart.
	assert.deepEqual(state.tasks, []);
	assert.equal(state.completionEvidence, null);
	assert.equal(state.failureReason, null);
	assert.equal(state.cycles.length, 1);
	assert.equal(state.cycles[0].cycle, 1);
	assert.equal(state.cycles[0].elapsedMs, previous.elapsedMs);
	assert.equal(state.cycles[0].tasksCreated, previous.tasksCreated);
}
assert.equal(resumes, 2);
assert.equal(restarts, 1);
assert.equal(state.cycle, 2);
assert.equal(state.status, "stopped");
assert.equal(state.tasksCreated, 1, "Post-restart task consumes the new allowance");
