import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type JournalAgentLine, readJournal } from "./journal/journal.ts";
import { createProcedureLayout } from "./journal/layout.ts";
import type { RunnerPorts } from "./runner/agent-runner.ts";
import { Scheduler } from "./runner/scheduler.ts";
import { type RunAgentFn, ProcedureRun, type ProcedureRunOptions } from "./run.ts";
import { AgentFailure, ProcedureStopped } from "./script/semantics.ts";

// A fake runner: resolves `fake:<prompt>`, honors ports.isStopped, and can be
// steered per-prompt via behaviors.
type Behavior = (call: { prompt: string }) => Promise<unknown>;

function makeOptions(overrides: Partial<ProcedureRunOptions> & { source: string }, behaviors: Record<string, Behavior> = {}) {
	const layout = createProcedureLayout("/proj", { stateRoot: mkdtempSync(join(tmpdir(), "pi-procedure-run-")) });
	let tick = 0;
	const fakeRun = async (call: { prompt: string; seq: number }, ports: RunnerPorts) => {
		ports.onState(call.seq, "running");
		if (ports.isStopped()) throw new ProcedureStopped();
		const behavior = behaviors[call.prompt];
		const output = behavior ? await behavior(call) : `fake:${call.prompt}`;
		ports.onState(call.seq, "done");
		return { output, elapsedMs: 1 };
	};
	const options: ProcedureRunOptions = {
		args: undefined,
		layout,
		scheduler: new Scheduler(4),
		confirm: async () => ({ approved: false }),
		systemDeny: () => ({ denied: false }),
		systemDenyCommand: () => ({ denied: false }),
		defaultModel: undefined,
		resolveModel: () => {
			throw new AgentFailure("no models in tests");
		},
		now: () => new Date(2026, 6, 16, 12, 0, tick++),
		entropyHex6: () => (100000 + tick).toString(16).padStart(6, "0").slice(0, 6),
		runAgentImpl: fakeRun as unknown as RunAgentFn,
		...overrides,
	};
	return { options, layout };
}

test("happy path: phases, logs, parallel fan-out, result, journal shape", async () => {
	const source = `export const meta = { name: 'demo', description: 'd', phases: ['A', 'B'] };
phase('A')
log('starting')
const pair = await parallel([() => agent('one'), () => agent('two', {label: 'second'})])
phase('B')
const final = await agent('three')
return { pair, final }
`;
	const { options, layout } = makeOptions({ source });
	const run = ProcedureRun.create(options);
	const outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result, { pair: ["fake:one", "fake:two"], final: "fake:three" });
	assert.deepEqual(outcome.summary.phases, ["A", "B"]);
	assert.equal(outcome.summary.agents.length, 3);
	assert.equal(outcome.summary.agents[1]!.label, "second");
	assert.equal(outcome.summary.agents[2]!.phase, "B");

	const lines = readJournal(layout.journalFile(run.runId));
	assert.deepEqual(
		lines.map((l) => l.type),
		["meta", "log", "agent", "agent", "agent", "end"],
	);
	const end = lines.at(-1) as { status: string };
	assert.equal(end.status, "completed");
});

test("agent failure → null via parallel; run still completes; journal has the error entry", async () => {
	const source = `const out = await parallel([() => agent('good'), () => agent('bad')])
return out
`;
	const { options, layout } = makeOptions({ source }, { bad: async () => Promise.reject(new AgentFailure("model exploded")) });
	const run = ProcedureRun.create(options);
	const outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result, ["fake:good", null]);
	const agentLines = readJournal(layout.journalFile(run.runId)).filter((l): l is JournalAgentLine => l.type === "agent");
	assert.deepEqual(
		agentLines.map((l) => l.status).sort(),
		["error", "ok"],
	);
});

test("uncaught script throw → failed with the error", async () => {
	const { options } = makeOptions({ source: "throw new Error('script bug')" });
	const outcome = await ProcedureRun.create(options).execute();
	assert.equal(outcome.status, "failed");
	assert.match(outcome.error ?? "", /script bug/);
});

test("meta errors throw at create()", () => {
	const { options } = makeOptions({ source: "export const meta = { name: someVar };" });
	assert.throws(() => ProcedureRun.create(options), /pure literal/);
});

test("stop mid-run: ProcedureStopped unwinds, status stopped, partial journal", async () => {
	let stopper: (() => void) | undefined;
	const source = `const a = await agent('first')
const b = await agent('slow')
return [a, b]
`;
	const { options, layout } = makeOptions(
		{ source },
		{
			slow: () =>
				new Promise((_resolve, reject) => {
					stopper?.();
					setTimeout(() => reject(new ProcedureStopped()), 20);
				}),
		},
	);
	const run = ProcedureRun.create(options);
	stopper = () => run.stop();
	const outcome = await run.execute();
	assert.equal(outcome.status, "stopped");
	const lines = readJournal(layout.journalFile(run.runId));
	const agents = lines.filter((l): l is JournalAgentLine => l.type === "agent");
	assert.equal(agents.length, 1); // only 'first' completed; 'slow' never journaled
	assert.equal((lines.at(-1) as { status: string }).status, "stopped");
});

test("resume: unchanged calls replay from cache, changed call diverges live", async () => {
	const source = `const a = await agent('one')
const b = await agent('two')
const c = await agent('three')
return [a, b, c]
`;
	const first = makeOptions({ source });
	const run1 = ProcedureRun.create(first.options);
	await run1.execute();

	// same script, same layout → full cache hit, no live calls
	let liveCalls = 0;
	const second = makeOptions(
		{ source, layout: first.layout, resumeFromRunId: run1.runId },
		{},
	);
	const countingImpl = second.options.runAgentImpl;
	second.options.runAgentImpl = async (call, ports) => {
		liveCalls++;
		return countingImpl(call, ports);
	};
	const run2 = ProcedureRun.create(second.options);
	const outcome2 = await run2.execute();
	assert.equal(outcome2.status, "completed");
	assert.deepEqual(outcome2.result, ["fake:one", "fake:two", "fake:three"]);
	assert.equal(liveCalls, 0);
	assert.ok(outcome2.summary.agents.every((a) => a.status === "cached"));

	// change the middle prompt → seq0 cached, seq1+2 live (prefix diverges)
	const changed = source.replace("'two'", "'two-changed'");
	let liveCalls3 = 0;
	const third = makeOptions({ source: changed, layout: first.layout, resumeFromRunId: run1.runId });
	const impl3 = third.options.runAgentImpl;
	third.options.runAgentImpl = async (call, ports) => {
		liveCalls3++;
		return impl3(call, ports);
	};
	const outcome3 = await ProcedureRun.create(third.options).execute();
	assert.equal(outcome3.status, "completed");
	assert.deepEqual(outcome3.result, ["fake:one", "fake:two-changed", "fake:three"]);
	assert.equal(liveCalls3, 2);
	assert.deepEqual(
		outcome3.summary.agents.map((a) => a.status),
		["cached", "ok", "ok"],
	);
});

test("resume with an unknown runId throws at create()", () => {
	const { options } = makeOptions({ source: "return 1", resumeFromRunId: "20260101T000000_ffffff" });
	assert.throws(() => ProcedureRun.create(options), /no journal found/);
});
