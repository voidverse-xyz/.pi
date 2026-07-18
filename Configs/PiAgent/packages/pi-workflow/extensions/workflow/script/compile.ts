/**
 * script/compile.ts — turn a workflow script body into a runnable promise.
 *
 * The body (meta already blanked by script/meta.ts) is wrapped in an async
 * IIFE and executed in a vm context that exposes ONLY the orchestration
 * globals plus determinism shims:
 *
 *   - Math.random() throws; the rest of Math works.
 *   - Date.now() and zero-arg `new Date()` throw; `new Date(value)` works.
 *   - No require/process/setTimeout/fetch; dynamic import() rejects.
 *
 * The vm is a determinism/ergonomics boundary, NOT a security boundary
 * (prototype-chain escapes exist) — real side effects only happen through
 * agent(), which is sandbox- and pi-safety-gated.
 */

import vm from "node:vm";

export interface ScriptGlobals {
	agent: (prompt: string, opts?: unknown) => Promise<unknown>;
	parallel: (thunks: Array<() => unknown>) => Promise<unknown[]>;
	pipeline: (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>) => Promise<unknown[]>;
	phase: (title: string) => void;
	log: (message: string) => void;
	args: unknown;
}

function blocked(name: string): () => never {
	return () => {
		throw new Error(
			`${name} is blocked in workflow scripts — it breaks deterministic resume. Derive values from args or agent results.`,
		);
	};
}

function makeSafeMath(): Math {
	const safe = Object.create(null) as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(Math)) {
		safe[key] = (Math as unknown as Record<string, unknown>)[key];
	}
	safe.random = blocked("Math.random()");
	return Object.freeze(safe) as unknown as Math;
}

function makeSafeDate(): DateConstructor {
	return new Proxy(Date, {
		construct(target, argArray, newTarget) {
			if (argArray.length === 0) blocked("Zero-argument `new Date()`")();
			return Reflect.construct(target, argArray, newTarget);
		},
		apply() {
			// bare `Date()` returns the current time as a string — same leak
			blocked("Date()")();
		},
		get(target, prop, receiver) {
			if (prop === "now") return blocked("Date.now()");
			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * Compile the (meta-blanked) body. Throws a SyntaxError with line numbers
 * mapped to the ORIGINAL script on parse failure. The returned thunk runs the
 * script and resolves with its `return` value.
 */
export function compileScript(body: string, globals: ScriptGlobals, filename: string): () => Promise<unknown> {
	const wrapped = `(async () => {\n${body}\n})()`;
	// lineOffset -1 cancels the wrapper line so errors point at the source
	const script = new vm.Script(wrapped, { filename, lineOffset: -1 });

	const contextObject: Record<string, unknown> = {
		agent: globals.agent,
		parallel: globals.parallel,
		pipeline: globals.pipeline,
		phase: globals.phase,
		log: globals.log,
		args: globals.args,
		console: Object.freeze({ log: (...parts: unknown[]) => globals.log(parts.map(String).join(" ")) }),
		JSON,
		Math: makeSafeMath(),
		Date: makeSafeDate(),
	};
	const context = vm.createContext(contextObject);

	return () => Promise.resolve(script.runInContext(context));
}
