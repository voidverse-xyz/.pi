/**
 * phase1-live-run.mjs — a full inline procedure against real AgentSessions with
 * the mock LLM: phases, parallel fan-out under the concurrency cap, plain-text
 * outputs, journal contents, per-agent transcripts on disk.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, summary, test, ProcedureRun } from "./harness.mjs";

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
await test("procedure completes with all agent outputs threaded through", async () => {
	run = ProcedureRun.create(world.makeRunOptions({ source: SOURCE, maxConcurrent: 2 }));
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

await test("provider-visible thinking updates the live procedure snapshot", async () => {
	world.scripts.push({
		match: (c) => c.label === "thinking-probe",
		reply: () => ({
			thinking: "Tracing the sequential handoff before returning the result.",
			text: "THINKING_OK",
			delayMs: 100,
		}),
	});
	const source = `return agent('thinking task', {label: 'thinking-probe'})`;
	let thinkingRun;
	let liveSummary = "";
	thinkingRun = ProcedureRun.create(
		world.makeRunOptions({
			source,
			onChange: () => {
				const summary = thinkingRun?.snapshot().rows[0]?.activity?.summary ?? "";
				if (summary !== "thinking…" && summary.endsWith(" · thinking…")) liveSummary = summary;
			},
		}),
	);
	const thinkingOutcome = await thinkingRun.execute();
	assert.equal(thinkingOutcome.status, "completed");
	assert.equal(thinkingOutcome.result, "THINKING_OK");
	assert.equal(liveSummary, "Tracing the sequential handoff before returning the result. · thinking…");
});

await test("the latest provider-visible thought returns after a tool finishes", async () => {
	const thought = "Inspecting the probe before reading it.";
	writeFileSync(join(world.project, "thinking-tool-probe.txt"), "probe\n");
	world.scripts.push({
		match: (c) => c.label === "thinking-tool-probe",
		reply: () => ({
			thinking: thought,
			tools: [{ name: "read", args: { path: "thinking-tool-probe.txt" } }],
		}),
	});
	world.scripts.push({
		match: (c) => c.label === "thinking-tool-probe",
		reply: () => ({ thinking: "   ", text: "TOOL_THINKING_OK", delayMs: 150 }),
	});
	const source = `return agent('inspect with a tool', {label: 'thinking-tool-probe', tools: ['read']})`;
	let sawTool = false;
	let maxToolUses = 0;
	let maxTokens = 0;
	let liveContextPercent = null;
	let restoredSummary = "";
	let lostLatestThought = false;
	let thinkingToolRun;
	thinkingToolRun = ProcedureRun.create(
		world.makeRunOptions({
			source,
			onChange: () => {
				const activity = thinkingToolRun?.snapshot().rows[0]?.activity;
				if (activity) {
					maxToolUses = Math.max(maxToolUses, activity.toolUses);
					maxTokens = Math.max(maxTokens, activity.tokens);
					if (activity.ctxPercent !== null) liveContextPercent = activity.ctxPercent;
				}
				if (activity?.tool === "read") sawTool = true;
				if (sawTool && activity?.tool === "") {
					if (activity.summary === `${thought} · thinking…`) restoredSummary = activity.summary;
					else if (restoredSummary && activity.summary === "thinking…") lostLatestThought = true;
				}
			},
		}),
	);
	const thinkingToolOutcome = await thinkingToolRun.execute();
	assert.equal(thinkingToolOutcome.status, "completed");
	assert.equal(thinkingToolOutcome.result, "TOOL_THINKING_OK");
	assert.equal(restoredSummary, `${thought} · thinking…`);
	assert.equal(lostLatestThought, false, "an empty next thinking block must not erase the prior clue");
	assert.equal(maxToolUses, 1, "live telemetry counts the active tool call");
	assert.ok(maxTokens >= 15, `expected finalized-message tokens, got ${maxTokens}`);
	assert.equal(typeof liveContextPercent, "number", "live telemetry includes context fill");
});

await test("per-agent model, thinking, and tools options run through a real AgentSession", async () => {
	const callsBefore = world.llmCalls.length;
	world.scripts.push({ match: (c) => c.label === "configured", reply: () => ({ text: "CONFIGURED_OK" }) });
	const source = `return agent('configured task', {
	label: 'configured',
	model: 'mock/mock-1',
	thinking: 'off',
	tools: ['read'],
})`;
	const configured = ProcedureRun.create(world.makeRunOptions({ source }));
	const configuredOutcome = await configured.execute();
	assert.equal(configuredOutcome.status, "completed");
	assert.equal(configuredOutcome.result, "CONFIGURED_OK");
	assert.equal(world.llmCalls.length, callsBefore + 1);
});

await test("unknown model and tool names fail before making an LLM call", async () => {
	const callsBefore = world.llmCalls.length;
	const source = `return parallel([
	() => agent('bad model', {model: 'missing/nope'}),
	() => agent('bad tool', {tools: ['not-a-tool']}),
])`;
	const invalid = ProcedureRun.create(world.makeRunOptions({ source }));
	const invalidOutcome = await invalid.execute();
	assert.equal(invalidOutcome.status, "completed");
	assert.deepEqual(invalidOutcome.result, [null, null]);
	assert.equal(world.llmCalls.length, callsBefore, "invalid options must fail before provider calls");
});

summary("phase1-live-run");
