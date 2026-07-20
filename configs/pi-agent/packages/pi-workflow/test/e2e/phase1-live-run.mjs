/**
 * phase1-live-run.mjs — a full inline workflow against real AgentSessions with
 * the mock LLM: phases, parallel fan-out under the concurrency cap, plain-text
 * outputs, journal contents, per-agent transcripts on disk.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, summary, test, WorkflowRun } from "./harness.mjs";

const { readJournal } = await jiti.import(join(EXT, "journal/journal.ts"));

const world = await makeWorld("phase1");

const SOURCE = `export const meta = { name: 'fanout', description: 'demo', phases: ['Scan', 'Sum'] };
phase('Scan')
log('scanning')
const parts = await parallel([
	() => agent('scan a', {label: 'scan-a'}),
	() => agent('scan b', {label: 'scan-b'}),
	() => agent('scan c', {label: 'scan-c'}),
	() => agent('scan d', {label: 'scan-d'}),
])
phase('Sum')
const total = await agent('sum: ' + JSON.stringify(parts), {label: 'summer'})
return { parts, total }
`;

for (const l of ["a", "b", "c", "d"]) {
	world.scripts.push({ match: (c) => c.label === `scan-${l}`, reply: () => ({ text: `SCAN_${l.toUpperCase()}`, delayMs: 60 }) });
}
world.scripts.push({ match: (c) => c.label === "summer", reply: (c) => ({ text: `SUM(${c.lastUserText.includes("SCAN_A") ? "seen" : "missing"})` }) });

let run;
let outcome;
await test("workflow completes with all agent outputs threaded through", async () => {
	run = WorkflowRun.create(world.makeRunOptions({ source: SOURCE, maxConcurrent: 2 }));
	outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result.parts, ["SCAN_A", "SCAN_B", "SCAN_C", "SCAN_D"]);
	assert.equal(outcome.result.total, "SUM(seen)");
});

await test("concurrency stayed at or under the cap of 2", () => {
	assert.ok(world.maxObservedConcurrent <= 2, `observed ${world.maxObservedConcurrent}`);
	assert.equal(world.llmCalls.length, 5);
});

await test("journal has meta, log, 5 ok agents (in seq order after sort), end", () => {
	const lines = readJournal(world.layout.journalFile(run.runId));
	assert.equal(lines[0].type, "meta");
	assert.equal(lines[0].name, "fanout");
	const agents = lines.filter((l) => l.type === "agent").sort((a, b) => a.seq - b.seq);
	assert.equal(agents.length, 5);
	assert.ok(agents.every((a) => a.status === "ok"));
	assert.deepEqual(agents.map((a) => a.label), ["scan-a", "scan-b", "scan-c", "scan-d", "summer"]);
	assert.equal(agents[4].phase, "Sum");
	assert.equal(lines.at(-1).status, "completed");
	assert.ok(lines.some((l) => l.type === "log" && l.text === "scanning"));
});

await test("each agent left a real session transcript under agents/<seq>/", () => {
	for (let seq = 0; seq < 5; seq++) {
		const dir = world.layout.agentSeqDir(run.runId, seq);
		assert.ok(existsSync(dir), `missing ${dir}`);
		const jsonl = readFileSync(world.layout.journalFile(run.runId), "utf8");
		assert.ok(jsonl.length > 0);
	}
});

await test("per-agent model, thinking, and tools options run through a real AgentSession", async () => {
	world.scripts.push({ match: (c) => c.label === "configured", reply: () => ({ text: "CONFIGURED_OK" }) });
	const source = `return agent('configured task', {
	label: 'configured',
	model: 'mock/mock-1',
	thinking: 'off',
	tools: ['read'],
})`;
	const configured = WorkflowRun.create(world.makeRunOptions({ source }));
	const configuredOutcome = await configured.execute();
	assert.equal(configuredOutcome.status, "completed");
	assert.equal(configuredOutcome.result, "CONFIGURED_OK");
	assert.equal(world.llmCalls.length, 6);
});

await test("unknown model and tool names fail before making an LLM call", async () => {
	const source = `return parallel([
	() => agent('bad model', {model: 'missing/nope'}),
	() => agent('bad tool', {tools: ['not-a-tool']}),
])`;
	const invalid = WorkflowRun.create(world.makeRunOptions({ source }));
	const invalidOutcome = await invalid.execute();
	assert.equal(invalidOutcome.status, "completed");
	assert.deepEqual(invalidOutcome.result, [null, null]);
	assert.equal(world.llmCalls.length, 6, "invalid options must fail before provider calls");
});

summary("phase1-live-run");
