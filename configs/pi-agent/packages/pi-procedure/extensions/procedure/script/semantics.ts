/**
 * script/semantics.ts — the parallel/pipeline combinators and error taxonomy.
 * PURE: parameterized by the agent function, no I/O.
 *
 * Failure semantics for deterministic procedure execution:
 *   - agent() REJECTS with AgentFailure when the subagent fails.
 *   - parallel(thunks): any thunk failure resolves that slot to null; the call
 *     itself never rejects (filter with .filter(Boolean)).
 *   - pipeline(items, ...stages): a stage throw drops that item to null and
 *     skips its remaining stages. Stages receive (prevResult, originalItem, i).
 *   - ProcedureStopped is NEVER converted to null — it re-throws so a stop
 *     unwinds straight through combinators to the top of the script.
 *
 * Determinism: parallel/pipeline invoke their thunks/first stages sequentially
 * in array order, so the FIRST agent() call of each branch gets its seq in
 * program order. (Later calls in a branch interleave by completion time; the
 * resume cache is hash-keyed, not order-keyed, so that is fine.)
 */

/** A subagent failed (turn error, schema never satisfied, unknown model...). */
export class AgentFailure extends Error {
	readonly details?: unknown;

	constructor(message: string, details?: unknown) {
		super(message);
		this.name = "AgentFailure";
		this.details = details;
	}
}

/** The run was stopped (brake / abort). Combinators re-throw this. */
export class ProcedureStopped extends Error {
	constructor(message = "The procedure was stopped.") {
		super(message);
		this.name = "ProcedureStopped";
	}
}

const MAX_FANOUT = 4096;

type Stage = (prev: unknown, item: unknown, index: number) => unknown;

export interface Combinators {
	parallel(thunks: Array<() => unknown>): Promise<unknown[]>;
	pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]>;
}

/** Wrap one branch: failures → null, ProcedureStopped propagates. */
async function branch(run: () => unknown): Promise<unknown> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof ProcedureStopped) throw error;
		return null;
	}
}

export function makeCombinators(): Combinators {
	return {
		async parallel(thunks) {
			if (!Array.isArray(thunks)) throw new TypeError("parallel() takes an array of zero-arg functions.");
			if (thunks.length > MAX_FANOUT) throw new RangeError(`parallel() accepts at most ${MAX_FANOUT} thunks (got ${thunks.length}).`);
			const settled = thunks.map((thunk, i) => {
				if (typeof thunk !== "function") throw new TypeError(`parallel() item ${i} is not a function.`);
				return branch(() => thunk());
			});
			return Promise.all(settled);
		},

		async pipeline(items, ...stages) {
			if (!Array.isArray(items)) throw new TypeError("pipeline() takes an array of items.");
			if (items.length > MAX_FANOUT) throw new RangeError(`pipeline() accepts at most ${MAX_FANOUT} items (got ${items.length}).`);
			for (const [i, stage] of stages.entries()) {
				if (typeof stage !== "function") throw new TypeError(`pipeline() stage ${i} is not a function.`);
			}
			const chains = items.map((item, index) =>
				branch(async () => {
					let value: unknown = item;
					for (const stage of stages) {
						value = await stage(value, item, index);
					}
					return value;
				}),
			);
			return Promise.all(chains);
		},
	};
}
