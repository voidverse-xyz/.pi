/**
 * runtime/types.ts — the SubagentRuntime interface: D7's swap-point.
 *
 * Everything above this line (core.ts facade, tools/, tui/) talks ONLY to this
 * interface; runtime/in-process.ts is the v1 implementation. A future RPC-child
 * or daemon runtime is one new file implementing this interface — nothing else
 * moves (06-architecture structural rule 1).
 *
 * The interface deliberately mirrors the power matrix (01-power-matrix.md):
 * spawn, send, steer, interrupt, retire, status, peek, onEvent — the matrix IS
 * the API. Powers the matrix denies (approve, suspend, retune, compact, fork)
 * have no methods, so they cannot be re-invented above the swap-point.
 *
 * Contract-only module: types and one interface, no implementation.
 */

import type { AutonomyStatus } from "../rails/autonomy.ts";
import type { EscalationEvent, EscalationRecord } from "../sandbox/escalation.ts";
import type { AgentState, AgentVitals, Lifetime } from "../store/registry.ts";
import type { ThinkingLevel } from "../typedefs/parse.ts";

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Defaults inherited from the spawner's session, used when the type's
 * frontmatter doesn't pin them (04-type-schema: "omit = inherit session").
 * Model is an opaque reference here ("provider/modelId") so this contract
 * stays SDK-type-free; the runtime resolves it against its model registry.
 */
export interface InheritedDefaults {
	/** `provider/modelId` of the spawning session's current model. */
	modelRef?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Instance identity ONLY — every type-level knob lives in frontmatter (D19). */
export interface SpawnOptions {
	/** Type name — resolved live against the type libraries at wake (D6). */
	type: string;
	/**
	 * Instance id (purview slug). Persistent spawns default to "main" (D5);
	 * oneshots must NOT pass one — named = persistent, anonymous = disposable
	 * (D20 lifetime rule) — the runtime auto-assigns `tmp-<short>`.
	 */
	id?: string;
	/** Team to join; naming an unknown team creates it (D12). */
	team?: string;
	/** Default "persistent" (D13). */
	lifetime?: Lifetime;
	/** Optional first message — spawn + assign in one call. */
	task?: string;
	/** Session defaults for fields the frontmatter leaves unset. */
	inherit?: InheritedDefaults;
}

export interface SpawnResult {
	/** `<type>/<id>`. */
	address: string;
	/** false = existed, spawn woke it, memory intact (get-or-create, D4/D5). */
	created: boolean;
	state: AgentState;
	vitals: AgentVitals;
}

// ---------------------------------------------------------------------------
// Send / steer / interrupt / retire
// ---------------------------------------------------------------------------

export interface SendOptions {
	/** Recipient address `<type>/<id>`. */
	to: string;
	text: string;
	/**
	 * Ordering hint only — accepted and recorded, but both values behave the
	 * same at delivery: the envelope lands at the recipient's next turn
	 * boundary, or wakes it immediately if dormant. Mail never interrupts a
	 * running turn (D11), and there is no way to queue mail on a dormant
	 * agent without waking it.
	 */
	when?: "now" | "after-turn";
	/** Set when this send answers a question envelope (03-tool-surface). */
	correlationId?: string;
}

export interface SendResult {
	/** "delivered" = the send woke a dormant agent into a turn; "queued" = it landed in the mailbox for an already-scheduled/running turn. */
	delivery: "delivered" | "queued";
	/**
	 * How the Deliverer routed it: "woken" = dormant recipient, wake fired
	 * (its state is then "queued" — the turn is scheduled, pairing with
	 * delivery:"delivered"); "held" = recipient mid-turn/waiting, consumed at
	 * the boundary; "queued" = recipient already had a turn queued.
	 */
	disposition: "woken" | "held" | "queued";
	recipientState: AgentState;
	/** The delivered envelope's id (correlation anchor for later answers). */
	envelopeId: string;
}

export interface CollectResult {
	requested: true;
	/** The collect-request envelope's id — the report answering it will carry this as correlationId. */
	requestId: string;
	recipientState: AgentState;
}

export interface SteerResult {
	/** false = agent wasn't running; steering is mid-turn-only (D11). */
	steered: boolean;
}

export interface InterruptResult {
	/** false = agent wasn't running. */
	interrupted: boolean;
}

export interface RetireResult {
	retired: true;
	/** Where the agent dir was moved (`.archive/...`), null if none existed. */
	archiveDir: string | null;
}

// ---------------------------------------------------------------------------
// Status / peek (read-only, never perturbs)
// ---------------------------------------------------------------------------

/**
 * Why a `waiting` agent is waiting: the pending escalation, summarized for
 * the roster (full record via pendingEscalations()).
 */
export interface PendingEscalationSummary {
	/** `esc_<ulid>` (the human-gate record id). */
	id: string;
	/** The escalation envelope delivered to main; null if delivery failed. */
	envelopeId: string | null;
	/** Tool that was blocked (bash | edit | write). */
	tool: string;
	/** Why the sandbox blocked it. */
	reason: string;
}

/** One roster row: registry record joined with teams.json + live vitals (D15). */
export interface RosterEntry {
	address: string;
	type: string;
	id: string;
	state: AgentState;
	lifetime: Lifetime;
	purview: string;
	teams: string[];
	vitals: AgentVitals;
	/** Unprocessed envelopes in this agent's mailbox (mail it has not seen yet). */
	unread: number;
	/** Present iff state is "waiting": the escalation(s) blocking it. */
	waitingOn?: PendingEscalationSummary[];
	updatedAt: string;
}

/** One rendered transcript entry for peeks (tail of the Pi-native JSONL). */
export interface TranscriptEntry {
	/** "user" | "assistant" | "toolResult" | other Pi message roles. */
	role: string;
	/** Flattened text content (tool calls summarized). */
	text: string;
	timestamp: string;
}

/** One question this agent sent that has not been answered (or bounced) yet. */
export interface OutstandingQuestion {
	/** The question envelope's id — an answer must carry it as correlationId. */
	id: string;
	text: string;
}

export interface AgentDetail extends RosterEntry {
	typeFileHash: string;
	createdAt: string;
	/** Current Pi-native session file, if one exists yet. */
	sessionFile: string | null;
	/**
	 * Questions the agent sent (to main or peers) with no answer/bounce on
	 * record — recoverable even after the asker's counterpart lost its digest.
	 */
	outstandingQuestions: OutstandingQuestion[];
	/** Last `tail` transcript entries (peek). */
	tail: TranscriptEntry[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Runtime event union — what tools/tui observe. The TUI's live tail (D8) and
 * the main-agent wake mechanics (Phase 3) both hang off onEvent.
 */
export type RuntimeEvent =
	| { type: "state-changed"; address: string; state: AgentState }
	| { type: "turn-started"; address: string }
	| { type: "turn-finished"; address: string; vitals: AgentVitals }
	| { type: "turn-error"; address: string; error: string }
	| { type: "agent-retired"; address: string; archiveDir: string | null }
	/** An envelope left the runtime (Phase 3 emits; declared now so the contract is stable). */
	| { type: "envelope-sent"; from: string; to: string; envelopeId: string }
	/** A delivery bounced — guard rejection or unknown address (Phase 4, D12/D21). */
	| { type: "bounce"; from: string; to: string; envelopeId: string; reason: string }
	/** The D21 autonomy pool tripped: no new autonomous turns until reset/resume. */
	| { type: "autonomy-paused"; status: AutonomyStatus }
	/** The pool was refilled (user input or manual resume); queued mail drains. */
	| { type: "autonomy-resumed"; status: AutonomyStatus }
	/** Phase 5: a guarded tool call escalated / was resolved (D10/D22 modal). */
	| EscalationEvent;

export type RuntimeEventListener = (event: RuntimeEvent) => void;

// ---------------------------------------------------------------------------
// The swap-point
// ---------------------------------------------------------------------------

export interface SubagentRuntime {
	/**
	 * Get-or-create on `<type>/<id>` (D4/D5): existing persistent agents wake
	 * with memory intact; result reports which happened. Enforces the D20
	 * lifetime rule (explicit id on a oneshot = error). If `task` is given the
	 * turn runs asynchronously — spawn returns as soon as the agent is
	 * registered and queued/running.
	 */
	spawn(options: SpawnOptions): Promise<SpawnResult>;

	/** Deliver text to an agent as the MAIN agent. Never interrupts a running turn (D11). */
	send(options: SendOptions): Promise<SendResult>;

	/**
	 * Deliver text to an agent as the USER (D17 superuser row). Also drops a
	 * quiet FYI report envelope to the main agent — user↔subagent traffic is
	 * never secret.
	 */
	sendAsUser(options: SendOptions): Promise<SendResult>;

	/**
	 * Non-blocking collect (03-tool-surface): send a collect-request message
	 * carrying `schema`; the result arrives later as a report envelope whose
	 * payload.data is validated against the schema on arrival.
	 */
	collect(to: string, schema: unknown): Promise<CollectResult>;

	/** Inject mid-turn (main-agent-only power). No-op if not running. */
	steer(to: string, text: string): Promise<SteerResult>;

	/** Abort the current turn; agent stays alive, memory intact, goes dormant. */
	interrupt(to: string): Promise<InterruptResult>;

	/**
	 * The ONLY destructive power: deregister, scrub teams.json, move the dir
	 * to .archive/ (D13). Address bounces afterwards.
	 */
	retire(to: string): Promise<RetireResult>;

	/** Full roster: registry ⋈ teams ⋈ live vitals (D15). */
	status(): Promise<RosterEntry[]>;

	/**
	 * Detail + transcript tail for one agent; read-only, never perturbs.
	 * Null if the address is unknown (retired or never existed).
	 */
	peek(address: string, tail?: number): Promise<AgentDetail | null>;

	/**
	 * Escalations pending a HUMAN decision (D10; Phase 6 modal queue). The
	 * blocked agents sit in `waiting` with their tool calls paused.
	 */
	pendingEscalations(): EscalationRecord[];

	/**
	 * HUMAN-ONLY (D10 — approvals never flow downhill; the main agent's LLM
	 * must never reach this): approve one pending escalation; the blocked
	 * tool call proceeds and the agent resumes. False if the id is unknown.
	 */
	approveEscalation(id: string): boolean;

	/**
	 * Deny one pending escalation (human UI; the main agent denies via mail —
	 * a send whose correlationId is the escalation envelope's id). The
	 * blocked tool returns an error result carrying `note`; the agent reacts
	 * and its turn continues. False if the id is unknown.
	 */
	denyEscalation(id: string, note?: string): boolean;

	/** Subscribe to runtime events. Returns the unsubscribe function. */
	onEvent(listener: RuntimeEventListener): () => void;

	/** Release every live agent session (host session shutdown). */
	dispose(): Promise<void>;
}
