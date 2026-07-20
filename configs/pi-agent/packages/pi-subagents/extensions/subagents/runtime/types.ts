/**
 * runtime/types.ts — the SubagentRuntime interface: the runtime swap-point.
 *
 * core.ts (facade), tools/, and tui/ talk ONLY to this interface;
 * runtime/in-process.ts is the in-process implementation. A future RPC-child or
 * daemon runtime is one new file implementing this interface.
 *
 * Hub-and-spoke: powers the model denies (peer messaging, blocking questions,
 * nested spawning) have no methods here, so they cannot be re-invented above
 * the swap-point. Human approval is delegated to pi-safety over pi.events.
 *
 * Contract-only module: types + one interface, no implementation.
 */

import type { ArchivedInfo } from "../store/archive.ts";
import type { AgentState, AgentVitals, Lifetime } from "../store/registry.ts";
import type { OpenTask } from "../store/open-tasks.ts";
import type { ThinkingLevel } from "../typedefs/parse.ts";

export interface AgentActivity {
	/** The current tool name (e.g. "bash", "read"), or "" while thinking. */
	tool: string;
	/** A short human summary (e.g. "Bash: find CLI files"). */
	summary: string;
	/** Tool calls made this turn. */
	toolUses: number;
	/** Cumulative session tokens at the latest finalized message. */
	tokens: number;
	/** Current context fill 0–100, or null until Pi can calculate it. */
	ctxPercent: number | null;
}

/** One tree-widget row: an agent's live activity keyed by address. */
export interface AgentActivityRow extends AgentActivity {
	address: string;
	/** Human display name supplied by the spawning LLM. */
	label: string;
}

/**
 * Session defaults used when the def's frontmatter leaves them unset
 * ("omit = inherit session"). Model is an opaque `provider/modelId` ref so
 * this contract stays SDK-type-free; the runtime resolves it.
 */
export interface InheritedDefaults {
	modelRef?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Spawn is EITHER typed (a `<type>.md` in the libraries) or ad-hoc (`prompt`
 * supplied inline; reserved type "adhoc"). Exactly one of type/prompt.
 */
export interface SpawnOptions {
	/** Type name — resolved live against the type libraries at wake. */
	type?: string;
	/** Ad-hoc role prose — persisted as the instance's def.md. */
	prompt?: string;
	/** Instance id. Typed persistent defaults to "main"; REQUIRED for persistent ad-hoc; forbidden for oneshots. */
	id?: string;
	/** Short human display name for TUI surfaces. Tool calls require it; direct callers get a deterministic fallback. */
	label?: string;
	/** Default: "persistent" for typed spawns, "oneshot" for ad-hoc. */
	lifetime?: Lifetime;
	/** Optional first task — spawn + assign in one call (its envelope id is the await anchor). */
	task?: string;
	/** Session defaults for fields the def leaves unset. */
	inherit?: InheritedDefaults;
	/** Ad-hoc only: model override (`provider/modelId` or a CLI model ref). */
	model?: string;
	/** Ad-hoc only: thinking level override. */
	thinking?: ThinkingLevel;
	/** Ad-hoc only: coding-tool allowlist (default: all coding tools). */
	tools?: string[];
}

export interface SpawnResult {
	/** `<type>/<id>`. */
	address: string;
	/** Stable human display name used by TUI surfaces. */
	label: string;
	/** false = existed, spawn woke it, memory intact (get-or-create). */
	created: boolean;
	state: AgentState;
	vitals: AgentVitals;
	/** Envelope/anchor id of the optional initial task (subagent_await anchor). */
	taskEnvelopeId?: string;
}

export interface SendOptions {
	to: string;
	text: string;
}

export interface SendResult {
	/** "delivered" = woke a dormant agent; "queued" = held for a busy recipient. */
	delivery: "delivered" | "queued";
	disposition: "woken" | "held" | "queued" | "main" | "bounced" | "dropped";
	recipientState?: AgentState;
	/** The task envelope's id — the await anchor for this assignment. */
	envelopeId: string;
	bounceReason?: string;
}

/** One rendered envelope for await results / peeks. */
export interface EnvelopeView {
	id: string;
	type: "report" | "error";
	text: string;
	correlationId: string | null;
	data?: unknown;
	final?: boolean;
}

export interface AwaitTarget {
	to: string;
	anchorId: string;
}

export type TargetOutcome =
	| { to: string; anchorId: string; status: "completed"; report: EnvelopeView }
	| { to: string; anchorId: string; status: "error"; error: EnvelopeView }
	| { to: string; anchorId: string; status: "retired" };

export interface AwaitOptions {
	targets: AwaitTarget[];
	/** "all" (default): wait for every target. "any": return on the first terminal outcome. */
	mode: "all" | "any";
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

export interface AwaitResult {
	/** "completed" = the mode's condition was met; "timeout" = partial results below; "empty" = no targets. */
	status: "completed" | "timeout" | "empty";
	/** Terminal outcomes gathered (their envelopes are consumed). */
	outcomes: TargetOutcome[];
	/** Targets still unresolved (timeout / any-mode leftovers) — nothing consumed for these. */
	pending: AwaitTarget[];
}

export interface SteerResult {
	/** false = agent wasn't running; steering is mid-turn-only. */
	steered: boolean;
}

export interface CancelResult {
	/** false = agent wasn't running or queued. */
	cancelled: boolean;
}

export interface RetireResult {
	retired: true;
	/** Where the agent dir was moved (`.archive/...`), or null if none existed. */
	archiveDir: string | null;
}

/** One roster row: registry record + live vitals. */
export interface RosterEntry {
	address: string;
	label: string;
	type: string;
	id: string;
	state: AgentState;
	lifetime: Lifetime;
	purview: string;
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

/** An open task anchor (await-all's default target set). */
export interface OpenTaskEntry extends OpenTask {
	anchorId: string;
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
	 * Get-or-create on `<type>/<id>`: existing persistent agents wake with memory
	 * intact. Enforces the lifetime rules (oneshots are auto-named; persistent
	 * ad-hoc requires an explicit id). With a `task`, the turn runs
	 * asynchronously — spawn returns once the agent is registered and
	 * queued/running.
	 */
	spawn(options: SpawnOptions): Promise<SpawnResult>;

	/** Deliver a task to an agent as the MAIN agent. Never interrupts a running turn. */
	send(options: SendOptions): Promise<SendResult>;

	/** Deliver text to an agent as the USER; also drops a quiet FYI report to main. */
	sendAsUser(options: SendOptions): Promise<SendResult>;

	/** Full roster: registry + live vitals. */
	status(): Promise<RosterEntry[]>;

	/** Detail + transcript tail for one agent; read-only. Null if unknown. */
	peek(address: string, tail?: number): Promise<AgentDetail | null>;

	/** Inject mid-turn (main-agent-only). No-op if not running. */
	steer(to: string, text: string): Promise<SteerResult>;

	/** Abort the current turn; agent stays alive, memory intact, goes dormant, mail stays pending. */
	cancel(to: string): Promise<CancelResult>;

	/** The ONLY destructive power: deregister + archive the dir. Address bounces after. */
	retire(to: string): Promise<RetireResult>;

	/**
	 * Explicit in-run join: block until the targets' final reports (or terminal
	 * error/retired outcomes) land in the main mailbox, or the timeout elapses.
	 * Matched envelopes are consumed and their open tasks closed; unmatched mail
	 * is untouched.
	 */
	awaitResults(options: AwaitOptions): Promise<AwaitResult>;

	/** The open task anchors (await-all's default target set). */
	openTasks(): OpenTaskEntry[];

	/** Retired agents still on disk in .archive/. */
	archived(): ArchivedInfo[];

	/** Live per-agent activity for currently-working agents (tree widget). */
	activitySnapshot(): AgentActivityRow[];

	/** Await all in-flight subagent turns (host shutdown / tests). */
	whenIdle(): Promise<void>;

	/** Subscribe to runtime events. Returns the unsubscribe function. */
	onEvent(listener: RuntimeEventListener): () => void;

	/** Release every live agent session (host session shutdown). */
	dispose(): Promise<void>;
}
