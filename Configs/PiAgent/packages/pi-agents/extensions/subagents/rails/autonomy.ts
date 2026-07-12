/**
 * rails/autonomy.ts — the D21 autonomy budget: the master, shape-agnostic
 * runaway rail. ONE pool per main session, consumed by autonomous subagent
 * turns. Main-agent mailbox wakeups are intentionally outside this pool:
 *
 *   autonomousTurns  (default 40)   — counted when an autonomous turn starts
 *   autonomousTokens (default 500k) — per-turn SessionStats deltas, fed by the
 *                                     runtime after each turn
 *
 * Interactive/RPC input resets the pool (index.ts uses the source-aware input
 * event so extension-generated turns cannot refill it).
 *
 * PAUSE, NEVER KILL (D21 rule 3): tripping destroys nothing. Consumers check
 * `paused` before STARTING work — running turns finish (and may keep counting
 * tokens past the cap; status shows the overage), no new autonomous turns
 * start, mail queues on disk. resume()/reset() refills the pool and fires
 * "resumed" so the runtime can drain queued mailboxes; the paused status +
 * queued counts feed the Phase 6 banner/widget.
 *
 * In-memory and fs-free; limits are read LIVE off the provided object (core
 * hands its mutable settings object in), so settings edits apply immediately.
 */

export const DEFAULT_AUTONOMOUS_TURNS = 40;
export const DEFAULT_AUTONOMOUS_TOKENS = 500_000;

/** The two pool limits (core's settings object satisfies this shape). */
export interface AutonomyLimits {
	autonomousTurns: number;
	autonomousTokens: number;
}

export interface AutonomyStatus {
	paused: boolean;
	/** Which limit tripped the pause; null while running. */
	trippedBy: "turns" | "tokens" | null;
	turnsUsed: number;
	turnsBudget: number;
	tokensUsed: number;
	tokensBudget: number;
}

export type AutonomyEventKind = "paused" | "resumed";
export type AutonomyListener = (event: AutonomyEventKind, status: AutonomyStatus) => void;

export class AutonomyBudget {
	/** Read live so settings edits apply without rebuilding the budget. */
	private readonly _limits: AutonomyLimits;
	private _turnsUsed = 0;
	private _tokensUsed = 0;
	private _trippedBy: "turns" | "tokens" | null = null;
	private readonly _listeners = new Set<AutonomyListener>();

	constructor(limits?: AutonomyLimits) {
		this._limits = limits ?? {
			autonomousTurns: DEFAULT_AUTONOMOUS_TURNS,
			autonomousTokens: DEFAULT_AUTONOMOUS_TOKENS,
		};
	}

	get paused(): boolean {
		return this._trippedBy !== null;
	}

	/** May a NEW autonomous turn start right now? (Running turns never checked.) */
	canStart(): boolean {
		return !this.paused;
	}

	status(): AutonomyStatus {
		return {
			paused: this.paused,
			trippedBy: this._trippedBy,
			turnsUsed: this._turnsUsed,
			turnsBudget: this._limits.autonomousTurns,
			tokensUsed: this._tokensUsed,
			tokensBudget: this._limits.autonomousTokens,
		};
	}

	/**
	 * An autonomous turn is starting: consume one turn from the pool. Callers
	 * gate on canStart() FIRST — a consumption that reaches the cap pauses the
	 * system but the turn that consumed it still runs to completion.
	 */
	noteTurnStart(): void {
		this._turnsUsed++;
		if (this._trippedBy === null && this._turnsUsed >= this._limits.autonomousTurns) {
			this._trip("turns");
		}
	}

	/** Per-turn token delta from the runtime's SessionStats accounting. */
	noteTokens(delta: number): void {
		if (!Number.isFinite(delta) || delta <= 0) return;
		this._tokensUsed += delta;
		if (this._trippedBy === null && this._tokensUsed >= this._limits.autonomousTokens) {
			this._trip("tokens");
		}
	}

	/**
	 * User input arrived: refill the pool. If the system was paused this also
	 * resumes it (fires "resumed" so the runtime drains queued mailboxes).
	 */
	reset(): void {
		const wasPaused = this.paused;
		this._turnsUsed = 0;
		this._tokensUsed = 0;
		this._trippedBy = null;
		if (wasPaused) this._emit("resumed");
	}

	/** Manual resume (Phase 6 banner keypress): same refill-and-drain as reset. */
	resume(): void {
		this.reset();
	}

	/** Subscribe to pause/resume transitions. Returns the unsubscribe function. */
	subscribe(listener: AutonomyListener): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	private _trip(by: "turns" | "tokens"): void {
		this._trippedBy = by;
		this._emit("paused");
	}

	private _emit(event: AutonomyEventKind): void {
		const status = this.status();
		for (const listener of this._listeners) {
			try {
				listener(event, status);
			} catch {
				// Listeners must never break the rail.
			}
		}
	}
}
