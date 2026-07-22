/**
 * phase3-resume.mjs — resume against real sessions: run a 3-agent script, then
 * re-run with resumeFromRunId. Unchanged prefix replays from the journal with
 * NO LLM calls; a changed prompt diverges and runs live from there.
 */

import assert from "node:assert/strict";
import { makeWorld, summary, test, ProcedureRun } from "./harness.mjs";

const world = await makeWorld("phase3");

const SOURCE = `const a = await agent('step one', {label: 'one'})
const b = await agent('step two', {label: 'two'})
const c = await agent('step three', {label: 'three'})
return [a, b, c]
`;

for (const l of ["one", "two", "three"]) {
	world.scripts.push({ match: (c) => c.label === l, reply: () => ({ text: `OUT_${l}` }) });
}

let firstRunId;
await test("first run completes live (3 LLM calls)", async () => {
	const run = ProcedureRun.create(world.makeRunOptions({ source: SOURCE }));
	const outcome = await run.execute();
	firstRunId = run.runId;
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result, ["OUT_one", "OUT_two", "OUT_three"]);
	assert.equal(world.llmCalls.length, 3);
});

await test("resume with the identical script replays fully from cache (0 LLM calls)", async () => {
	const run = ProcedureRun.create(world.makeRunOptions({ source: SOURCE, resumeFromRunId: firstRunId }));
	const outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result, ["OUT_one", "OUT_two", "OUT_three"]);
	assert.equal(world.llmCalls.length, 3, "no new LLM calls expected");
	assert.ok(outcome.summary.agents.every((a) => a.status === "cached"));
});

await test("a changed middle prompt diverges: seq0 cached, seq1+2 live", async () => {
	world.scripts.push({ match: (c) => c.label === "two", reply: () => ({ text: "OUT_two_v2" }) });
	world.scripts.push({ match: (c) => c.label === "three", reply: () => ({ text: "OUT_three_v2" }) });
	const changed = SOURCE.replace("'step two'", "'step two CHANGED'");
	const run = ProcedureRun.create(world.makeRunOptions({ source: changed, resumeFromRunId: firstRunId }));
	const outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result, ["OUT_one", "OUT_two_v2", "OUT_three_v2"]);
	assert.equal(world.llmCalls.length, 5);
	assert.deepEqual(outcome.summary.agents.map((a) => a.status), ["cached", "ok", "ok"]);
});

summary("phase3-resume");
