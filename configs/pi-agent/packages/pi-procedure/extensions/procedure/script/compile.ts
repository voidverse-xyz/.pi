/**
 * script/compile.ts — turn a procedure script body into a runnable promise.
 *
 * The body (meta already blanked by script/meta.ts) is wrapped in an async
 * IIFE and executed in a vm context that exposes ONLY the orchestration
 * globals. The realm uses its OWN native intrinsics (JSON/Math/Date/Object/…);
 * determinism shims are installed INSIDE the realm via runInContext:
 *
 *   - Math.random() throws; the rest of Math works.
 *   - Date.now(), bare `Date()`, and zero-arg `new Date()` throw;
 *     `new Date(value)` works.
 *   - No require/process/setTimeout/fetch; dynamic import() rejects.
 *
 * Security model — closing the `x.constructor.constructor("return process")()`
 * escape for EVERY reachable object:
 *   - `codeGeneration:{strings:false,wasm:false}` disables in-realm runtime code
 *     generation, so any vm-native Function constructor is inert. Crucially this
 *     flag only governs VM-REALM code generation, so the fix is to make sure no
 *     HOST-realm object is ever reachable from the script (a host Function still
 *     runs in a realm where codegen is allowed).
 *   - No host intrinsics are injected: the realm's own JSON/Math/Date/Object/…
 *     are used, so every intrinsic and everything they produce is vm-native and
 *     its constructor pivot dead-ends at the (inert) vm Function.
 *   - The few exposed HOST functions (agent/parallel/pipeline/phase/log/
 *     console.log) have their prototype chain severed so `.constructor` cannot
 *     reach the host Function constructor.
 *   - Every value crossing host→vm — `args` and the resolved results of
 *     agent()/parallel()/pipeline() — is marshalled through the realm's OWN
 *     JSON.parse into a vm-native object, so no host object leaks in. This is
 *     lossless: those values are already JSON (tool args / journalled results).
 *
 * node:vm is still not a perfect security boundary; this is defense-in-depth
 * alongside agent()-level pi-safety gating, where the only real side effects
 * happen.
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

/**
 * Expose a host function without leaking host intrinsics: with a null
 * prototype, `fn.constructor` is undefined so the constructor-string escape
 * dead-ends. Only apply to functions created for the context.
 */
function sever<T>(fn: T): T {
	Object.setPrototypeOf(fn as object, null);
	return fn;
}

/**
 * Determinism shims, installed INSIDE the vm realm. Host-initiated compilation
 * (runInContext) is always allowed even with codeGeneration.strings:false — the
 * flag only blocks in-script eval/Function. Everything created here (the
 * thrower, the Date proxy) is therefore vm-native.
 */
const SHIMS = `(() => {
	const blocked = (name) => () => {
		throw new Error(name + " is blocked in procedure scripts — it breaks deterministic resume. Derive values from args or agent results.");
	};
	Math.random = blocked("Math.random()");
	Date.now = blocked("Date.now()");
	const RealDate = Date;
	globalThis.Date = new Proxy(RealDate, {
		construct(target, argArray, newTarget) {
			if (argArray.length === 0) blocked("Zero-argument \`new Date()\`")();
			return Reflect.construct(target, argArray, newTarget);
		},
		apply() {
			// bare Date() returns the current time as a string — same nondeterminism
			blocked("Date()")();
		},
		get(target, prop, receiver) {
			if (prop === "now") return blocked("Date.now()");
			return Reflect.get(target, prop, receiver);
		},
	});
})();`;

/**
 * Compile the (meta-blanked) body. Throws a SyntaxError with line numbers
 * mapped to the ORIGINAL script on parse failure. The returned thunk runs the
 * script and resolves with its `return` value.
 */
export function compileScript(body: string, globals: ScriptGlobals, filename: string): () => Promise<unknown> {
	const wrapped = `(async () => {\n${body}\n})()`;
	// lineOffset -1 cancels the wrapper line so errors point at the source
	const script = new vm.Script(wrapped, { filename, lineOffset: -1 });

	// Real impl assigned after the context exists; the wrapped globals below
	// close over this binding so they marshal with the realm's own JSON.parse.
	let marshal: (v: unknown) => unknown = (v) => v;

	const safeConsole = Object.create(null) as Record<string, unknown>;
	safeConsole.log = sever((...parts: unknown[]) => globals.log(parts.map(String).join(" ")));

	const contextObject: Record<string, unknown> = {
		agent: sever(async (...a: [string, unknown?]) => marshal(await globals.agent(...a))),
		parallel: sever(async (...a: [Array<() => unknown>]) => marshal(await globals.parallel(...a))),
		pipeline: sever(async (...a: [unknown[], ...Array<(prev: unknown, item: unknown, index: number) => unknown>]) => marshal(await globals.pipeline(...a))),
		phase: sever(globals.phase),
		log: sever(globals.log),
		console: Object.freeze(safeConsole),
	};
	const context = vm.createContext(contextObject, { codeGeneration: { strings: false, wasm: false } });

	// The realm's OWN JSON.parse (vm-native). Feeding it a host JSON string
	// yields a vm-native object, severing any host-realm reachability.
	const vmJsonParse = vm.runInContext("JSON.parse", context) as (s: string) => unknown;
	marshal = (v: unknown) => vmJsonParse(JSON.stringify(v === undefined ? null : v));

	// contextObject is the contextified global, so post-creation adds are visible.
	contextObject.args = marshal(globals.args);

	// Install determinism shims in-realm (see SHIMS).
	vm.runInContext(SHIMS, context);

	return () => Promise.resolve(script.runInContext(context));
}
