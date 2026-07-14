/**
 * rails/autonomy.ts — session-wide autonomy accounting and warning thresholds.
 *
 * The counters remain useful visibility rails, but crossing them NEVER pauses
 * or kills work. Every new subagent turn may start; the runtime emits a
 * targeted limit-warning event for the agent whose turn/token delta crossed a
 * threshold. Real user input resets the counters for the next user-turn group.
 */

export const DEFAULT_AUTONOMOUS_TURNS = 40;
export const DEFAULT_AUTONOMOUS_TOKENS = 500_000;

export interface AutonomyLimits {
	autonomousTurns: number;
	autonomousTokens: number;
}

export interface AutonomyStatus {
	/** Compatibility field: autonomy thresholds are warning-only, never paused. */
	paused: false;
	/** Most recently crossed threshold in this accounting window. */
	trippedBy: "turns" | "tokens" | null;
	turnsUsed: number;
	turnsBudget: number;
	tokensUsed: number;
	tokensBudget: number;
}

export type AutonomyEventKind = "warning" | "reset";
export type AutonomyListener = (event: AutonomyEventKind, status: AutonomyStatus) => void;
export type AutonomySnapshot = Pick<AutonomyStatus, "trippedBy" | "turnsUsed" | "tokensUsed">;
export type AutonomyThreshold = "turns" | "tokens";

export class AutonomyBudget {
	private readonly _limits: AutonomyLimits;
	private _turnsUsed = 0;
	private _tokensUsed = 0;
	private _trippedBy: AutonomyThreshold | null = null;
	private _turnsWarned = false;
	private _tokensWarned = false;
	private readonly _listeners = new Set<AutonomyListener>();
	private readonly _onChange: ((snapshot: AutonomySnapshot) => void) | undefined;

	constructor(
		limits?: AutonomyLimits,
		initial?: Partial<AutonomySnapshot>,
		onChange?: (snapshot: AutonomySnapshot) => void,
	) {
		this._limits = limits ?? {
			autonomousTurns: DEFAULT_AUTONOMOUS_TURNS,
			autonomousTokens: DEFAULT_AUTONOMOUS_TOKENS,
		};
		if (Number.isInteger(initial?.turnsUsed) && initial!.turnsUsed! >= 0) this._turnsUsed = initial!.turnsUsed!;
		if (Number.isFinite(initial?.tokensUsed) && initial!.tokensUsed! >= 0) this._tokensUsed = initial!.tokensUsed!;
		this._turnsWarned = this._turnsUsed >= this._limits.autonomousTurns;
		this._tokensWarned = this._tokensUsed >= this._limits.autonomousTokens;
		if (initial?.trippedBy === "turns" || initial?.trippedBy === "tokens") this._trippedBy = initial.trippedBy;
		else if (this._tokensWarned) this._trippedBy = "tokens";
		else if (this._turnsWarned) this._trippedBy = "turns";
		this._onChange = onChange;
	}

	get paused(): false {
		return false;
	}

	/** Warning thresholds never block a new autonomous turn. */
	canStart(): true {
		return true;
	}

	status(): AutonomyStatus {
		return {
			paused: false,
			trippedBy: this._trippedBy,
			turnsUsed: this._turnsUsed,
			turnsBudget: this._limits.autonomousTurns,
			tokensUsed: this._tokensUsed,
			tokensBudget: this._limits.autonomousTokens,
		};
	}

	/** Returns the newly crossed threshold, or null when no new warning fired. */
	noteTurnStart(): AutonomyThreshold | null {
		this._turnsUsed++;
		if (!this._turnsWarned && this._turnsUsed >= this._limits.autonomousTurns) {
			this._turnsWarned = true;
			return this._warn("turns");
		}
		this._changed();
		return null;
	}

	/** Returns the newly crossed threshold, or null when no new warning fired. */
	noteTokens(delta: number): AutonomyThreshold | null {
		if (!Number.isFinite(delta) || delta <= 0) return null;
		this._tokensUsed += delta;
		if (!this._tokensWarned && this._tokensUsed >= this._limits.autonomousTokens) {
			this._tokensWarned = true;
			return this._warn("tokens");
		}
		this._changed();
		return null;
	}

	/** Start a fresh accounting window on genuine user input. */
	reset(): void {
		this._turnsUsed = 0;
		this._tokensUsed = 0;
		this._trippedBy = null;
		this._turnsWarned = false;
		this._tokensWarned = false;
		this._changed();
		this._emit("reset");
	}

	subscribe(listener: AutonomyListener): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	private _warn(by: AutonomyThreshold): AutonomyThreshold {
		this._trippedBy = by;
		this._changed();
		this._emit("warning");
		return by;
	}

	private _changed(): void {
		try {
			this._onChange?.({
				trippedBy: this._trippedBy,
				turnsUsed: this._turnsUsed,
				tokensUsed: this._tokensUsed,
			});
		} catch {
			// Persistence is diagnostic; accounting must not break a turn.
		}
	}

	private _emit(event: AutonomyEventKind): void {
		const status = this.status();
		for (const listener of this._listeners) {
			try {
				listener(event, status);
			} catch {
				// Warning listeners never control execution.
			}
		}
	}
}
