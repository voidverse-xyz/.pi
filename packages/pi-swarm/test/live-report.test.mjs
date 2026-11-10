import test from "node:test";
import assert from "node:assert/strict";
import { finishTrial } from "./live/report.mjs";

function fixture() {
	const calls = [];
	const host = {
		async pause() { calls.push("pause"); return { settled: true }; },
		snapshot() { return { run: { status: "completed", workers: [{ id: "builder" }], tasks: [], sessions: { turns: [] }, workspace: { operations: [] } } }; },
		history() { return [{ type: "message", message: { role: "assistant", usage: { input: 3, output: 2, totalTokens: 5 } } }]; },
		async close() { calls.push("close"); },
	};
	return { host, calls, onFailure(phase, error) { calls.push([phase, error.code]); } };
}

test("trial reports settled completion and usage before close without provider access", async () => {
	const f = fixture();
	await finishTrial({ ...f, writeResult(result) {
		f.calls.push("report");
		assert.equal(result.status, "completed");
		assert.equal(result.responses, 1);
		assert.equal(result.usage.totalTokens, 5);
		assert.equal(result.cost, "unknown");
		assert.equal(result.pendingTurns, 0);
	} });
	assert.deepEqual(f.calls, ["pause", "report", "close"]);
});

for (const stage of ["history", "write"]) test(`trial ${stage} failure still closes and is reporting, not setup`, async () => {
	const f = fixture();
	const fail = () => { throw Object.assign(new Error("private text"), { code: "EIO" }); };
	if (stage === "history") f.host.history = fail;
	await finishTrial({ ...f, writeResult: stage === "write" ? fail : () => assert.fail("Unexpected write") });
	assert.deepEqual(f.calls, ["pause", ["reporting", "EIO"], "close"]);
});

test("trial incomplete settlement retains host and labels cleanup failure", async () => {
	const f = fixture();
	f.host.pause = async () => ({ settled: false });
	await finishTrial({ ...f, writeResult(result) { assert.equal(result.settled, false); } });
	assert.deepEqual(f.calls, [["cleanup", "UNSETTLED"]]);
});

test("trial pause failure retains host without mislabeling setup", async () => {
	const f = fixture();
	f.host.pause = async () => { throw { code: "CLOSED" }; };
	await finishTrial({ ...f, writeResult() { assert.fail("Unexpected write"); } });
	assert.deepEqual(f.calls, [["cleanup", "CLOSED"]]);
});
