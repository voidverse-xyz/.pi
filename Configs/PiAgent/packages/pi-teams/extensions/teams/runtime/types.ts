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
 * Contract-only module: types + one interface, no implementation.
 */

import type { ArchivedInfo } from "../store/archive.ts";
import type { AgentState, AgentVitals, Lifetime } from "../store/registry.ts";
import type { PeerControl } from "../store/settings.ts";
import type { ThinkingLevel } from "../typedefs/parse.ts";

/**
 * Peer-messaging control (D12). "llm" = the main agent decides via team_peers.
 * Same union as the settings knob (store/settings.ts `peers`) — one type, two
 * names, so the settings layer stays SDK/runtime-free.
 */
export type PeerMode = PeerControl;

export interface AgentActivity {
	/** The current tool name (e.g. "bash", "read"), or "" while thinking. */
	tool: string;
	/** A short human summary (e.g. "Bash: find CLI files"). */
	summary: string;
	/** Tool calls made this turn. */
	toolUses: number;
}

/** One tree-widget row: an agent's live activity and usage keyed by address. */
export interface AgentActivityRow extends AgentActivity {
	address: string;
	/** Display-only label from spawn, if one was given. */
	label?: string;
	/** Current context fill from the live session, 0–100; null when unknown. */
	ctxPercent: number | null;
	/** Cumulative input/output/cache tokens consumed by this agent session. */
	tokens: number;
	/** Unread mail queued for this agent while its current turn runs. */
	unread: number;
}

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
	/**
	 * Optional display-only label ("what is this one doing"), shown in the TUI and
	 * roster. NOT part of the address — especially useful for oneshots, whose
	 * tmp-<hex> ids say nothing.
	 */
	label?: string;
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
	/** Envelope/anchor id of the optional initial task (team_await anchor, D26'). */
	taskEnvelopeId?: string;
}

export interface SendOptions {
	to: string;
	text: string;
	/** Set when this send answers a question envelope. */
	correlationId?: string;
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

export type AwaitStatus = "completed" | "attention" | "timeout" | "retired";

export interface AwaitEnvelopeView {
	id: string;
	type: "question" | "escalation" | "error" | "report";
	text: string;
	correlationId: string | null;
	data?: unknown;
	final?: boolean;
}

export interface AwaitOptions {
	to: string;
	waitFor: "final" | "collect";
	anchorId: string;
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

export interface AwaitResult {
	status: AwaitStatus;
	to: string;
	anchorId: string;
	report?: AwaitEnvelopeView;
	attention?: AwaitEnvelopeView;
	/** Collect-mode schema verdict, when a collect request was on record. */
	validation?: { valid: boolean; errors: string[] };
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
	/** Where the agent dir was moved (`.archive/...`), or null if none existed. */
	archiveDir: string | null;
}

/** One roster row: registry record + live vitals (D15). Flat — no teams (D12). */
export interface RosterEntry {
	address: string;
	type: string;
	id: string;
	state: AgentState;
	lifetime: Lifetime;
	purview: string;
	/** Display-only label from spawn, if one was given. */
	label?: string;
	vitals: AgentVitals;
	/** Unprocessed envelopes in this agent's mailbox. */
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
	| { type: "turn-error"; address: string; error: string }
	| { type: "agent-retired"; address: string; archiveDir: string | null };

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

	/** The ONLY destructive power: deregister + archive the dir (D13). Address bounces after. */
	retire(to: string): Promise<RetireResult>;

	/**
	 * Explicit in-run join (D24'/D26'/D27'): block until a matching final/collect
	 * report from `to` correlated to `anchorId` lands in the main mailbox, or the
	 * agent needs attention (question/escalation/error — so it can't deadlock),
	 * or it retired, or the timeout elapses.
	 */
	awaitResult(options: AwaitOptions): Promise<AwaitResult>;

	/** Retired agents still on disk in .archive/ (D13). */
	archived(): ArchivedInfo[];

	/** Live per-agent activity for currently-working agents (tree widget). */
	activitySnapshot(): AgentActivityRow[];

	/** User-level peer control (D12): "on"/"off" force it, "llm" delegates to main. */
	setUserPeerMode(mode: PeerMode): void;

	/** Main-agent peer override (D12), honored only while the user delegates. null = per-type default. */
	setMainPeerOverride(value: boolean | null): void;

	/** Current peer-control state. */
	peerState(): { userMode: PeerMode; mainOverride: boolean | null; userControls: boolean };

	/** Await all in-flight subagent turns (host shutdown / tests). */
	whenIdle(): Promise<void>;

	/** Subscribe to runtime events. Returns the unsubscribe function. */
	onEvent(listener: RuntimeEventListener): () => void;

	/** Release every live agent session (host session shutdown). */
	dispose(): Promise<void>;
}
