/**
 * runtime/types.ts — the SubagentRuntime interface: D7's swap-point.
 *
 * core.ts (facade), tools/, and tui/ talk ONLY to this interface;
 * runtime/in-process.ts is the v1-style in-process implementation. A future
 * RPC-child or daemon runtime is one new file implementing this interface.
 *
 * The interface mirrors the power matrix — powers it denies (approve, suspend,
 * retune, compact, fork) have no methods, so they cannot be re-invented above
 * the swap-point. NOTE: human approval/escalation is NOT here in v2 — it's
 * delegated to pi-safety over pi.events (D10a).
 *
 * The interface grows phase by phase. This file is the Phase 2 surface: spawn,
 * status, peek, steer, interrupt, dispose, onEvent. Mail (send/collect) and
 * lifecycle (retire) join in later phases.
 *
 * Contract-only module: types + one interface, no implementation.
 */

import type { AgentState, AgentVitals, Lifetime } from "../store/registry.ts";
import type { ThinkingLevel } from "../typedefs/parse.ts";

/**
 * Session defaults used when the type's frontmatter leaves them unset
 * ("omit = inherit session", D20). Model is an opaque `provider/modelId` ref so
 * this contract stays SDK-type-free; the runtime resolves it.
 */
export interface InheritedDefaults {
	modelRef?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Instance identity ONLY — every type-level knob is frontmatter (D19). No team (D12). */
export interface SpawnOptions {
	/** Type name — resolved live against the type libraries at wake (D6). */
	type: string;
	/** Instance id (purview slug). Persistent defaults to "main"; oneshots must NOT pass one. */
	id?: string;
	/** Default "persistent" (D13). */
	lifetime?: Lifetime;
	/** Optional first message — spawn + assign in one call. */
	task?: string;
	/** Explicitly detach the task from the current completion barrier (D27' — default is already background). */
	background?: boolean;
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
	/** Envelope/anchor id of the optional initial task (await anchor, Phase 7). */
	taskEnvelopeId?: string;
}

export interface SendOptions {
	to: string;
	text: string;
	/** Set when this send answers a question envelope. */
	correlationId?: string;
	/** Reserved for the completion barrier (Phase 7); v2 is background by default. */
	background?: boolean;
}

export interface SendResult {
	/** "delivered" = woke a dormant agent; "queued" = held for a busy recipient / queued to main. */
	delivery: "delivered" | "queued";
	disposition: "woken" | "held" | "queued" | "main" | "bounced" | "dropped";
	recipientState?: AgentState;
	envelopeId: string;
	bounceReason?: string;
}

export interface CollectResult {
	requested: true;
	/** The collect-request envelope's id; the fulfilling report carries it as correlationId. */
	requestId: string;
	recipientState?: AgentState;
}

export interface SteerResult {
	/** false = agent wasn't running; steering is mid-turn-only (D11). */
	steered: boolean;
}

export interface InterruptResult {
	/** false = agent wasn't running. */
	interrupted: boolean;
}

/** One roster row: registry record + live vitals (D15). Flat — no teams (D12). */
export interface RosterEntry {
	address: string;
	type: string;
	id: string;
	state: AgentState;
	lifetime: Lifetime;
	purview: string;
	vitals: AgentVitals;
	/** Unprocessed envelopes in this agent's mailbox (Phase 3+; 0 for now). */
	unread: number;
	updatedAt: string;
}

/** One rendered transcript entry for peeks (tail of the Pi-native JSONL). */
export interface TranscriptEntry {
	role: string;
	text: string;
	timestamp: string;
}

export interface AgentDetail extends RosterEntry {
	typeFileHash: string;
	createdAt: string;
	/** Current Pi-native session file, if one exists yet. */
	sessionFile: string | null;
	/** Last `tail` transcript entries (peek). */
	tail: TranscriptEntry[];
}

export type RuntimeEvent =
	| { type: "state-changed"; address: string; state: AgentState }
	| { type: "turn-started"; address: string }
	| { type: "turn-finished"; address: string; vitals: AgentVitals }
	| { type: "turn-error"; address: string; error: string };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface SubagentRuntime {
	/**
	 * Get-or-create on `<type>/<id>` (D4/D5): existing persistent agents wake
	 * with memory intact. Enforces the lifetime rule (explicit id on a oneshot =
	 * error). With a `task`, the turn runs asynchronously — spawn returns once
	 * the agent is registered and queued/running.
	 */
	spawn(options: SpawnOptions): Promise<SpawnResult>;

	/** Deliver text to an agent as the MAIN agent. Never interrupts a running turn (D11). */
	send(options: SendOptions): Promise<SendResult>;

	/** Deliver text to an agent as the USER (D17); also drops a quiet FYI report to main. */
	sendAsUser(options: SendOptions): Promise<SendResult>;

	/** Non-blocking collect: send a collect-request; the result arrives later as a report. */
	collect(to: string, schema: unknown): Promise<CollectResult>;

	/** Full roster: registry + live vitals (D15). */
	status(): Promise<RosterEntry[]>;

	/** Detail + transcript tail for one agent; read-only. Null if unknown. */
	peek(address: string, tail?: number): Promise<AgentDetail | null>;

	/** Inject mid-turn (main-agent-only). No-op if not running. */
	steer(to: string, text: string): Promise<SteerResult>;

	/** Abort the current turn; agent stays alive, memory intact, goes dormant. */
	interrupt(to: string): Promise<InterruptResult>;

	/** Subscribe to runtime events. Returns the unsubscribe function. */
	onEvent(listener: RuntimeEventListener): () => void;

	/** Release every live agent session (host session shutdown). */
	dispose(): Promise<void>;
}
