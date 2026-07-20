/**
 * runner/scheduler.ts — a FIFO concurrency-slot pool (copied verbatim from
 * pi-subagents/extensions/subagents/runtime/scheduler.ts).
 *
 * Running agents are capped at `maxConcurrent`; over-cap agent() calls wait in
 * a FIFO queue (the `queued` state) and drain as slots free. Calls never fail
 * on the cap. Pure in-memory.
 */

export type ReleaseSlot = () => void;

export const DEFAULT_MAX_CONCURRENT = 4;

export class Scheduler {
	private running = 0;
	private waiters: Array<(release: ReleaseSlot) => void> = [];
	private readonly max: number;

	// no TS parameter properties — the tests run under Node's strip-only mode
	constructor(max: number = DEFAULT_MAX_CONCURRENT) {
		this.max = max;
	}

	/** Acquire a slot; resolves immediately if one is free, else queues FIFO. */
	acquire(): Promise<ReleaseSlot> {
		if (this.running < this.max) {
			this.running++;
			return Promise.resolve(this.makeRelease());
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private makeRelease(): ReleaseSlot {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) {
				// hand the slot straight to the next waiter (running count unchanged)
				next(this.makeRelease());
			} else {
				this.running--;
			}
		};
	}

	get runningCount(): number {
		return this.running;
	}

	get queuedCount(): number {
		return this.waiters.length;
	}
}
