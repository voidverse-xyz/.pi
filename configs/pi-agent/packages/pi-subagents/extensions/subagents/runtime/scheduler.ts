/**
 * runtime/scheduler.ts — a FIFO concurrency-slot pool.
 *
 * Running agents are capped at `maxConcurrent`; over-cap turns wait in a FIFO
 * queue (the `queued` state) and drain as slots free. Spawns never fail on the
 * cap. Pure in-memory — the host lease already guarantees one process.
 */

import { DEFAULT_SETTINGS } from "../store/settings.ts";

export type ReleaseSlot = () => void;

export class Scheduler {
	private running = 0;
	private waiters: Array<(release: ReleaseSlot) => void> = [];

	constructor(private readonly max: number = DEFAULT_SETTINGS.maxConcurrent) {}

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
