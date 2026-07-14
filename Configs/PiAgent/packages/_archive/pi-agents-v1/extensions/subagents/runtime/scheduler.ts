/**
 * runtime/scheduler.ts — the maxConcurrent slot pool (D13).
 *
 * Existence is unlimited (dormant = just directories); RUNNING is capped.
 * Spawns/turns past the cap never fail — they wait FIFO for a slot, and the
 * agent sits in the registry's `queued` state (visible in list/TUI) until the
 * runtime drains the queue.
 *
 * Pure in-memory mechanics: acquire() resolves with a release function once a
 * slot is free. Callers MUST call release exactly once (use try/finally);
 * double-release is a no-op by construction.
 */

export const DEFAULT_MAX_CONCURRENT = 5;

export type ReleaseSlot = () => void;

export class Scheduler {
	readonly maxConcurrent: number;
	private _running = 0;
	private readonly _waiters: Array<(release: ReleaseSlot) => void> = [];

	constructor(maxConcurrent: number = DEFAULT_MAX_CONCURRENT) {
		if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
			throw new Error(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
		}
		this.maxConcurrent = maxConcurrent;
	}

	/** Slots currently held. */
	get running(): number {
		return this._running;
	}

	/** Acquirers still waiting for a slot (registry state: queued). */
	get queued(): number {
		return this._waiters.length;
	}

	/** True if acquire() would resolve immediately. */
	get hasFreeSlot(): boolean {
		return this._running < this.maxConcurrent;
	}

	/**
	 * Wait for a slot (FIFO). Resolves with the single-use release function
	 * for that slot.
	 */
	acquire(): Promise<ReleaseSlot> {
		if (this._running < this.maxConcurrent) {
			this._running++;
			return Promise.resolve(this._makeRelease());
		}
		return new Promise<ReleaseSlot>((resolve) => {
			this._waiters.push(resolve);
		});
	}

	private _makeRelease(): ReleaseSlot {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this._waiters.shift();
			if (next) {
				// Hand the slot straight to the next waiter; _running unchanged.
				next(this._makeRelease());
			} else {
				this._running--;
			}
		};
	}
}
