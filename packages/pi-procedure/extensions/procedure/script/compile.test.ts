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
	// agent/parallel results and the return value are marshalled to vm-native
	// objects (different realm prototypes), so normalize via JSON the same way the
	// journal does before comparing structure.
	const raw = await compileScript(body, globals, "demo.js")();
	const result = JSON.parse(JSON.stringify(raw)) as { both: unknown[]; fromArgs: string };
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

test("constructor-string escapes cannot reach the host process", async () => {
	// args is an object and agent() resolves an object, so the .constructor pivot
	// on a marshalled host result is exercised for real.
	const { globals } = makeGlobals({ args: { x: 1 }, agent: async () => ({ ok: 1 }) });
	const run = (code: string) => compileScript(code, globals, "t.js")();

	// Exposed HOST functions have severed prototype chains: .constructor is
	// undefined so the pivot throws a TypeError before reaching any Function.
	const severed = [
		'return agent.constructor.constructor("return process")()',
		'return parallel.constructor.constructor("return process")()',
		'return pipeline.constructor.constructor("return process")()',
		'return console.log.constructor.constructor("return process")()',
	];
	for (const code of severed) {
		await assert.rejects(run(code), /undefined/, code);
	}

	// Every intrinsic and every value crossing host→vm is now vm-native, so the
	// constructor pivot dead-ends at the (inert) vm Function → codegen blocked.
	const vmNative = [
		'return JSON.constructor.constructor("return process")()',
		'return Math.constructor.constructor("return process")()',
		'return Date.constructor.constructor("return process")()',
		'return JSON.parse("{}").constructor.constructor("return process")()',
		'return args.constructor.constructor("return process")()',
		'return (await agent()).constructor.constructor("return process")()',
		'return (await parallel([() => agent()]))[0].constructor.constructor("return process")()',
		'return (new Date(0)).constructor.constructor("return process")()',
		'return [].constructor.constructor("return process")()',
		'return ({}).constructor.constructor("return process")()',
	];
	for (const code of vmNative) {
		await assert.rejects(run(code), /Code generation from strings disallowed/, code);
	}

	// in-context runtime code generation is disabled outright
	await assert.rejects(run('return eval("1")'), /Code generation from strings disallowed/);
	await assert.rejects(run('return new Function("return 1")()'), /Code generation from strings disallowed/);
	await assert.rejects(run('return (() => {}).constructor("return process")()'), /Code generation from strings disallowed/);
});

test("no escape vector resolves the host process object", async () => {
	// Belt-and-suspenders: even if a vector somehow RESOLVED instead of throwing,
	// the resolved value must not be the host process (which carries a .pid).
	const { globals } = makeGlobals({ args: { x: 1 }, agent: async () => ({ ok: 1 }) });
	const run = (code: string) => compileScript(code, globals, "t.js")();
	const vectors = [
		'return JSON.parse("{}").constructor.constructor("return process")()',
		'return args.constructor.constructor("return process")()',
		'return (await agent()).constructor.constructor("return process")()',
	];
	for (const code of vectors) {
		let value: unknown;
		try {
			value = await run(code);
		} catch {
			continue; // threw — safe
		}
		assert.ok(
			!(value && typeof value === "object" && "pid" in (value as object)),
			`${code} resolved a host process-like object`,
		);
	}
});

test("legitimate realm intrinsics still work (JSON round-trip, Math, Date, args, agent result)", async () => {
	const { globals } = makeGlobals({ args: { x: 42 }, agent: async () => ({ ok: 1 }) });
	const run = (code: string) => compileScript(code, globals, "t.js")();

	// JSON round-trip through the realm's own JSON
	assert.equal(await run('return JSON.parse(JSON.stringify({ a: 7 })).a'), 7);
	// Math works, random throws
	assert.equal(await run("return Math.max(1, 2)"), 2);
	await assert.rejects(run("return Math.random()"), /Math\.random\(\) is blocked/);
	// with-arg Date works, now()/zero-arg new Date()/bare Date() throw
	assert.equal(await run("return new Date(0).getTime()"), 0);
	await assert.rejects(run("return Date.now()"), /Date\.now\(\) is blocked/);
	await assert.rejects(run("return new Date()"), /new Date\(\)`? is blocked/);
	// args is readable
	assert.equal(await run("return args.x"), 42);
	// agent() result is readable
	assert.equal(await run("return (await agent()).ok"), 1);
});

test("syntax errors carry the original line number", () => {
	const src = "const a = 1\nconst b = 2\nconst ] = broken\n";
	try {
		compileScript(src, makeGlobals().globals, "procedure.js");
		assert.fail("expected a SyntaxError");
	} catch (error) {
		assert.ok(error instanceof SyntaxError);
		assert.match((error as Error).stack ?? "", /procedure\.js:3/);
	}
});

test("runtime throw rejects the run promise", async () => {
	const { globals } = makeGlobals();
	await assert.rejects(compileScript("throw new Error('script bug')", globals, "t.js")(), /script bug/);
});
