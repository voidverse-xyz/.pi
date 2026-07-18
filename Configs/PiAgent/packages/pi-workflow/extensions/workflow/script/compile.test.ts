import assert from "node:assert/strict";
import test from "node:test";
import { compileScript, type ScriptGlobals } from "./compile.ts";
import { extractMeta } from "./meta.ts";
import { makeCombinators } from "./semantics.ts";

function makeGlobals(overrides: Partial<ScriptGlobals> = {}): { globals: ScriptGlobals; calls: string[]; logs: string[]; phases: string[] } {
	const calls: string[] = [];
	const logs: string[] = [];
	const phases: string[] = [];
	const { parallel, pipeline } = makeCombinators();
	const globals: ScriptGlobals = {
		agent: async (prompt) => {
			calls.push(prompt);
			return `out:${prompt}`;
		},
		parallel,
		pipeline,
		phase: (t) => phases.push(t),
		log: (m) => logs.push(m),
		args: undefined,
		...overrides,
	};
	return { globals, calls, logs, phases };
}

test("runs a full script: meta stripped, agent/parallel/phase/log/args, return value", async () => {
	const src = `export const meta = { name: 'demo', description: 'd', phases: ['A'] };
phase('A')
log('starting')
const both = await parallel([() => agent('one'), () => agent('two')])
console.log('done', both.length)
return { both, fromArgs: args.key }
`;
	const { meta, body } = extractMeta(src);
	assert.equal(meta?.name, "demo");
	const { globals, calls, logs, phases } = makeGlobals({ args: { key: "v" } });
	const result = (await compileScript(body, globals, "demo.js")()) as { both: unknown[]; fromArgs: string };
	assert.deepEqual(calls, ["one", "two"]);
	assert.deepEqual(phases, ["A"]);
	assert.deepEqual(logs, ["starting", "done 2"]);
	assert.deepEqual(result.both, ["out:one", "out:two"]);
	assert.equal(result.fromArgs, "v");
});

test("determinism shims: Date.now, new Date(), Date(), Math.random throw; with-arg Date and Math.floor work", async () => {
	const { globals } = makeGlobals();
	const run = (code: string) => compileScript(code, globals, "t.js")();
	await assert.rejects(run("return Date.now()"), /Date\.now\(\) is blocked.*deterministic resume/);
	await assert.rejects(run("return new Date()"), /new Date\(\)`? is blocked/);
	await assert.rejects(run("return Date()"), /Date\(\) is blocked/);
	await assert.rejects(run("return Math.random()"), /Math\.random\(\) is blocked/);
	assert.equal(await run("return new Date(86400000).toISOString()"), "1970-01-02T00:00:00.000Z");
	assert.equal(await run("return Math.floor(2.9)"), 2);
});

test("no require/process/setTimeout/fetch in scope", async () => {
	const { globals } = makeGlobals();
	for (const name of ["require", "process", "setTimeout", "fetch"]) {
		await assert.rejects(compileScript(`return ${name}("x")`, globals, "t.js")(), new RegExp(`${name} is not defined`));
	}
});

test("syntax errors carry the original line number", () => {
	const src = "const a = 1\nconst b = 2\nconst ] = broken\n";
	try {
		compileScript(src, makeGlobals().globals, "wf.js");
		assert.fail("expected a SyntaxError");
	} catch (error) {
		assert.ok(error instanceof SyntaxError);
		assert.match((error as Error).stack ?? "", /wf\.js:3/);
	}
});

test("runtime throw rejects the run promise", async () => {
	const { globals } = makeGlobals();
	await assert.rejects(compileScript("throw new Error('script bug')", globals, "t.js")(), /script bug/);
});
