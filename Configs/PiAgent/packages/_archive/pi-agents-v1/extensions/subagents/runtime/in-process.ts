/**
 * runtime/in-process.ts — SubagentRuntime v1: subagents as AgentSession loops
 * inside the main Pi process (D7).
 *
 * Each woken agent is a real `AgentSession` built with `createAgentSession`,
 * with these injections:
 *  - sessionManager: SessionManager.create/open pointed at the instance dir
 *    from store/layout.ts — the agent's transcript is a REAL Pi session file
 *    beside Pi's own (D3), resumable by Pi itself; wake = open the latest
 *    JSONL, memory restored by the SDK.
 *  - resourceLoader: a DefaultResourceLoader with all discovery disabled
 *    (no extensions/skills/prompts/themes, noContextFiles always true —
 *    subagents get a deterministic context) carrying the D18 layers 2+3+4
 *    in D18 order via appendSystemPrompt (context/compose.ts): layer 2 is
 *    loaded here with the SDK's loadProjectContextFiles when the type's
 *    projectContext flag is on, and compose places it FIRST (the SDK's own
 *    contextFiles path would put it after layers 3+4, hence the takeover).
 *  - model/thinking: frontmatter pin resolved against the shared ModelRegistry,
 *    else inherited session defaults, else SDK defaults (04-type-schema).
 *  - customTools: the subagent tool trio (tools/sub-agent.ts) with the agent's
 *    address closed over — send_message / report / ask.
 *
 * Mail (Phase 3, D11/D14): EVERY input to a subagent is an envelope through
 * mail/deliver.ts — spawn tasks, main sends, peer mail, answers. A turn's
 * prompt is always the deterministic wake digest over the mailbox's pending
 * envelopes (D18 layer 6). Turns are serialized per agent (one mailbox, one
 * consumer — the actor rule); envelopes are marked done only AFTER
 * prompt+waitForIdle returns, i.e. after the receiving turn is durably in the
 * session JSONL (at-least-once, 02-contract §Ordering). Mail arriving
 * mid-turn is never injected (D11) — the end-of-turn drain schedules the next
 * digest turn at the boundary. A turn that ends with the agent's own
 * questions outstanding simply goes dormant; the answer wakes it (D14).
 * Oneshots auto-retire after their final report is delivered (D13).
 *
 * Lifecycle (D13/D20): named = persistent, anonymous = oneshot with auto
 * `tmp-<short>` id; explicit id on a oneshot is an error; get-or-create only
 * ever matches persistent agents. Turns take a Scheduler slot (queued state
 * while waiting); registry state + vitals (SessionStats, D15) are updated
 * around every turn; the resolved type-file hash is recorded at wake (D6).
 *
 * Teams + rails (Phase 4, D12/D21/D27): the Deliverer runs shared-team and
 * maxHops guards. Session AutonomyBudget counters meter turns/tokens and emit
 * one-shot warnings but never gate execution. Roster-change wake-digest lines
 * (D18): each mail turn diffs the agent's
 * `.roster.json` snapshot against teams.json and prepends the changes.
 * Sandbox + escalation (Phase 5, D10/D20/D22): _buildSessionOptions maps the
 * type's tools/readOnly/writePaths/denyPaths onto the session via
 * `noTools: "builtin"` + sandbox/tools-filter.ts customTools (Pi's own tool
 * definitions, mutating ones wrapped through sandbox/paths.ts +
 * sandbox/bash-guard.ts). A guarded call that needs a human blocks inside
 * its tool execute on EscalationManager.request(): the agent flips to
 * `waiting`, an escalation envelope reaches main (surfaced by the active
 * barrier or next real user turn), and —
 * DECISION — the turn RELEASES its scheduler slot while waiting (a possibly-
 * forever human pause must not starve other agents; per-agent turn
 * serialization is untouched because the turn's chain promise stays pending)
 * and re-acquires one before the tool proceeds on approve/deny. The human
 * resolves via approve/deny (core → Phase 6 modal); the main agent may only
 * DENY, by mailing the waiting agent with correlationId = the escalation
 * envelope's id (no new tool surface, 01-power-matrix).
 * Thresholds (D15/D27): frontmatter/settings maxTokensTotal,
 * maxTurnMinutes, and maxContextCompactions emit targeted warnings only.
 * Crossing never aborts, gates, or retires an agent. Oneshots still auto-retire
 * after final reports and fatal runtime errors.
 */

import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	type AuthStorage,
	createAgentSession,
	type CreateAgentSessionOptions,
	DefaultResourceLoader,
	loadProjectContextFiles,
	type ModelRegistry,
	parseSessionEntries,
	resolveCliModel,
	type ResolveCliModelResult,
	type SessionMessageEntry,
	SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { composeContext, type IdentityOptions, type TeamRoster } from "../context/compose.ts";
import {
	type Envelope,
	formatAgentAddress,
	isValidIdSegment,
	isValidTypeSegment,
	MAIN_ADDRESS,
	ENVELOPE_ID_RE,
	parseAddress,
	ulid,
	USER_ADDRESS,
} from "../mail/envelope.ts";
import { Deliverer, type DeliveryOutcome, makeTeamGuard } from "../mail/deliver.ts";
import type { AutonomyBudget } from "../rails/autonomy.ts";
import { DEFAULT_MAX_HOPS, makeHopsGuard } from "../rails/hops.ts";
import { composeWakeDigest } from "../mail/digest.ts";
import {
	beginDelivery,
	cancelHostDeliveriesWhere,
	cancelHostDelivery,
	deleteSentQuestions,
	lookupSentQuestion,
	markDone,
	pendingCount,
	readPending,
	recordAwaitAnchor,
	readStoredHostEnvelopes,
} from "../mail/mailbox.ts";
import type { Layout } from "../store/layout.ts";
import { archiveAgentDir, hasRetirementTombstone } from "../store/archive.ts";
import { pidStartToken, processMarkerIsLive } from "../store/process-identity.ts";
import {
	type AgentRecord,
	type AgentState,
	type AgentVitals,
	atomicWriteJson,
	emptyVitals,
	getAgent,
	listAgents,
	readRegistry,
	removeAgent,
	updateRegistry,
	upsertAgent,
	withFileLockSync,
} from "../store/registry.ts";
import {
	addTo,
	diffRosterViews,
	readRosterSnapshot,
	readTeams,
	rosterViewOf,
	scrubAddress,
	teamsOf,
	updateTeams,
	writeRosterSnapshot,
} from "../store/teams.ts";
import { mailboxDoneDirOf, rosterSnapshotFileOf, sentQuestionsFileOf } from "../store/layout.ts";
import { type DiscoveredTypeDef, resolveTypeDef } from "../typedefs/discover.ts";
import { parseTypeFile, type ThinkingLevel, type TypeConfig, type TypeDefinition } from "../typedefs/parse.ts";
import { createSubagentTools, type SubagentMailPort } from "../tools/sub-agent.ts";
import {
	EscalationManager,
	type EscalationRecord,
} from "../sandbox/escalation.ts";
import { realpathDeep, type PathPolicy } from "../sandbox/paths.ts";
import { buildSandboxedTools } from "../sandbox/tools-filter.ts";
import { DEFAULT_MAX_CONCURRENT, type ReleaseSlot, Scheduler } from "./scheduler.ts";
import type {
	AgentDetail,
	CollectResult,
	InheritedDefaults,
	InterruptResult,
	OutstandingQuestion,
	RetireResult,
	RosterEntry,
	RuntimeEvent,
	RuntimeEventListener,
	SendOptions,
	SendResult,
	SpawnOptions,
	SpawnResult,
	SteerResult,
	SubagentRuntime,
	TranscriptEntry,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InProcessRuntimeOptions {
	/** The single path authority for this project cwd. */
	layout: Layout;
	/**
	 * Model registry shared with the host session (ctx.modelRegistry) — used
	 * to resolve frontmatter model pins and passed into every agent session.
	 * Omitted → the SDK builds its default registry per session.
	 */
	modelRegistry?: ModelRegistry;
	/** Settings shared with the host session; omitted → SDK default. */
	settingsManager?: SettingsManager;
	/** Auth storage override (tests inject an in-memory one). */
	authStorage?: AuthStorage;
	/** Running-turn slot cap (D13). Default 5. */
	maxConcurrent?: number;
	/** Shutdown drain bound in milliseconds. Default 5000; tests may shorten it. */
	disposeTimeoutMs?: number;
	/** False for non-persisted host sessions; persistent workers are rejected. */
	persistentHost?: boolean;
	/** Optional diagnostic callback when an envelope lands in main's mailbox. */
	onMainMail?: (envelope: Envelope) => void;
	/** D21 chain-depth cap. Default 8. A getter keeps it live (Phase 7). */
	maxHops?: number | (() => number);
	/** Session turn/token warning accounting. Omitted = no session thresholds. */
	autonomy?: AutonomyBudget;
	/**
	 * D15/D27 global warning defaults (core settings); a type's frontmatter
	 * overrides field-by-field. Undefined field = no warning. Read live per
	 * turn, so settings edits apply without a rebuild.
	 */
	ceilings?: CeilingDefaults;
	/**
	 * Live project-trust getter (Finding 7): returns whether the host Pi project
	 * is trusted. While UNtrusted, project-local (`<cwd>/.pi/subagents`) type
	 * definitions are NOT loaded or resolved (global types still work). Omitted
	 * = trusted (the direct-construction / harness default). index.ts wires
	 * ctx.isProjectTrusted through setProjectTrust(); read live so a mid-session
	 * trust change applies at the next resolution.
	 */
	isProjectTrusted?: () => boolean;
}

/** Global per-agent warning defaults — same fields frontmatter can pin. */
export interface CeilingDefaults {
	maxTokensTotal?: number | undefined;
	maxTurnMinutes?: number | undefined;
	maxContextCompactions?: number | undefined;
}

/** Frontmatter pin > global default, field by field (04-type-schema). */
export function effectiveCeilings(
	config: Pick<TypeConfig, "maxTokensTotal" | "maxTurnMinutes" | "maxContextCompactions">,
	defaults: CeilingDefaults,
): CeilingDefaults {
	return {
		maxTokensTotal: config.maxTokensTotal ?? defaults.maxTokensTotal,
		maxTurnMinutes: config.maxTurnMinutes ?? defaults.maxTurnMinutes,
		maxContextCompactions: config.maxContextCompactions ?? defaults.maxContextCompactions,
	};
}

/**
 * Which cumulative warning threshold (tokens / compactions) is crossed, if
 * any — a human-readable description, or null. maxTurnMinutes is observed by
 * a live turn timer instead (it is a rate, not a cumulative figure).
 */
export function ceilingViolation(
	vitals: Pick<AgentVitals, "tokens" | "compactions">,
	ceilings: CeilingDefaults,
): string | null {
	if (ceilings.maxTokensTotal !== undefined && vitals.tokens >= ceilings.maxTokensTotal) {
		return `maxTokensTotal (${vitals.tokens} tokens used, ceiling ${ceilings.maxTokensTotal})`;
	}
	if (ceilings.maxContextCompactions !== undefined && vitals.compactions >= ceilings.maxContextCompactions) {
		return `maxContextCompactions (${vitals.compactions} compactions, ceiling ${ceilings.maxContextCompactions})`;
	}
	return null;
}

interface Handle {
	session: AgentSession;
	def: TypeDefinition;
	typeFileHash: string;
	/** Registry incarnation this in-memory session belongs to (address-reuse ABA fence). */
	generationId: string;
	/**
	 * Vitals carried over from BEFORE this live session could see them
	 * (Phase 7, D15): registry totals minus what the freshly-opened session
	 * already accounts for. Zero when the session file holds the whole
	 * history (the normal resume); the previous totals when a fresh session
	 * file started. Cumulative vitals = baseVitals + live SessionStats, so
	 * maxTokensTotal meters the identity's WHOLE life, not one session file.
	 */
	baseVitals: AgentVitals;
	/** Envelopes that triggered the CURRENT turn (hops threading, D21). */
	trigger?: Envelope[] | undefined;
	/** Runtime-unique current turn identity for stale-warning fencing. */
	turnId?: string | undefined;
	/** Oneshot delivered its final report — retire at the turn boundary (D13). */
	retireAfterTurn?: boolean;
	/** Exact final/error envelope proving this generation's auto-retirement. */
	retirementEvidenceId?: string;
	/** Explicit human/main interrupt; warning thresholds never abort turns. */
	abortedBy?: "interrupt" | null;
	/** Lifetime limits already surfaced for this generation. */
	limitWarnings?: Set<"maxTokensTotal" | "maxContextCompactions">;
}

const DEFAULT_PERSISTENT_ID = "main";

/** dispose(): how long to wait for in-flight turns to unwind (C2 clean quit). */
const DISPOSE_CHAIN_TIMEOUT_MS = 5_000;

function oneshotId(): string {
	// 80 random bits keeps disposable addresses compact without the practical
	// archive/address reuse risk of the former 28-bit suffix.
	return `tmp-${randomBytes(10).toString("hex")}`;
}

async function settleWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<void> {
	if (promises.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(promises),
			new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class InProcessRuntime implements SubagentRuntime {
	private readonly _layout: Layout;
	private readonly _modelRegistry: ModelRegistry | undefined;
	private readonly _settingsManager: SettingsManager | undefined;
	private readonly _authStorage: AuthStorage | undefined;
	private readonly _scheduler: Scheduler;
	private readonly _deliverer: Deliverer;
	private readonly _handles = new Map<string, Handle>();
	private readonly _listeners = new Set<RuntimeEventListener>();
	/** Per-agent turn serialization: one mailbox, one consumer (actor rule). */
	private readonly _chains = new Map<string, Promise<void>>();
	private readonly _autonomy: AutonomyBudget | undefined;
	private readonly _ceilings: CeilingDefaults;
	private readonly _persistentHost: boolean;
	private readonly _disposeTimeoutMs: number;
	private readonly _escalations: EscalationManager;
	/**
	 * The running turn's scheduler slot per agent, swappable: an escalation
	 * releases it while `waiting` and re-acquires on resolution (a forever-
	 * pending human decision must not starve other agents' turns).
	 */
	private readonly _slots = new Map<string, { release: ReleaseSlot }>();
	/**
	 * Per-address handle-creation mutex (M2): _ensureHandle spans an await
	 * (createAgentSession) — two racers (spawn + _mailTurn) must never both
	 * build an AgentSession for one agent (loser leaks, transcripts diverge).
	 */
	private readonly _handleLocks = new Map<string, Promise<unknown>>();
	/**
	 * The running turn's maxTurnMinutes wall-clock timer per agent, pausable:
	 * an escalation pauses it while `waiting` (a human decision may last
	 * forever, D22 — the timer meters RUNNING time only) and resumes it with
	 * the remaining budget on resolution.
	 */
	private readonly _turnTimers = new Map<string, { pause(): void; resume(): void; clear(): void }>();
	/** Polls a live foreign owner or retries transient durable-mail I/O. */
	private readonly _foreignOwnerTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Retry for startup reconciliation interrupted by transient durable-state I/O. */
	private _startupRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
	/** While true, no normal operation/turn may invalidate fresh-start assumptions. */
	private _startupRecoveryBlocked = false;
	/** This runtime instance's identity for the M4 run-ownership marker. */
	private readonly _runtimeId = `rt_${process.pid}_${randomBytes(4).toString("hex")}`;
	/** dispose() flips this: no new turn ever starts on a disposed runtime. */
	private _disposed = false;
	/** Final fence: timed-out old turns may no longer publish any shared state. */
	private _disposeComplete = false;
	private _disposeOperation: Promise<void> | undefined;
	/**
	 * Live project-trust getter (Finding 7); undefined = trusted. Read at every
	 * type resolution so an untrusted project never loads project-local types.
	 */
	private _isProjectTrusted: (() => boolean) | undefined;
	/**
	 * Addresses whose retire() is IN FLIGHT (Finding 13 per-address lifecycle
	 * lock): while an address is here the agent is treated as not-live
	 * (_agentLive returns false) so a racing _mailTurn/handle-build stands down,
	 * and the dir is archived BEFORE the registry/team scrub so a crash can't
	 * resurrect its memory.
	 */
	private readonly _retiring = new Set<string>();
	/** One retirement transaction per address; concurrent callers share it. */
	private readonly _retireOperations = new Map<string, Promise<RetireResult>>();
	/** Re-entrant in-process layer over the cross-process lifecycle file lock. */
	private _lifecycleLockDepth = 0;

	constructor(options: InProcessRuntimeOptions) {
		this._layout = options.layout;
		this._modelRegistry = options.modelRegistry;
		this._settingsManager = options.settingsManager;
		this._authStorage = options.authStorage;
		this._scheduler = new Scheduler(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
		this._autonomy = options.autonomy;
		this._persistentHost = options.persistentHost ?? true;
		this._disposeTimeoutMs = options.disposeTimeoutMs ?? DISPOSE_CHAIN_TIMEOUT_MS;
		if (!Number.isFinite(this._disposeTimeoutMs) || this._disposeTimeoutMs < 1) {
			throw new Error("disposeTimeoutMs must be a positive finite number.");
		}
		this._deliverer = new Deliverer({
			layout: options.layout,
			withDeliveryLock: (run) => this._withLifecycleLock(run),
			// Phase 4 guards: D12 shared-team check (stamps envelope.team; live
			// teams.json reads) and the D21 maxHops cap with its main escape.
			teamGuard: makeTeamGuard(() => readTeams(this._layout.teamsFile)),
			hopsGuard: makeHopsGuard(options.maxHops ?? DEFAULT_MAX_HOPS),
			recipientState: (address) =>
				this._retiring.has(address) || this._handles.get(address)?.retireAfterTurn === true
					? undefined
					: getAgent(readRegistry(this._layout.registryFile), address)?.state,
			senderGenerationId: (address) => getAgent(readRegistry(this._layout.registryFile), address)?.generationId,
			wake: (address) => this._scheduleMailTurn(address),
			...(options.onMainMail ? { onMainMail: options.onMainMail } : {}),
			onEnvelope: (envelope) => {
				this._emit({
					type: "envelope-sent",
					from: envelope.from,
					to: envelope.to,
					envelopeId: envelope.id,
					envelopeType: envelope.type,
					correlationId: envelope.correlationId,
				});
				// An uncorrelated peer message is a delegated task. Give it the
				// same exact final-report correlation and generation fence as a
				// main-originated assignment so the host completion barrier can
				// follow delegation transitively.
				if (
					envelope.type === "message" &&
					envelope.correlationId === null &&
					envelope.from !== MAIN_ADDRESS &&
					envelope.from !== USER_ADDRESS &&
					envelope.to !== MAIN_ADDRESS
				) {
					const record = getAgent(readRegistry(this._layout.registryFile), envelope.to);
					if (record) {
						recordAwaitAnchor(this._layout.mainMailboxDir, envelope.id, envelope.to, record.generationId);
						this._recordAssignmentAnchor(envelope.to, envelope.id);
					}
				}
			},
			onBounce: (failed, _bounce, reason) =>
				this._emit({ type: "bounce", from: failed.from, to: failed.to, envelopeId: failed.id, reason }),
		});
		this._ceilings = options.ceilings ?? {};
		this._isProjectTrusted = options.isProjectTrusted;
		// The D10 human gate (Phase 5): pending records under
		// .main/escalations/, escalation mail to main, waiting-state + slot
		// hand-off around the paused tool call.
		this._escalations = new EscalationManager({
			escalationsDir: this._layout.escalationsDir,
			escalationFile: (id) => this._layout.escalationFile(id),
			notifyMain: (record) => {
				const outcome = this._deliverer.send({
					from: record.agent,
					to: MAIN_ADDRESS,
					type: "escalation",
					text: escalationMailText(record),
					data: { escalationId: record.id },
				});
				return outcome.disposition === "bounced" ? null : outcome.envelope.id;
			},
			onObsoleteNotification: (record) => this._settleEscalationMail([record]),
			onWaiting: (agent) => {
				this._setState(agent, "waiting", this._handles.get(agent)?.generationId);
				// Release the turn's slot while the human decides (see _slots),
				// and pause the maxTurnMinutes wall clock (m4/D22: `waiting` may
				// last forever — human deliberation must not burn turn budget).
				this._slots.get(agent)?.release();
				this._turnTimers.get(agent)?.pause();
			},
			onResolved: async (agent) => {
				const slot = this._slots.get(agent);
				if (!slot) return; // turn already unwound (interrupt/retire/timer)
				const generationId = this._handles.get(agent)?.generationId;
				const release = await this._scheduler.acquire();
				// M1: while we waited for a slot the turn may have been unwound —
				// its finally deleted the _slots entry (and no-op-released). Do
				// NOT leak the fresh slot or stamp `running` on a turnless agent.
				if (this._slots.get(agent) !== slot) {
					release();
					return;
				}
				if (!this._setState(agent, "running", generationId)) {
					release();
					return;
				}
				slot.release = release;
				this._turnTimers.get(agent)?.resume();
			},
			emit: (event) => this._emit(event),
		});
		// A crash after a final report reaches main but before its assignment
		// state is promoted must not make the next task inherit the old anchor.
		// Reconcile exact durable final evidence before any startup turn runs.
		this._reconcileAssignmentAnchors();
		// C2: reconcile stale lifecycle state from a previous process life. A
		// crash (or a quit that lost the race with an in-flight turn) can leave
		// registry records `running`/`queued`/`waiting` — states the Deliverer
		// routes as held/queued, waiting for an end-of-turn drain that no longer
		// exists, stranding all future mail. Runtime CONSTRUCTION is the single
		// reconciliation point (every fresh Pi session builds a fresh runtime;
		// core/session_start both funnel here): reset every non-dormant record
		// to dormant and schedule a digest turn for every mailbox with pending
		// envelopes. Agents run-owned by another LIVE process (M4 marker) are
		// left alone — they are not stale, they are someone else's.
		this._reconcileStartupState();
	}

	// -----------------------------------------------------------------------
	// Escalation resolution surface (core → Phase 6 modal; D10)
	// -----------------------------------------------------------------------

	/**
	 * Set/replace the live project-trust getter (Finding 7). index.ts calls this
	 * post-construction — the core facade builds the runtime without a trust
	 * source (see the coordination note in the fix report), so the host wires
	 * ctx.isProjectTrusted here. A getter keeps trust live across the session.
	 */
	setProjectTrust(getter: () => boolean): void {
		this._isProjectTrusted = getter;
	}

	pendingEscalations(): EscalationRecord[] {
		return this._escalations.pending();
	}

	private _assertStartupRecoveryComplete(): void {
		if (this._startupRecoveryBlocked) {
			throw new Error("Subagent startup recovery is still retrying durable state; try again shortly.");
		}
	}

	/** HUMAN-only (D10) — never expose to the main agent's tool surface. */
	approveEscalation(id: string): boolean {
		this._assertStartupRecoveryComplete();
		return this._escalations.approve(id);
	}

	denyEscalation(id: string, note?: string): boolean {
		this._assertStartupRecoveryComplete();
		return note === undefined ? this._escalations.deny(id) : this._escalations.deny(id, note);
	}

	// -----------------------------------------------------------------------
	// spawn
	// -----------------------------------------------------------------------

	async spawn(options: SpawnOptions): Promise<SpawnResult> {
		if (this._disposed) throw new Error("This subagent runtime is disposed; reload or resume the host session.");
		this._assertStartupRecoveryComplete();
		const lifetime = options.lifetime ?? "persistent";
		if (!this._persistentHost && lifetime === "persistent") {
			throw new Error("Persistent subagents require a persisted main Pi session; use lifetime:\"oneshot\" here.");
		}

		// D20 lifetime rule: named = persistent, anonymous = disposable.
		if (lifetime === "oneshot" && options.id !== undefined) {
			throw new Error(
				`Oneshots never take an explicit id (got "${options.id}") — ` +
					"named = persistent, anonymous = disposable. Omit id for a oneshot, " +
					"or spawn persistent to name the agent.",
			);
		}
		let id: string;
		if (lifetime === "oneshot") {
			const registry = readRegistry(this._layout.registryFile);
			do {
				id = oneshotId();
			} while (
				getAgent(registry, formatAgentAddress(options.type, id)) !== undefined ||
				existsSync(this._layout.archiveDir(options.type, id))
			);
		} else {
			id = options.id ?? DEFAULT_PERSISTENT_ID;
		}
		if (!isValidTypeSegment(options.type) || !isValidIdSegment(id)) {
			throw new Error(
				`Invalid address "${options.type}/${id}": segments must be alphanumeric with ._- ` +
					'and the type must not be the reserved name "main"/"user".',
			);
		}
		const address = formatAgentAddress(options.type, id);

		// Live-resolve the type (D6) — project wins, hash recorded below.
		const { discovered, def } = this._resolveType(options.type);

		// Serialize the cross-file identity transaction with retire/spawn in other
		// Pi processes. The per-file locks preserve independent state updates;
		// this lifecycle lock keeps registry + teams + instance-dir coherent.
		const { record, created } = this._withLifecycleLock(() => {
			const result = updateRegistry(this._layout.registryFile, (registry) => {
				const existing = getAgent(registry, address);
				if (existing && existing.lifetime !== lifetime) {
					throw new Error(
						`Cannot spawn ${address} as ${lifetime}: that address belongs to an active ${existing.lifetime} agent.`,
					);
				}
				const upserted = upsertAgent(registry, {
					type: options.type,
					id,
					lifetime,
					purview: id,
					typeFileHash: discovered.hash,
					state: "dormant",
				});
				if (!upserted.created) {
					upserted.record.typeFileHash = discovered.hash;
					upserted.record.updatedAt = new Date().toISOString();
				}
				return upserted;
			});
			if (options.team !== undefined) {
				updateTeams(this._layout.teamsFile, (teams) => addTo(teams, options.team!, address));
			}
			mkdirSync(this._layout.filesDir(options.type, id), { recursive: true });
			return result;
		});

		await this._ensureHandle(address, record, discovered, def, options.inherit);
		if (this._disposed) throw new Error("This subagent runtime was disposed while the agent was being spawned.");

		let taskEnvelopeId: string | undefined;
		const task = options.task;
		if (task !== undefined) {
			// The task is mail like everything else (D18 layer 6): an envelope
			// from main that wakes the agent into a digest turn, asynchronously
			// under the scheduler cap (D13).
			const outcome = this._withLifecycleLock(() => {
				const delivered = this._deliverer.send({
					from: MAIN_ADDRESS,
					to: address,
					type: "message",
					text: task,
				});
				if (delivered.disposition !== "bounced") {
					this._recordAssignmentAnchor(address, delivered.envelope.id);
				}
				return delivered;
			});
			if (outcome.disposition === "bounced") {
				throw new Error(outcome.bounceReason ?? `Agent ${address} retired while its task was being assigned.`);
			}
			taskEnvelopeId = outcome.envelope.id;
		}

		const after = getAgent(readRegistry(this._layout.registryFile), address);
		return {
			address,
			created,
			state: after?.state ?? "dormant",
			vitals: after?.vitals ?? emptyVitals(),
			...(taskEnvelopeId !== undefined ? { taskEnvelopeId } : {}),
		};
	}

	// -----------------------------------------------------------------------
	// send / sendAsUser / collect / steer / interrupt / retire
	// -----------------------------------------------------------------------

	async send(options: SendOptions): Promise<SendResult> {
		if (this._disposed) throw new Error("This subagent runtime is disposed; reload or resume the host session.");
		this._assertStartupRecoveryComplete();
		const record = this._requireRecord(options.to);
		// Main's ONE escalation power (01-power-matrix): a send correlated to a
		// pending escalation's envelope DENIES it, the text becoming the deny
		// note. Approval can never ride this path. The mail still delivers
		// normally below (the agent sees main's reasoning in its next digest).
		if (options.correlationId !== undefined) {
			this._escalations.denyByEnvelope(options.correlationId, options.text);
		}
		const outcome = this._withLifecycleLock(() => {
			const delivered = this._deliverer.send({
				from: MAIN_ADDRESS,
				to: options.to,
				// Answering a question envelope = answer type (03-tool-surface).
				type: options.correlationId !== undefined ? "answer" : "message",
				text: options.text,
				...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
				...(options.when !== undefined ? { when: options.when } : {}),
			});
			if (options.correlationId === undefined && delivered.disposition !== "bounced") {
				this._recordAssignmentAnchor(options.to, delivered.envelope.id);
			}
			return delivered;
		});
		return this._toSendResult(outcome, record.state);
	}

	async sendAsUser(options: SendOptions): Promise<SendResult> {
		if (this._disposed) throw new Error("This subagent runtime is disposed; reload or resume the host session.");
		this._assertStartupRecoveryComplete();
		const record = this._requireRecord(options.to);
		// A message typed into the subagent viewer is genuine user input: open a
		// fresh warning-accounting window. Ordinary main-agent tool sends do not
		// reset the session counters.
		this._autonomy?.reset();
		const outcome = this._withLifecycleLock(() => {
			const delivered = this._deliverer.send({
				from: USER_ADDRESS,
				to: options.to,
				type: options.correlationId !== undefined ? "answer" : "message",
				text: options.text,
				...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
				...(options.when !== undefined ? { when: options.when } : {}),
			});
			if (options.correlationId === undefined && delivered.disposition !== "bounced") {
				this._recordAssignmentAnchor(options.to, delivered.envelope.id);
			}
			return delivered;
		});
		// D17 transparency: a quiet FYI report to main — user↔subagent traffic
		// is never secret (plain report → no auto-wake per D16).
		this._deliverer.send({
			from: USER_ADDRESS,
			to: MAIN_ADDRESS,
			type: "report",
			text: `FYI: the user messaged \`${options.to}\` directly:\n${options.text}`,
		});
		return this._toSendResult(outcome, record.state);
	}

	async collect(to: string, schema: unknown): Promise<CollectResult> {
		if (this._disposed) throw new Error("This subagent runtime is disposed; reload or resume the host session.");
		this._assertStartupRecoveryComplete();
		const record = this._requireRecord(to);
		if (typeof schema !== "object" || schema === null) {
			throw new Error("collect schema must be a JSON schema object.");
		}
		const outcome = this._deliverer.send({
			from: MAIN_ADDRESS,
			to,
			type: "message",
			text:
				"Collect request: when your result is ready, deliver it with the `report` tool — " +
				"set `data` to a value conforming to the JSON schema below, and set `correlationId` " +
				"to THIS message's envelope id (shown in your digest).\n" +
				`Schema:\n${JSON.stringify(schema, null, 2)}`,
			data: { collectSchema: schema },
			collectSchema: schema,
		});
		if (outcome.disposition === "bounced") {
			throw new Error(outcome.bounceReason ?? "collect request bounced");
		}
		recordAwaitAnchor(this._layout.mainMailboxDir, outcome.envelope.id, to, record.generationId);
		return { requested: true, requestId: outcome.envelope.id, recipientState: record.state };
	}

	async steer(to: string, text: string): Promise<SteerResult> {
		this._assertStartupRecoveryComplete();
		const handle = this._handles.get(to);
		if (!handle || !handle.session.isStreaming) return { steered: false };
		await handle.session.steer(text);
		return { steered: true };
	}

	async interrupt(to: string, expectedTurnId?: string): Promise<InterruptResult> {
		this._assertStartupRecoveryComplete();
		const handle = this._handles.get(to);
		if (
			!handle ||
			!handle.session.isStreaming ||
			(expectedTurnId !== undefined && handle.turnId !== expectedTurnId)
		) return { interrupted: false };
		const taskAnchorIds = this._taskAnchorIdsFor(to, handle.trigger ?? []);
		handle.abortedBy = "interrupt"; // not a crash — no error envelope
		await handle.session.abort();
		return { interrupted: true, taskAnchorIds };
	}

	async retire(to: string): Promise<RetireResult> {
		this._assertStartupRecoveryComplete();
		const existing = this._retireOperations.get(to);
		if (existing) return existing;
		if (this._disposed) throw new Error("This subagent runtime is disposed; reload or resume the host session.");
		return this._startRetire(to, false);
	}

	private _startRetire(to: string, fromCurrentTurn: boolean): Promise<RetireResult> {
		const existing = this._retireOperations.get(to);
		if (existing) return existing;
		if (this._disposed) return Promise.reject(new Error("This subagent runtime is disposed."));
		const operation = this._retire(to, fromCurrentTurn);
		this._retireOperations.set(to, operation);
		const cleanup = (): void => {
			if (this._retireOperations.get(to) === operation) this._retireOperations.delete(to);
		};
		void operation.then(cleanup, cleanup);
		return operation;
	}

	private async _retire(to: string, fromCurrentTurn: boolean): Promise<RetireResult> {
		const initialRecord = this._requireRecord(to);
		// Capture every active escalation before aborting the AgentSession: abort
		// removes its manager entry synchronously, but its main-mail envelope must
		// still be settled or restart reconciliation can resurrect a stale prompt.
		const obsoleteEscalationMail = this._escalations
			.active(to)
			.flatMap((record) => record.envelopeId === null ? [] : [record.envelopeId]);
		// Finding 13: per-address lifecycle lock. From here the agent counts as
		// not-live (_agentLive) so a concurrent _mailTurn / handle-build stands
		// down and never recreates session state under the dir we are moving.
		this._retiring.add(to);
		try {
			const initialHandle = this._handles.get(to);
			if (initialHandle?.session.isStreaming) {
				initialHandle.abortedBy = "interrupt";
				await initialHandle.session.abort();
				if (this._disposeComplete) {
					throw new Error(`Runtime was disposed before retirement of ${to} could complete.`);
				}
			}
			// Defensive: the abort's signal already cancels a paused escalation;
			// sweep anything left so no promise pends for a dead agent. Pending or
			// host-parked escalation mail is obsolete once the record is cancelled.
			this._escalations.cancelFor(to, `Agent ${to} was retired while the escalation was pending.`);
			cancelHostDelivery(this._layout.mainMailboxDir, obsoleteEscalationMail);
			if (!fromCurrentTurn) {
				// Do not publish address reuse while an old generation can still build a
				// handle or finish a queued/running turn. Maps are indexes, not owners:
				// deleting an entry does not cancel its promise, so actually drain them.
				for (;;) {
					const chain = this._chains.get(to);
					const build = this._handleLocks.get(to);
					const work = [...new Set([chain, build].filter((item): item is Promise<unknown> => item !== undefined))];
					if (work.length === 0) break;
					await Promise.allSettled(work);
					if (this._disposeComplete) {
						throw new Error(`Runtime was disposed before retirement of ${to} could complete.`);
					}
					// Safe only AFTER settlement: map deletion is now cleanup rather than
					// the mistaken cancellation the old retirement path relied upon.
					if (chain && this._chains.get(to) === chain) this._chains.delete(to);
					if (build && this._handleLocks.get(to) === build) this._handleLocks.delete(to);
				}
			}
			if (this._disposeComplete) {
				throw new Error(`Runtime was disposed before retirement of ${to} could complete.`);
			}
			const settledHandle = this._handles.get(to);
			const priorRetireIntent = this._readRetireIntent(initialRecord);
			const retirementEvidenceId =
				settledHandle?.retirementEvidenceId ?? priorRetireIntent?.evidenceEnvelopeId ?? null;
			settledHandle?.session.dispose();
			this._handles.delete(to);
			this._chains.delete(to);
			// M5: bounce every UNPROCESSED envelope back to its sender before the
			// mailbox is archived. Senders were told delivery succeeded (held/
			// queued) — burying their mail in .archive/ would strand an asker in
			// dormant forever (D13's "funeral loses nothing" covers OUTBOUND
			// reports; inbound pending mail needs the bounce). Runs BEFORE the
			// archive move AND the teams scrub so peer error envelopes still pass
			// the guards.
			const archiveDir = this._withLifecycleLock(() => {
				const liveRecord = getAgent(readRegistry(this._layout.registryFile), to);
				if (!liveRecord) throw new Error(`No subagent at "${to}" — it was retired concurrently.`);
				if (liveRecord.generationId !== initialRecord.generationId) {
					throw new Error(`Agent ${to} was recreated while retirement of its prior generation was in flight.`);
				}
				const foreignOwner = this._foreignRunOwner(liveRecord.type, liveRecord.id, liveRecord.generationId);
				if (foreignOwner !== null) {
					throw new Error(`Cannot retire ${to}: it is run-owned by live Pi process ${foreignOwner.pid}.`);
				}
				atomicWriteJson(this._layout.retireRequestedFile(liveRecord.type, liveRecord.id), {
					kind: fromCurrentTurn ? "oneshot-auto" : "manual",
					requestedAt: new Date().toISOString(),
					...(fromCurrentTurn && retirementEvidenceId !== null ? { evidenceEnvelopeId: retirementEvidenceId } : {}),
					...(fromCurrentTurn && priorRetireIntent?.source ? { source: priorRetireIntent.source } : {}),
					...(fromCurrentTurn && priorRetireIntent?.evidenceText ? { evidenceText: priorRetireIntent.evidenceText } : {}),
				});
				this._bouncePendingMail(to, liveRecord, /*quietOwnerMail*/ !fromCurrentTurn);
				// Durable intent + tombstone + archive precede roster scrub, so a crash cannot leave
				// deregistered live memory. Startup reconciliation finishes a partial
				// funeral; the lifecycle lock excludes a concurrent same-address spawn.
				const archived = archiveAgentDir(this._layout, liveRecord.type, liveRecord.id);
				// Registry removal publishes the address as reusable, so it is the
				// LAST durable step. A crash before it leaves the record discoverable
				// for startup recovery; a crash after it cannot leave memory or teams.
				updateTeams(this._layout.teamsFile, (teams) => scrubAddress(teams, to));
				updateRegistry(this._layout.registryFile, (registry) => removeAgent(registry, to));
				return archived;
			});
			this._emit({ type: "agent-retired", address: to, archiveDir });
			return { retired: true, archiveDir };
		} finally {
			this._retiring.delete(to);
		}
	}

	// -----------------------------------------------------------------------
	// status / peek
	// -----------------------------------------------------------------------

	async status(): Promise<RosterEntry[]> {
		const registry = readRegistry(this._layout.registryFile);
		const teams = readTeams(this._layout.teamsFile);
		return listAgents(registry).map((record) => this._toRosterEntry(record, teams));
	}

	async peek(address: string, tail = 20): Promise<AgentDetail | null> {
		const registry = readRegistry(this._layout.registryFile);
		const record = getAgent(registry, address);
		if (!record) return null;
		const teams = readTeams(this._layout.teamsFile);
		const sessionFile =
			this._handles.get(address)?.session.sessionFile ??
			this._latestSessionFile(record.type, record.id);
		return {
			...this._toRosterEntry(record, teams),
			typeFileHash: record.typeFileHash,
			createdAt: record.createdAt,
			sessionFile: sessionFile ?? null,
			outstandingQuestions: readOutstandingQuestions(this._layout.mailboxDir(record.type, record.id)),
			tail: sessionFile ? readTranscriptTail(sessionFile, tail) : [],
		};
	}

	onEvent(listener: RuntimeEventListener): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	dispose(): Promise<void> {
		if (this._disposeOperation) return this._disposeOperation;
		const operation = this._dispose();
		this._disposeOperation = operation;
		return operation;
	}

	private async _dispose(): Promise<void> {
		if (this._disposeComplete) return;
		const obsoleteEscalationMail = new Set<string>();
		const shutdownGenerations = new Map<string, string>();
		const rememberGeneration = (address: string, generationId?: string): void => {
			if (shutdownGenerations.has(address)) return;
			let generation = generationId ?? this._handles.get(address)?.generationId;
			if (generation === undefined) {
				try { generation = getAgent(readRegistry(this._layout.registryFile), address)?.generationId; } catch { /* retry in final scan */ }
			}
			if (generation !== undefined) shutdownGenerations.set(address, generation);
		};
		const captureActiveEscalations = (): EscalationRecord[] => {
			const active = this._escalations.active();
			for (const record of active) {
				rememberGeneration(record.agent);
				if (record.envelopeId !== null) obsoleteEscalationMail.add(record.envelopeId);
			}
			return active;
		};
		this._disposed = true; // no new turns/builds from this point
		for (const address of [...this._handles.keys(), ...this._chains.keys(), ...this._handleLocks.keys()]) {
			rememberGeneration(address);
		}
		const disposeDeadline = Date.now() + this._disposeTimeoutMs;
		const settleRemaining = (promises: Promise<unknown>[]): Promise<void> =>
			settleWithin(promises, Math.max(0, disposeDeadline - Date.now()));
		try {
			captureActiveEscalations();
			const aborts: Promise<unknown>[] = [];
			for (const handle of this._handles.values()) {
				const beforeAbort = captureActiveEscalations();
				if (handle.session.isStreaming) {
					handle.abortedBy = "interrupt"; // shutdown, not a crash — no error mail
					aborts.push(handle.session.abort().catch(() => {}));
				}
				for (const record of beforeAbort) {
					if (record.envelopeId !== null) obsoleteEscalationMail.add(record.envelopeId);
				}
			}
			await settleRemaining(aborts);
			const remainingEscalations = captureActiveEscalations();
			for (const address of new Set(remainingEscalations.map((record) => record.agent))) {
				this._escalations.cancelFor(address, "Host session shut down while the escalation was pending.");
			}
			cancelHostDelivery(this._layout.mainMailboxDir, [...obsoleteEscalationMail]);
			// Wake queued acquirers into their disposed check; releases are idempotent.
			for (const slot of this._slots.values()) slot.release();
			// Bound every async class by ONE shutdown deadline. Retirements re-check
			// `_disposed` after every await and before their destructive phase;
			// handle builders do the same before publication. Thus a provider that
			// ignores abort cannot retain the host lease forever or mutate a scope
			// after a replacement host opens it.
			await settleRemaining([...this._retireOperations.values()]);
			await settleRemaining([...this._handleLocks.values()]);
			await settleRemaining([...this._chains.values()]);
			// This is the publication fence for any operation that outlived the
			// bounded waits. Set it before cleanup and before the host lease can be
			// released; late retire/model continuations must observe it.
			this._disposeComplete = true;
		} finally {
			// Also fence on exceptional shutdown paths before any lease-releasing
			// cleanup runs.
			this._disposeComplete = true;
			for (const address of [...this._handles.keys(), ...this._chains.keys(), ...this._handleLocks.keys()]) {
				rememberGeneration(address);
			}
			for (const handle of this._handles.values()) {
				try {
					handle.session.dispose();
				} catch {
					// The final shared-state fence below still prevents late publication.
				}
			}
			// Publish clean dormant state before the host lease can be released.
			try {
				this._withLifecycleLock(() => updateRegistry(this._layout.registryFile, (registry) => {
					for (const [address, generationId] of shutdownGenerations) {
						const record = getAgent(registry, address);
						if (
							!record || record.generationId !== generationId ||
							this._foreignRunOwner(record.type, record.id, generationId) !== null
						) continue;
						record.state = "dormant";
						record.updatedAt = new Date().toISOString();
					}
				}));
			} catch {
				// Startup reconciliation is the durable backstop.
			}
			this._disposeComplete = true;
			this._handles.clear();
			this._chains.clear();
			this._handleLocks.clear();
			this._retireOperations.clear();
			this._slots.clear();
			for (const timer of this._turnTimers.values()) timer.clear();
			this._turnTimers.clear();
			for (const timer of this._foreignOwnerTimers.values()) clearTimeout(timer);
			this._foreignOwnerTimers.clear();
			if (this._startupRecoveryTimer !== undefined) clearTimeout(this._startupRecoveryTimer);
			this._startupRecoveryTimer = undefined;
			this._startupRecoveryBlocked = false;
			this._listeners.clear();
		}
	}

	// -----------------------------------------------------------------------
	// Mail turns (Phase 3 core)
	// -----------------------------------------------------------------------

	/**
	 * Map a delivery outcome onto the tool-facing SendResult shape. The
	 * Deliverer's disposition is surfaced verbatim so callers can tell
	 * "queued because the recipient is mid-turn" (held) from "queued because a
	 * turn is already scheduled" (queued); delivery:"delivered" pairs with
	 * recipientState:"queued" by design — the wake just SCHEDULED the turn.
	 */
	private _toSendResult(outcome: DeliveryOutcome, stateBefore: AgentState): SendResult {
		if (outcome.disposition === "bounced" || outcome.disposition === "main") {
			// Unreachable for main/user sends in v1 (unknown addresses throw
			// earlier; "main" never routes through this path) — defensive.
			throw new Error(outcome.bounceReason ?? "message bounced");
		}
		const delivered = outcome.disposition === "woken";
		return {
			delivery: delivered ? "delivered" : "queued",
			disposition: outcome.disposition,
			recipientState: delivered ? "queued" : (outcome.recipientState ?? stateBefore),
			envelopeId: outcome.envelope.id,
		};
	}

	/**
	 * Queue a mailbox-consuming turn for an agent, serialized per address (an
	 * agent processes its mailbox one turn at a time; agents parallelize
	 * across, never within, an identity). Extra schedules are cheap: a turn
	 * that finds an empty mailbox is a no-op.
	 */
	private _scheduleMailTurn(address: string, expectedGenerationId?: string): void {
		if (this._disposed || this._startupRecoveryBlocked) return;
		let generationId = expectedGenerationId;
		if (generationId === undefined) {
			generationId = getAgent(readRegistry(this._layout.registryFile), address)?.generationId;
		}
		if (generationId === undefined || !this._setState(address, "queued", generationId)) return;
		const prev = this._chains.get(address) ?? Promise.resolve();
		// C1 hardening: hop through a REAL timer before each turn. Every await
		// in a no-op turn (mock providers, empty mailboxes, early bails) can
		// resolve synchronously, so chained reschedules would otherwise be a
		// pure-microtask loop that starves the host event loop. The macrotask
		// hop guarantees any reschedule path yields to timers/IO.
		const next = prev
			.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
			.then(() => this._mailTurn(address, generationId))
			.catch(() => {});
		this._chains.set(address, next);
	}

	/**
	 * A prior runtime may release the host lease while an abort-ignoring model
	 * call still owns this identity. Keep the marker (concurrent transcript
	 * writes are unsafe), but poll it so queued mail resumes automatically the
	 * moment that old turn's finally block clears its exact runtimeId. The same
	 * retry path handles transient registry/mailbox I/O without treating it as
	 * an empty durable queue.
	 */
	private _waitForForeignOwner(address: string, observedGenerationId?: string): void {
		if (this._disposed || this._foreignOwnerTimers.has(address)) return;
		let generationId = observedGenerationId;
		if (generationId === undefined) {
			try {
				generationId = getAgent(readRegistry(this._layout.registryFile), address)?.generationId;
			} catch {
				// Timer body retries the durable read.
			}
		}
		const timer = setTimeout(() => {
			this._foreignOwnerTimers.delete(address);
			if (this._disposed) return;
			try {
				const record = getAgent(readRegistry(this._layout.registryFile), address);
				if (generationId === undefined) {
					if (record) this._waitForForeignOwner(address, record.generationId);
					return;
				}
				if (record && record.generationId !== generationId) {
					// The observed incarnation was fully retired/replaced. Never apply
					// its delayed recovery to the replacement. If the replacement itself
					// is foreign, begin a new generation-scoped watch.
					if (this._foreignRunOwner(record.type, record.id, record.generationId) !== null) {
						this._waitForForeignOwner(address, record.generationId);
					}
					return;
				}
				if (record && this._foreignRunOwner(record.type, record.id, record.generationId) !== null) {
					this._waitForForeignOwner(address, generationId);
					return;
				}
				// The former owner may have died while waiting on an escalation or
				// midway through a funeral. Reconcile THIS incarnation only.
				const handoff = this._reconcileReleasedForeignOwner(address, generationId);
				if (handoff === "retry") {
					this._waitForForeignOwner(address, generationId);
					return;
				}
				// Targeted recovery also made any pending-mail schedule while still
				// holding the lifecycle lock; nothing generation-sensitive remains.
			} catch {
				// Registry/mailbox paths can move under a foreign retirement. Retry
				// from durable state rather than letting a timer exception kill Pi.
				this._waitForForeignOwner(address, generationId);
			}
		}, 250);
		timer.unref?.();
		this._foreignOwnerTimers.set(address, timer);
	}

	/** Targeted handoff recovery after a startup-skipped foreign owner vanishes. */
	private _reconcileReleasedForeignOwner(
		address: string,
		expectedGenerationId: string,
	): "reconciled" | "locally-owned" | "superseded" | "retry" {
		try {
			let outcome: "reconciled" | "locally-owned" | "superseded" | "retry" = "reconciled";
			this._withLifecycleLock(() => {
				const record = getAgent(readRegistry(this._layout.registryFile), address);
				if (record) {
					if (record.generationId !== expectedGenerationId) {
						outcome = "superseded";
						return;
					}
					if (this._foreignRunOwner(record.type, record.id, record.generationId) !== null) {
						throw new Error("foreign owner is still live");
					}
					// ABA fence: since the poll observed the old owner, this runtime may
					// already have received new mail and claimed the address. Claims share
					// this lifecycle lock, so an exact own marker here is authoritative —
					// never clear/reset it or cancel its newly-live escalations.
					if (this._runOwnerIsOurs(record.type, record.id, record.generationId)) {
						outcome = "locally-owned";
						return;
					}
					this._clearRunOwner(record.type, record.id, /*force*/ true, record.generationId);
					const instanceDir = this._layout.agentInstanceDir(record.type, record.id);
					if (
						!existsSync(instanceDir) ||
						hasRetirementTombstone(instanceDir) ||
						this._retireIntentReady(record)
					) {
						this._bouncePendingMail(address, record, this._retireIntentKind(record) !== "oneshot-auto");
						archiveAgentDir(this._layout, record.type, record.id);
						updateTeams(this._layout.teamsFile, (teams) => scrubAddress(teams, address));
						updateRegistry(this._layout.registryFile, (registry) => removeAgent(registry, address));
					} else {
						updateRegistry(this._layout.registryFile, (registry) => {
							const current = getAgent(registry, address);
							if (current) {
								current.state = "dormant";
								current.updatedAt = new Date().toISOString();
							}
						});
					}
				}

				// Keep orphan cancellation and the post-recovery wake decision inside
				// the SAME generation lock. A successor cannot claim/raise a live
				// escalation in the gap, nor can we stamp queued over its running state.
				if (this._cancelOrphanedEscalationRecords(new Set(), address)) {
					outcome = "retry";
					return;
				}
				const current = getAgent(readRegistry(this._layout.registryFile), address);
				if (current && pendingCount(this._layout.mailboxDir(current.type, current.id)) > 0) {
					this._scheduleMailTurn(address);
				}
			});
			return outcome;
		} catch {
			return "retry";
		}
	}

	/** Retry startup reconciliation after transient durable-state I/O. */
	private _scheduleStartupRecoveryRetry(): void {
		if (this._disposed) return;
		this._startupRecoveryBlocked = true;
		if (this._startupRecoveryTimer !== undefined) return;
		this._startupRecoveryTimer = setTimeout(() => {
			this._startupRecoveryTimer = undefined;
			if (!this._disposed) this._reconcileStartupState();
		}, 250);
		this._startupRecoveryTimer.unref?.();
	}


	/**
	 * C2 startup reconciliation (see constructor). Best-effort: reconciliation
	 * must never break runtime construction.
	 */
	private _reconcileStartupState(): void {
		try {
			if (!existsSync(this._layout.registryFile)) return;
			const skipForeign = new Set<string>();
			// Finding 13: complete partial funerals while the registry still
			// reserves each address. Archive + team scrub happen before registry
			// removal (the publication point), all beneath the lifecycle lock, so a
			// crash or concurrent spawn cannot resurrect/move old session memory.
			this._withLifecycleLock(() => {
				const crashedRetire: Array<{ address: string; record: AgentRecord; quietOwnerMail: boolean }> = [];
				const resetAddresses = new Set<string>();
				for (const record of listAgents(readRegistry(this._layout.registryFile))) {
					const address = formatAgentAddress(record.type, record.id);
					if (this._foreignRunOwner(record.type, record.id, record.generationId) !== null) {
						skipForeign.add(address); // live elsewhere — not ours to touch
						continue;
					}
					this._clearRunOwner(record.type, record.id, /*force*/ true, record.generationId);
					const instanceDir = this._layout.agentInstanceDir(record.type, record.id);
					if (
						!existsSync(instanceDir) ||
						hasRetirementTombstone(instanceDir) ||
						this._retireIntentReady(record)
					) {
						crashedRetire.push({
							address,
							record: { ...record, vitals: { ...record.vitals } },
							quietOwnerMail: this._retireIntentKind(record) !== "oneshot-auto",
						});
					} else if (record.state !== "dormant") {
						resetAddresses.add(address);
					}
				}
				for (const { address, record, quietOwnerMail } of crashedRetire) {
					// Bounce before the move. Both operations are idempotent when a prior
					// recovery already completed them and then crashed.
					this._bouncePendingMail(address, record, quietOwnerMail);
					archiveAgentDir(this._layout, record.type, record.id);
					updateTeams(this._layout.teamsFile, (teams) => scrubAddress(teams, address));
				}
				updateRegistry(this._layout.registryFile, (registry) => {
					for (const { address } of crashedRetire) removeAgent(registry, address);
					for (const address of resetAddresses) {
						const record = getAgent(registry, address);
						if (record) {
							record.state = "dormant";
							record.updatedAt = new Date().toISOString();
						}
					}
				});
			});
			// A fresh runtime has no in-memory escalation waits yet. Every
			// persisted pending record not owned by a live foreign run-owner is
			// therefore orphaned, including a previous recovery that crashed after
			// resetting the registry but before cancelling the record. Resolved or
			// already-cancelled records are also scanned so their obsolete host mail
			// is settled idempotently across recovery crashes.
			if (this._cancelOrphanedEscalationRecords(skipForeign)) {
				this._scheduleStartupRecoveryRetry();
			}
			// A per-record escalation write may have requested another retry without
			// throwing. Do not let normal work begin until one whole fresh-start
			// reconciliation pass has completed with no retry outstanding.
			if (this._startupRecoveryTimer !== undefined) return;
			this._startupRecoveryBlocked = false;
			for (const record of listAgents(readRegistry(this._layout.registryFile))) {
				const address = formatAgentAddress(record.type, record.id);
				try {
					// Poll every startup-skipped owner, even with no agent mailbox mail:
					// it may own a pending escalation whose prompt must be reconciled if
					// that process dies after this startup snapshot.
					if (skipForeign.has(address)) {
						this._waitForForeignOwner(address);
						continue;
					}
					if (pendingCount(this._layout.mailboxDir(record.type, record.id)) === 0) continue;
					this._scheduleMailTurn(address);
				} catch {
					this._waitForForeignOwner(address); // retry transient mailbox I/O
				}
			}
		} catch {
			// Never break construction, but also never turn one transient funeral/
			// registry/mailbox read into a permanently held scope. The recovery
			// transaction is idempotent and retries from its durable checkpoints.
			this._scheduleStartupRecoveryRetry();
		}
	}

	/** Settle escalation prompts by persisted envelope id or durable escalation id. */
	private _settleEscalationMail(records: EscalationRecord[]): void {
		const obsoleteEnvelopeIds = new Set(
			records.flatMap((record) =>
				typeof record.envelopeId === "string" && ENVELOPE_ID_RE.test(record.envelopeId)
					? [record.envelopeId]
					: [],
			),
		);
		const obsoleteEscalationIds = new Set(
			records.flatMap((record) =>
				/^esc_[0-9A-HJKMNP-TV-Z]{26}$/.test(record.id) ? [record.id] : [],
			),
		);
		cancelHostDeliveriesWhere(this._layout.mainMailboxDir, (envelope) => {
			if (obsoleteEnvelopeIds.has(envelope.id)) return true;
			if (envelope.type !== "escalation") return false;
			const data = envelope.payload.data;
			if (
				typeof data === "object" &&
				data !== null &&
				typeof (data as Record<string, unknown>).escalationId === "string" &&
				obsoleteEscalationIds.has((data as Record<string, unknown>).escalationId as string)
			) {
				return true;
			}
			const textId = /(?:^|\n)- escalation id: (esc_[0-9A-HJKMNP-TV-Z]{26})(?:\n|$)/.exec(
				envelope.payload.text,
			)?.[1];
			return textId !== undefined && obsoleteEscalationIds.has(textId);
		});
	}

	/**
	 * Startup-reconcile helper (see caller): cancel every orphaned on-disk
	 * pending escalation and settle obsolete mail for every terminal record.
	 * Best-effort per record; live foreign owners remain untouched.
	 */
	private _cancelOrphanedEscalationRecords(skipForeign: Set<string>, onlyAgent?: string): boolean {
		const dir = this._layout.escalationsDir;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error; // caller installs the appropriate retry
		}
		const obsoleteRecords: EscalationRecord[] = [];
		let retryNeeded = false;
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = join(dir, name);
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") retryNeeded = true;
				continue;
			}
			let record: EscalationRecord;
			try {
				record = JSON.parse(text) as EscalationRecord;
			} catch {
				continue; // malformed audit record; GC's mtime fallback owns it
			}
			if (onlyAgent !== undefined && record.agent !== onlyAgent) continue;
			if (skipForeign.has(record.agent)) continue;
			if (
				record.status !== "pending" &&
				record.status !== "approved" &&
				record.status !== "denied" &&
				record.status !== "cancelled"
			) continue;
			if (record.status === "pending") {
				const cancelled: EscalationRecord = {
					...record,
					status: "cancelled",
					note: "Cancelled at startup: the owning Pi process died while this escalation was pending.",
					resolvedAt: new Date().toISOString(),
				};
				try {
					atomicWriteJson(file, cancelled);
					obsoleteRecords.push(cancelled); // settle prompt only AFTER durable cancellation
				} catch {
					retryNeeded = true;
				}
			} else {
				obsoleteRecords.push(record);
			}
		}
		this._settleEscalationMail(obsoleteRecords);
		return retryNeeded;
	}

	/**
	 * One digest turn: pending mail → wake digest → REAL session turn →
	 * markDone AFTER the turn is durably appended (at-least-once). The
	 * end-of-turn drain re-schedules if mail arrived mid-turn (D11 hold), and
	 * oneshot final reports retire the agent at this boundary (D13).
	 */
	private async _mailTurn(address: string, expectedGenerationId?: string): Promise<void> {
		if (this._disposed) return; // shutdown — mail stays on disk (D7)
		const record = getAgent(readRegistry(this._layout.registryFile), address);
		if (!record || (expectedGenerationId !== undefined && record.generationId !== expectedGenerationId)) return;
		const generationId = record.generationId;

		// M4: refuse to wake an agent run-owned by another LIVE Pi process in
		// the same cwd — two live sessions appending one JSONL corrupts the
		// transcript. The mail stays on disk; the owning runtime's turn-boundary
		// drain (or the next startup reconciliation) picks it up.
		if (this._foreignRunOwner(record.type, record.id, generationId) !== null) {
			if (!this._foreignOwnerTimers.has(address)) {
				this._emit({
					type: "turn-error",
					address,
					error: `Agent is run-owned by another live Pi process — mail left queued (see ${address}'s .run-owner.json).`,
				});
			}
			this._waitForForeignOwner(address, generationId);
			return;
		}

		const mailboxDir = this._layout.mailboxDir(record.type, record.id);

		let handle: Handle;
		try {
			const { discovered, def } = this._resolveType(record.type);
			handle = await this._ensureHandle(address, record, discovered, def);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._emit({ type: "turn-error", address, error: message });
			if (!this._disposed && this._agentLive(address, generationId)) {
				this._setState(address, "dormant", generationId);
				// m3: a handle-build failure (bad type file, unknown model, …)
				// must be visible to MAIN, not only as a runtime event — the
				// agent's mail sits queued and someone must decide.
				this._sendErrorToMain(address, `Could not wake ${address}: ${message}. Its mail stays queued.`);
			}
			return;
		}
		// M3: retire may have raced the awaits above — the record we read at
		// entry is stale. Re-verify after EVERY await gap; touching disk for a
		// retired agent resurrects ghost state under the archived path.
		if (this._disposed || !this._agentLive(address, generationId)) return;

		// Limits are warning-only and never block, abort, or auto-retire.
		const ceilings = effectiveCeilings(handle.def.config, this._ceilings);

		// The turn's scheduler slot, swappable: escalations release it while
		// `waiting` and re-acquire on resolution (see _slots).
		const slot = { release: await this._scheduler.acquire() };
		if (this._disposed || !this._agentLive(address, generationId)) {
			slot.release(); // M3: retired/disposed while waiting for a slot
			return;
		}
		this._slots.set(address, slot);
		let ran = false;
		let crashed = false;
		/**
		 * Leave the triggering mail pending when a turn did not consume its
		 * digest: explicit interrupt/shutdown, transient I/O, or a lost run-owner
		 * claim. It waits for an external wake instead of looping.
		 */
		let leavePending = false;
		let tokensBefore = 0;
		let taskAnchorIds: string[] = [];
		let turnId = "";
		let turnThresholdStatus: ReturnType<AutonomyBudget["status"]> | undefined;
		let turnTimer: { pause(): void; resume(): void; clear(): void } | undefined;
		let unsubscribe: (() => void) | undefined;
		/** Final assistant stopReason error/aborted, captured off the event stream. */
		let turnFailure: { stopReason: "error" | "aborted"; errorMessage: string } | null = null;
		try {
			let pending: ReturnType<typeof readPending>;
			try {
				pending = readPending(mailboxDir);
			} catch (error) {
				leavePending = true;
				this._waitForForeignOwner(address, generationId); // retries transient durable-mail I/O
				this._emit({
					type: "turn-error",
					address,
					error: `Could not read ${address}'s durable mailbox; retrying: ${error instanceof Error ? error.message : String(error)}`,
				});
				return;
			}
			if (pending.length === 0) return; // duplicate schedule — no-op
			const ids = pending.map((p) => p.envelope.id);
			taskAnchorIds = this._taskAnchorIdsFor(address, pending.map((item) => item.envelope));

			// Finding 5: the AUTHORITATIVE, atomic run-ownership claim. The early
			// _foreignRunOwner check above is only a fast bail; THIS exclusive
			// create is the claim of record, so two processes racing from the same
			// "no live owner" observation cannot both win and append one JSONL. If
			// a live foreign process took it in the race window, stand down and
			// leave the mail pending (its owner's boundary / the next startup
			// reconciliation drains it).
			const claimed = this._withLifecycleLock(() =>
				this._agentLive(address, generationId) && this._claimRunOwner(record.type, record.id, generationId),
			);
			if (!claimed) {
				leavePending = true;
				this._emit({
					type: "turn-error",
					address,
					error: `Lost the run-ownership claim to another live Pi process — mail left queued (${address}).`,
				});
				return;
			}
			turnId = `turn_${ulid()}`;
			handle.turnId = turnId;

			// Account once the slot/run-owner are committed. Crossing an autonomy
			// threshold emits a targeted warning but never blocks this or later turns.
			if (this._autonomy?.noteTurnStart() === "turns") {
				turnThresholdStatus = this._autonomy.status();
			}

			// Roster-change lines (Phase 4, D18): diff the roster this agent
			// last saw against teams.json now; the digest reports the changes.
			// First-ever wake seeds the snapshot silently — the identity block
			// already carries the initial roster.
			const rosterFile = rosterSnapshotFileOf(mailboxDir);
			const previousRoster = readRosterSnapshot(rosterFile);
			const currentRoster = rosterViewOf(readTeams(this._layout.teamsFile), address);
			const rosterChanges = previousRoster === null ? [] : diffRosterViews(previousRoster, currentRoster);
			writeRosterSnapshot(rosterFile, currentRoster);

			// At-least-once bookkeeping: markers before the turn, .done after
			// the durable append. A crash in between re-delivers, labeled.
			beginDelivery(mailboxDir, ids);
			const digest = composeWakeDigest({
				items: pending.map((p) => ({ envelope: p.envelope, redelivered: p.redelivered })),
				questionLookup: (correlationId, from) => lookupSentQuestion(mailboxDir, correlationId, from),
				...(rosterChanges.length > 0 ? { rosterChanges } : {}),
			});

			ran = true;
			tokensBefore = handle.session.getSessionStats().tokens.total;
			handle.trigger = pending.map((p) => p.envelope);
			handle.abortedBy = null;
			if (!this._setState(address, "running", generationId)) {
				leavePending = true;
				return;
			}
			this._emit({ type: "turn-started", address });

			// maxTurnMinutes is warning-only. Human escalation time remains paused;
			// crossing the running-time threshold surfaces one warning for this turn.
			if (ceilings.maxTurnMinutes !== undefined) {
				turnTimer = makePausableTimer(ceilings.maxTurnMinutes * 60_000, () => {
					this._emit({
						type: "limit-warning",
						address,
						limit: "maxTurnMinutes",
						observed: ceilings.maxTurnMinutes!,
						threshold: ceilings.maxTurnMinutes!,
						turnId,
						taskAnchorIds,
					});
				});
				this._turnTimers.set(address, turnTimer);
			}
			// Fatal-turn detection: provider/tool failures end the turn with a
			// final assistant stopReason "error" (the SDK resolves, it does not
			// throw) — capture it off the session event stream.
			unsubscribe = handle.session.subscribe((event) => {
				if (event.type === "agent_end") {
					for (const message of event.messages) {
						const m = message as { role?: string; stopReason?: string; errorMessage?: string };
						if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
							turnFailure = { stopReason: m.stopReason, errorMessage: m.errorMessage ?? "(no error message)" };
						}
					}
				}
			});

			const prompt = handle.session.prompt(digest);
			// prompt() marks the session streaming synchronously, so warning actions
			// can fence and interrupt this exact turn rather than a later one.
			if (turnThresholdStatus) {
				this._emit({
					type: "limit-warning",
					address,
					limit: "autonomousTurns",
					observed: turnThresholdStatus.turnsUsed,
					threshold: turnThresholdStatus.turnsBudget,
					status: turnThresholdStatus,
					turnId,
					taskAnchorIds,
				});
			}
			this._warnCumulativeLimits(address, handle, ceilings, turnId, taskAnchorIds);
			await prompt;
			await handle.session.waitForIdle();

			// M3: retire may have raced the turn — its abort unwound the prompt
			// above and the mailbox has already moved to .archive/. markDone
			// here would recreate mailbox/.done under the archived path (ghost
			// state a later spawn resurrects). retire's pending-mail bounce
			// already told the senders.
			if (this._disposed || !this._agentLive(address, generationId)) {
				leavePending = true;
				return;
			}

			// Finding 1: an explicit interrupt (subagent_interrupt) or host
			// shutdown aborts the turn — session.abort() resolves prompt() with
			// stopReason "aborted", so the digest was NOT processed to completion.
			// Do NOT consume the triggering mail: leave it pending so the next
			// real wake re-delivers it (the subagent_interrupt contract: the agent
			// stays alive with its mail still pending; shutdown: the startup
			// reconciliation re-drains). leavePending also suppresses the
			// end-of-turn auto-retry — the mail waits for an EXTERNAL wake, not an
			// immediate re-run that would defeat the interrupt.
			if (handle.abortedBy === "interrupt") {
				leavePending = true;
				return;
			}

			// Fatal provider/tool errors remain terminal evidence for oneshots.
			// Warning thresholds never participate in retirement.
			const failure = turnFailure as { stopReason: "error" | "aborted"; errorMessage: string } | null;
			const fatalText =
				failure !== null && failure.stopReason === "error"
					? `Turn failed: ${failure.errorMessage}`
					: null;
			const preparedEvidenceId =
				fatalText !== null
					? this._prepareRuntimeRetirement(record, handle, fatalText)
					: undefined;

			// The receiving turn is now durably in the session JSONL.
			markDone(mailboxDir, ids);

			// A consumed answer (or error) settles the question it correlates
			// to — drop it from the sent-questions index NOW, after the digest
			// above already quoted it (D14), so the index shrinks instead of
			// growing one entry per question forever. A crash before markDone
			// re-delivers the answer and the question is still there to quote.
			deleteSentQuestions(
				mailboxDir,
				pending
					.map((p) => p.envelope)
					.filter((env) => (env.type === "answer" || env.type === "error") && typeof env.correlationId === "string")
					.map((env) => ({ correlationId: env.correlationId as string, from: env.from })),
			);

			if (fatalText !== null && failure !== null) {
				this._emit({ type: "turn-error", address, error: failure.errorMessage });
				this._sendErrorToMain(address, fatalText, preparedEvidenceId);
			} else {
				this._warnCumulativeLimits(address, handle, ceilings, turnId, taskAnchorIds);
			}
		} catch (error) {
			crashed = true;
			if (!this._disposed && this._agentLive(address, generationId)) {
				const message = error instanceof Error ? error.message : String(error);
				this._emit({ type: "turn-error", address, error: message });
				const errorText = `Turn crashed: ${message}`;
				const evidenceEnvelopeId = this._prepareRuntimeRetirement(record, handle, errorText);
				this._sendErrorToMain(address, errorText, evidenceEnvelopeId);
			}
		} finally {
			turnTimer?.clear();
			if (this._turnTimers.get(address) === turnTimer) this._turnTimers.delete(address);
			unsubscribe?.();
			handle.trigger = undefined;
			if (handle.turnId === turnId) handle.turnId = undefined;
			handle.abortedBy = null;
			this._slots.delete(address);
			slot.release();
			const liveVitals = vitalsFrom(handle.session);
			// Registry persists WHOLE-LIFE vitals (Phase 7): base + live.
			const vitals = combineVitals(handle.baseVitals, liveVitals);
			// Session-wide token accounting is warning-only.
			if (ran && !this._disposeComplete && this._autonomy) {
				const crossed = this._autonomy.noteTokens(liveVitals.tokens - tokensBefore);
				if (crossed === "tokens") {
					const status = this._autonomy.status();
					this._emit({
						type: "limit-warning",
						address,
						limit: "autonomousTokens",
						observed: status.tokensUsed,
						threshold: status.tokensBudget,
						status,
						turnId,
						taskAnchorIds,
					});
				}
			}
			// Publish dormant + inspect/schedule held mail under the SAME lifecycle
			// lock used by Deliverer._route. This closes the cross-process boundary
			// race where a sender observed `running`, then wrote just after an
			// unlocked zero-pending check and returned `held` forever.
			let live = false;
			this._withLifecycleLock(() => {
				this._clearRunOwner(record.type, record.id, false, generationId);
				live = !this._disposeComplete && this._agentLive(address, generationId);
				if (!live) {
					if (ran) this._emit({ type: "turn-finished", address, vitals });
					return;
				}
				updateRegistry(this._layout.registryFile, (registry) => {
					const current = getAgent(registry, address);
					if (current?.generationId === generationId) {
						current.state = "dormant";
						current.vitals = vitals;
						current.updatedAt = new Date().toISOString();
					}
				});
				if (ran) {
					this._emit({ type: "turn-finished", address, vitals });
					this._emit({ type: "state-changed", address, state: "dormant" });
				}
				if (handle.retireAfterTurn || crashed || leavePending || this._disposed) return;
				try {
					if (pendingCount(mailboxDir) > 0) this._scheduleMailTurn(address, generationId);
				} catch {
					this._waitForForeignOwner(address, generationId); // retry transient mailbox I/O
				}
			});
			if (live && handle.retireAfterTurn) {
				// D13: the oneshot's final report is already in main's mailbox
				// (delivered before the flag was set) — the funeral loses
				// nothing; retire() bounces any UNPROCESSED pending mail (M5).
				await this._startRetire(address, true).catch(() => {});
			}
		}
	}

	/** The outbound-mail port subagent tools run against (tools/sub-agent.ts). */
	private readonly _mailPort: SubagentMailPort = {
		sendFromAgent: async (options) => {
			if (this._disposed) {
				return { disposition: "bounced", bounceReason: "The host runtime is shutting down; no mail was sent." };
			}
			// Task reports automatically correlate to the assignment in the
			// CURRENT turn's trigger, not merely the latest message ever sent.
			// This prevents task B (arriving while A runs) from stealing A's final.
			const triggerAssignments =
				options.type === "report" && options.correlationId === undefined
					? this._reportAssignmentCandidates(options.from)
					: [];
			if (triggerAssignments.length > 1) {
				return {
					disposition: "bounced",
					bounceReason:
						"This turn contains multiple task assignments; set correlationId to the exact task message id shown in the wake digest.",
				};
			}
			const activeAssignment =
				options.type === "report" && options.correlationId === undefined
					? this._readAssignmentAnchor(options.from)
					: undefined;
			const triggerAssignment = triggerAssignments[0];
			const trigger = this._handles.get(options.from)?.trigger;
			const resumesPriorWork = (trigger ?? []).some(
				(envelope) =>
					(envelope.type === "answer" || envelope.type === "error") &&
					typeof envelope.correlationId === "string",
			);
			const assignmentCorrelation =
				options.type === "report" && options.correlationId === undefined
					// A sole task trigger is the work this wake is handling, even when
					// an older non-final assignment remains active. The exception is an
					// answer/error resume mixed with a newly queued task B: that wake is
					// resuming active task A, so B must not steal A's report.
					? (activeAssignment !== undefined && triggerAssignment !== undefined && resumesPriorWork
						? activeAssignment
						: triggerAssignment ?? activeAssignment)
					: undefined;
			const correlationId = options.correlationId ?? assignmentCorrelation;
			// Hops threading (D21): a turn caused by mail sending mail is one
			// hop deeper than the deepest trigger envelope; fresh work = 0.
			const causedBy =
				trigger && trigger.length > 0
					? trigger.reduce((a, b) => (a.hops >= b.hops ? a : b))
					: undefined;
			const outcome = this._deliverer.send({
				...(options.envelopeId !== undefined ? { envelopeId: options.envelopeId } : {}),
				from: options.from,
				to: options.to,
				type: options.type,
				text: options.text,
				...(options.data !== undefined ? { data: options.data } : {}),
				...(options.final !== undefined ? { final: options.final } : {}),
				...(correlationId !== undefined ? { correlationId } : {}),
				...(options.when !== undefined ? { when: options.when } : {}),
				...(causedBy ? { causedBy } : {}),
			});
			if (
				options.type === "report" &&
				options.final === true &&
				outcome.disposition !== "bounced"
			) {
				this._withLifecycleLock(() => this._clearAssignmentAnchor(options.from, correlationId));
			}
			return {
				disposition: outcome.disposition,
				...(outcome.bounceReason !== undefined ? { bounceReason: outcome.bounceReason } : {}),
			};
		},
		noteFinalReport: (from) => {
			if (this._disposed) return undefined;
			const record = getAgent(readRegistry(this._layout.registryFile), from);
			if (record?.lifetime !== "oneshot") return undefined;
			const handle = this._handles.get(from);
			const priorEvidence = handle?.retirementEvidenceId ?? this._readRetireIntent(record)?.evidenceEnvelopeId;
			if (handle?.retireAfterTurn || priorEvidence) {
				throw new Error("A final report was already delivered or is already in flight for this oneshot.");
			}
			const evidenceEnvelopeId = `msg_${ulid()}`;
			this._markRetireAfterTurn(record, handle, evidenceEnvelopeId, "final-report");
			return evidenceEnvelopeId;
		},
		cancelFinalReport: (from, evidenceEnvelopeId) => {
			if (this._disposed || evidenceEnvelopeId === undefined) return;
			const record = getAgent(readRegistry(this._layout.registryFile), from);
			if (record?.lifetime !== "oneshot") return;
			const handle = this._handles.get(from);
			const handleMatches = handle?.retirementEvidenceId === evidenceEnvelopeId;
			const intentMatches = this._readRetireIntent(record)?.evidenceEnvelopeId === evidenceEnvelopeId;
			if (!handleMatches && !intentMatches) return;
			if (intentMatches) rmSync(this._layout.retireRequestedFile(record.type, record.id), { force: true });
			if (handleMatches && handle) {
				handle.retireAfterTurn = false;
				delete handle.retirementEvidenceId;
			}
		},
	};

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private _resolveType(typeName: string): { discovered: DiscoveredTypeDef; def: TypeDefinition } {
		// Finding 7: gate project-local types on host project-trust. An untrusted
		// project's `<cwd>/.pi/subagents/*.md` are neither loaded nor allowed to
		// shadow a global type — global types still resolve.
		const projectTrusted = this._isProjectTrusted?.() ?? true;
		const discovered = resolveTypeDef(this._layout, typeName, { projectTrusted });
		if (!discovered) {
			throw new Error(
				`Unknown subagent type "${typeName}" — no ${typeName}.md in ` +
					(projectTrusted
						? `${this._layout.projectTypeDefsDir} or ${this._layout.globalTypeDefsDir}.`
						: `${this._layout.globalTypeDefsDir} (project types are disabled: this project is untrusted).`),
			);
		}
		// Finding 7 visibility: a project type silently overriding a trusted
		// global one is worth flagging (name + both source paths + hashes).
		if (discovered.shadowsGlobal) {
			this._emit({
				type: "turn-error",
				address: typeName,
				error:
					`Type "${typeName}" resolved from the PROJECT library (${discovered.path}, ` +
					`sha256 ${discovered.hash.slice(0, 12)}…), shadowing the global ` +
					`${discovered.shadowsGlobal.path} (sha256 ${discovered.shadowsGlobal.hash.slice(0, 12)}…).`,
			});
		}
		const parsed = parseTypeFile(discovered.content, discovered.name);
		if (!parsed.ok) {
			throw new Error(`Invalid type definition ${discovered.path}:\n- ${parsed.errors.join("\n- ")}`);
		}
		return { discovered, def: parsed.def };
	}

	/**
	 * Get or build the live AgentSession for an agent. Wake = open the most
	 * recent Pi-native JSONL in the instance dir (memory restored by the SDK)
	 * or create a fresh one. A live handle whose type file changed on disk is
	 * rebuilt when idle, so type edits retune instances at the next wake (D6).
	 */
	private _ensureHandle(
		address: string,
		record: AgentRecord,
		discovered: DiscoveredTypeDef,
		def: TypeDefinition,
		inherit?: InheritedDefaults,
	): Promise<Handle> {
		// M2: creation is serialized per address — _buildHandle spans awaits
		// (createAgentSession), and two racers (spawn + _mailTurn) must never
		// both build a session for one agent: the loser's session leaks and
		// the two transcripts diverge. The loser waits, then _buildHandle's
		// entry re-check returns the winner's handle.
		const prev = this._handleLocks.get(address) ?? Promise.resolve();
		const next = prev
			.catch(() => {}) // a failed earlier build never blocks the next
			.then(() => this._buildHandle(address, record, discovered, def, inherit));
		const lock = next.then(
			() => {},
			() => {},
		);
		this._handleLocks.set(address, lock);
		// Self-cleaning on settle: the map only ever holds IN-FLIGHT builds.
		// Once OUR lock settles and no newer build chained behind it (the map
		// still points at us), the entry is dead weight — a oneshot's fresh
		// tmp-<short> address would otherwise leak one settled promise per
		// spawn for the process lifetime. Deleting only on the settle path
		// (never mid-flight, e.g. from retire) keeps the mutex sound: a racer
		// that arrives before settle chains via the map; one that arrives
		// after starts fresh — there is nothing left to serialize against.
		void lock.then(() => {
			if (this._handleLocks.get(address) === lock) this._handleLocks.delete(address);
		});
		return next;
	}

	private async _buildHandle(
		address: string,
		record: AgentRecord,
		discovered: DiscoveredTypeDef,
		def: TypeDefinition,
		inherit?: InheritedDefaults,
	): Promise<Handle> {
		if (this._disposed || !this._agentLive(address, record.generationId)) {
			throw new Error(`Agent ${address} was retired/recreated or its runtime was disposed — not building a session for it.`);
		}
		const existing = this._handles.get(address);
		if (existing) {
			if (existing.generationId !== record.generationId) {
				if (existing.session.isStreaming) {
					throw new Error(`Address ${address} was recreated while its prior session was still streaming.`);
				}
				existing.session.dispose();
				this._handles.delete(address);
			} else if (existing.typeFileHash === discovered.hash || existing.session.isStreaming) {
				return existing;
			} else {
				existing.session.dispose(); // idle + retuned type: rebuild below
				this._handles.delete(address);
			}
		}
		// M3: _buildSessionOptions mkdirs the instance dir, so the live/disposed
		// check above must precede both the existing-handle fast path and this build.
		const sessionOptions = await this._buildSessionOptions(address, record, def, inherit);
		if (this._disposed || !this._agentLive(address, record.generationId)) {
			throw new Error(`Agent ${address} was retired/recreated or its runtime was disposed while session options were loading.`);
		}
		const { session } = await createAgentSession(sessionOptions);
		// M3: retire/dispose may have raced createAgentSession. Drop the fresh
		// session, but NEVER recursively delete the identity dir: it can contain
		// pre-existing memory that retirement must archive, and another generation
		// may already own the path. The lifecycle owner performs the durable move.
		if (this._disposed || !this._agentLive(address, record.generationId)) {
			session.dispose();
			throw new Error(`Agent ${address} was retired/recreated or its runtime was disposed while its session was being built.`);
		}
		const handle: Handle = {
			session,
			def,
			typeFileHash: discovered.hash,
			generationId: record.generationId,
			// Phase 7 cross-wake accounting: whatever the registry says this
			// identity consumed beyond what the opened session file explains.
			baseVitals: vitalsBaseline(record.vitals, vitalsFrom(session)),
		};
		this._handles.set(address, handle);
		return handle;
	}

	/** Whole-life vitals for a live handle (base + live SessionStats, D15/Phase 7). */
	private _vitalsOf(handle: Handle): AgentVitals {
		return combineVitals(handle.baseVitals, vitalsFrom(handle.session));
	}

	/** Compose the CreateAgentSessionOptions for one wake (all injections). */
	private async _buildSessionOptions(
		address: string,
		record: AgentRecord,
		def: TypeDefinition,
		inherit?: InheritedDefaults,
	): Promise<CreateAgentSessionOptions> {
		const layout = this._layout;
		const instanceDir = layout.agentInstanceDir(record.type, record.id);
		mkdirSync(instanceDir, { recursive: true });

		// Layer 5: the persistent Pi-native session (D3) — resume or start.
		const latest = this._latestSessionFile(record.type, record.id);
		const sessionManager = latest
			? SessionManager.open(latest, instanceDir, layout.cwd)
			: SessionManager.create(layout.cwd, instanceDir);

		// Layers 2+3+4 via the resource loader (context/compose.ts). Layer 2
		// (project context) is loaded HERE with the SDK's own discovery
		// (loadProjectContextFiles — same AGENTS.md rules as a plain Pi
		// session) and handed to compose, which places it BEFORE layers 3+4
		// so the prompt reads in D18 order 1,2,3,4. The SDK's own contextFiles
		// mechanism stays off below (it would append layer 2 LAST).
		const projectFiles = def.config.projectContext
			? loadProjectContextFiles({ cwd: layout.cwd, agentDir: layout.agentDir })
			: [];
		const composed = composeContext(def, this._identityFor(address, record), projectFiles);
		const loader = new DefaultResourceLoader({
			cwd: layout.cwd,
			agentDir: layout.agentDir,
			...(this._settingsManager ? { settingsManager: this._settingsManager } : {}),
			// Deterministic subagent context: no extension/skill/prompt/theme
			// discovery inside subagent sessions.
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true, // layer 2 is ours (placed in appendSystemPrompt above, D18 order)
			appendSystemPrompt: composed.appendSystemPrompt, // layers 2+3+4, in order
		});
		await loader.reload();

		// Model/thinking: frontmatter pin > inherited session default > SDK default.
		let model: ResolveCliModelResult["model"];
		if (def.config.model !== undefined) {
			if (!this._modelRegistry) {
				throw new Error(
					`Type "${def.config.name}" pins model "${def.config.model}" but the runtime ` +
						"was built without a model registry to resolve it.",
				);
			}
			const resolved = resolveCliModel({ cliModel: def.config.model, modelRegistry: this._modelRegistry });
			if (!resolved.model) {
				throw new Error(
					resolved.error ?? `Type "${def.config.name}": unknown model "${def.config.model}".`,
				);
			}
			model = resolved.model;
		} else if (inherit?.modelRef !== undefined && this._modelRegistry) {
			model = resolveCliModel({ cliModel: inherit.modelRef, modelRegistry: this._modelRegistry }).model;
		}
		const thinkingLevel: ThinkingLevel | undefined = def.config.thinking ?? inherit?.thinkingLevel;

		return {
			cwd: layout.cwd,
			agentDir: layout.agentDir,
			sessionManager,
			resourceLoader: loader,
			...(this._modelRegistry ? { modelRegistry: this._modelRegistry } : {}),
			...(this._settingsManager ? { settingsManager: this._settingsManager } : {}),
			...(this._authStorage ? { authStorage: this._authStorage } : {}),
			...(model ? { model } : {}),
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
			// Phase 5 sandbox (D20): Pi's built-in defaults are OFF; everything
			// the agent gets rides customTools — the mail trio (01-power-matrix:
			// send_message/report/ask, address closed over) plus the type-
			// filtered, guard-wrapped coding tools (sandbox/tools-filter.ts).
			noTools: "builtin",
			customTools: [
				...createSubagentTools(address, this._mailPort),
				...buildSandboxedTools(def.config, layout.cwd, {
					policy: this._policyFor(def),
					escalate: (input, signal) => this._escalations.request({ agent: address, ...input }, signal),
				}),
			],
		};
	}

	/**
	 * The D20 path policy for one agent: the type's readOnly/writePaths/
	 * denyPaths plus the implicit system denials — the whole subagents/ state
	 * tree (registry, teams.json, every mailbox, session JSONL, .archive) and
	 * both type-definition dirs, realpath-anchored (symlink defense).
	 */
	private _policyFor(def: TypeDefinition): PathPolicy {
		const realpath = (path: string): string => realpathSync(path);
		return {
			cwd: this._layout.cwd,
			readOnly: def.config.readOnly,
			writePaths: def.config.writePaths,
			denyPaths: def.config.denyPaths,
			systemDenyPrefixes: [
				// Hard-deny Pi's whole per-project session directory: it contains
				// main JSONLs, every owner scope, legacy roots, and timestamped
				// adoption backups. Ephemeral owner state may live elsewhere.
				this._layout.projectSessionDir,
				this._layout.stateContainerRoot,
				this._layout.globalTypeDefsDir,
				this._layout.projectTypeDefsDir,
			].map((dir) => realpathDeep(dir, realpath)),
			realpath,
		};
	}

	private _mainHasRetirementEvidence(address: string, evidenceEnvelopeId: string): boolean {
		const matches = (envelope: Envelope): boolean =>
			envelope.id === evidenceEnvelopeId &&
			envelope.from === address &&
			(envelope.type === "error" ||
				(envelope.type === "report" && envelope.payload.final === true));
		try {
			if (readPending(this._layout.mainMailboxDir).some(({ envelope }) => matches(envelope))) return true;
		} catch {
			// Continue through parked/processed audit state.
		}
		for (const dir of [this._layout.mainMailboxDeliveringDir, this._layout.mainMailboxDoneDir]) {
			try {
				for (const name of readdirSync(dir)) {
					if (!name.endsWith(".json")) continue;
					const envelope = JSON.parse(readFileSync(join(dir, name), "utf8")) as Envelope;
					if (matches(envelope)) return true;
				}
			} catch {
				// Missing/unreadable audit directory has no evidence.
			}
		}
		return false;
	}

	private _readRetireIntent(record: AgentRecord): {
		kind: "manual" | "oneshot-auto";
		evidenceEnvelopeId: string | null;
		source: "final-report" | "runtime-error" | null;
		evidenceText: string | null;
	} | null {
		const file = this._layout.retireRequestedFile(record.type, record.id);
		if (!existsSync(file)) return null;
		try {
			const intent = JSON.parse(readFileSync(file, "utf8")) as {
				kind?: unknown;
				evidenceEnvelopeId?: unknown;
				source?: unknown;
				evidenceText?: unknown;
			};
			return {
				kind: intent.kind === "oneshot-auto" ? "oneshot-auto" : "manual",
				evidenceEnvelopeId:
					typeof intent.evidenceEnvelopeId === "string" && ENVELOPE_ID_RE.test(intent.evidenceEnvelopeId)
						? intent.evidenceEnvelopeId
						: null,
				source:
					intent.source === "final-report" || intent.source === "runtime-error"
						? intent.source
						: null,
				evidenceText: typeof intent.evidenceText === "string" ? intent.evidenceText : null,
			};
		} catch {
			return { kind: "manual", evidenceEnvelopeId: null, source: null, evidenceText: null }; // pre-kind explicit retirement
		}
	}

	private _retireIntentKind(record: AgentRecord): "manual" | "oneshot-auto" | null {
		return this._readRetireIntent(record)?.kind ?? null;
	}

	private _retireIntentReady(record: AgentRecord): boolean {
		const intent = this._readRetireIntent(record);
		if (intent === null) return false;
		if (intent.kind === "manual") return true;
		const address = formatAgentAddress(record.type, record.id);
		if (
			intent.evidenceEnvelopeId !== null &&
			this._mainHasRetirementEvidence(address, intent.evidenceEnvelopeId)
		) return true;
		if (
			intent.source === "runtime-error" &&
			intent.evidenceEnvelopeId !== null &&
			intent.evidenceText !== null
		) {
			// Runtime failures are already terminal before mail routing. Replay the
			// exact reserved evidence after a crash in the intent→send window.
			return this._sendErrorToMain(address, intent.evidenceText, intent.evidenceEnvelopeId) === intent.evidenceEnvelopeId;
		}
		rmSync(this._layout.retireRequestedFile(record.type, record.id), { force: true });
		return false; // final report was reserved but never delivered
	}

	private _markRetireAfterTurn(
		record: AgentRecord,
		handle?: Handle,
		evidenceEnvelopeId?: string,
		source: "final-report" | "runtime-error" = "runtime-error",
		evidenceText?: string,
	): void {
		try {
			atomicWriteJson(this._layout.retireRequestedFile(record.type, record.id), {
				kind: "oneshot-auto",
				requestedAt: new Date().toISOString(),
				...(evidenceEnvelopeId !== undefined ? { evidenceEnvelopeId } : {}),
				source,
				...(evidenceText !== undefined ? { evidenceText } : {}),
			});
		} catch {
			// In-memory retirement still runs; startup recovery is best-effort.
		}
		if (handle) {
			handle.retireAfterTurn = true;
			if (evidenceEnvelopeId !== undefined) handle.retirementEvidenceId = evidenceEnvelopeId;
		}
	}

	private _readAssignmentState(address: string): {
		generationId?: string;
		active: string | null;
		queued: string[];
	} {
		const parsed = parseAddress(address);
		if (parsed?.kind !== "agent") return { active: null, queued: [] };
		try {
			const raw = readFileSync(this._layout.assignmentAnchorFile(parsed.type, parsed.id), "utf8").trim();
			// Protocol-1 compatibility: the old file contained only the latest id.
			if (ENVELOPE_ID_RE.test(raw)) return { active: raw, queued: [] };
			const value = JSON.parse(raw) as Record<string, unknown>;
			const generationId = typeof value.generationId === "string" && /^gen_[0-9a-f]{32}$/.test(value.generationId)
				? value.generationId
				: undefined;
			const active = typeof value.active === "string" && ENVELOPE_ID_RE.test(value.active) ? value.active : null;
			const queued = Array.isArray(value.queued)
				? value.queued.filter((id): id is string => typeof id === "string" && ENVELOPE_ID_RE.test(id))
				: [];
			return {
				...(generationId !== undefined ? { generationId } : {}),
				active,
				queued: [...new Set(queued.filter((id) => id !== active))],
			};
		} catch {
			return { active: null, queued: [] };
		}
	}

	private _writeAssignmentState(
		address: string,
		state: { generationId?: string; active: string | null; queued: string[] },
	): void {
		const parsed = parseAddress(address);
		if (parsed?.kind !== "agent") return;
		const file = this._layout.assignmentAnchorFile(parsed.type, parsed.id);
		if (state.active === null && state.queued.length === 0) {
			rmSync(file, { force: true });
			return;
		}
		mkdirSync(this._layout.agentInstanceDir(parsed.type, parsed.id), { recursive: true });
		atomicWriteJson(file, {
			version: 2,
			...(state.generationId !== undefined ? { generationId: state.generationId } : {}),
			active: state.active,
			queued: state.queued,
		});
	}

	private _reconcileAssignmentAnchors(): void {
		const completedByAddress = new Map<string, Set<string>>();
		const mainMail = [
			...readPending(this._layout.mainMailboxDir).map(({ envelope }) => envelope),
			...readStoredHostEnvelopes(this._layout.mainMailboxDir).map(({ envelope }) => envelope),
		];
		const registry = readRegistry(this._layout.registryFile);
		for (const envelope of mainMail) {
			if (
				envelope.type !== "report" ||
				envelope.payload.final !== true ||
				envelope.correlationId === null
			) continue;
			const record = getAgent(registry, envelope.from);
			if (!record) continue;
			if (envelope.fromGenerationId !== undefined && envelope.fromGenerationId !== record.generationId) continue;
			const completed = completedByAddress.get(envelope.from) ?? new Set<string>();
			completed.add(envelope.correlationId);
			completedByAddress.set(envelope.from, completed);
		}
		for (const record of listAgents(registry)) {
			const address = formatAgentAddress(record.type, record.id);
			// Crash-interrupted retirement recovery owns this directory next; do
			// not let optional anchor reconstruction preempt its fail-closed retry.
			if (hasRetirementTombstone(this._layout.agentInstanceDir(record.type, record.id))) continue;
			let state = this._readAssignmentState(address);
			if (state.generationId !== undefined && state.generationId !== record.generationId) {
				state = { generationId: record.generationId, active: null, queued: [] };
			}
			const completed = completedByAddress.get(address) ?? new Set<string>();
			const mailboxDir = this._layout.mailboxDir(record.type, record.id);
			const inbound = [
				...readPending(mailboxDir).map(({ envelope }) => envelope),
				...readStoredHostEnvelopes(mailboxDir).map(({ envelope }) => envelope),
			]
				.filter((envelope) =>
					envelope.type === "message" &&
					envelope.correlationId === null &&
					envelope.from !== address,
				)
				.sort((a, b) => {
					const byTime = Date.parse(a.sentAt) - Date.parse(b.sentAt);
					return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
				});
			const known = new Set([
				...(state.active !== null ? [state.active] : []),
				...state.queued,
			]);
			for (const envelope of inbound) {
				recordAwaitAnchor(this._layout.mainMailboxDir, envelope.id, address, record.generationId);
				const isCollect =
					typeof envelope.payload.data === "object" &&
					envelope.payload.data !== null &&
					"collectSchema" in (envelope.payload.data as Record<string, unknown>);
				if (isCollect || completed.has(envelope.id) || known.has(envelope.id)) continue;
				if (state.active === null) state.active = envelope.id;
				else state.queued.push(envelope.id);
				known.add(envelope.id);
			}
			while (state.active !== null && completed.has(state.active)) {
				state.active = state.queued.shift() ?? null;
			}
			state.queued = state.queued.filter((anchor) => !completed.has(anchor));
			state.generationId = record.generationId;
			this._writeAssignmentState(address, state);
		}
	}

	private _recordAssignmentAnchor(address: string, envelopeId: string): void {
		const parsed = parseAddress(address);
		if (parsed?.kind !== "agent") return;
		try {
			const currentGeneration = getAgent(readRegistry(this._layout.registryFile), address)?.generationId;
			let state = this._readAssignmentState(address);
			if (
				currentGeneration !== undefined &&
				state.generationId !== undefined &&
				state.generationId !== currentGeneration
			) {
				state = { generationId: currentGeneration, active: null, queued: [] };
			}
			if (currentGeneration !== undefined) {
				state.generationId = currentGeneration;
				recordAwaitAnchor(this._layout.mainMailboxDir, envelopeId, address, currentGeneration);
			} else delete state.generationId;
			if (state.active === null) state.active = envelopeId;
			else if (state.active !== envelopeId && !state.queued.includes(envelopeId)) state.queued.push(envelopeId);
			this._writeAssignmentState(address, state);
		} catch {
			// The report still delivers; an await can fall back to ordinary digest.
		}
	}

	private _reportAssignmentCandidates(address: string): string[] {
		return (this._handles.get(address)?.trigger ?? [])
			.filter(
				(envelope) =>
					envelope.type === "message" &&
					(envelope.from === MAIN_ADDRESS || envelope.from === USER_ADDRESS) &&
					!(typeof envelope.payload.data === "object" &&
						envelope.payload.data !== null &&
						"collectSchema" in (envelope.payload.data as Record<string, unknown>)),
			)
			.map((envelope) => envelope.id);
	}

	private _readAssignmentAnchor(address: string): string | undefined {
		const state = this._readAssignmentState(address);
		const currentGeneration = getAgent(readRegistry(this._layout.registryFile), address)?.generationId;
		if (
			state.generationId !== undefined &&
			currentGeneration !== undefined &&
			state.generationId !== currentGeneration
		) return undefined;
		return state.active ?? undefined;
	}

	private _taskAnchorIdsFor(address: string, trigger: Envelope[]): string[] {
		const triggered = trigger
			.filter((envelope) => envelope.type === "message" && envelope.correlationId === null)
			.map((envelope) => envelope.id);
		const resumesPrior = trigger.some(
			(envelope) =>
				(envelope.type === "answer" || envelope.type === "error") &&
				typeof envelope.correlationId === "string",
		);
		const active = triggered.length === 0 || resumesPrior
			? this._readAssignmentAnchor(address)
			: undefined;
		return [...new Set([...triggered, ...(active !== undefined ? [active] : [])])];
	}

	private _clearAssignmentAnchor(address: string, expected?: string): void {
		try {
			const state = this._readAssignmentState(address);
			if (expected === undefined) {
				this._writeAssignmentState(address, { ...state, active: null, queued: [] });
				return;
			}
			if (state.active === expected) {
				state.active = state.queued.shift() ?? null;
			} else {
				const index = state.queued.indexOf(expected);
				if (index < 0) return;
				state.queued.splice(index, 1);
			}
			this._writeAssignmentState(address, state);
		} catch {
			// The final report is already durable; stale correlation metadata is
			// preferable to making the mail tool appear to have failed afterward.
		}
	}

	/**
	 * M3 liveness: the registry record still exists (retire removes it) AND no
	 * retire() is in flight for it (Finding 13 — the dir may already be archived
	 * while the record removal is pending, so a racing turn must treat it as
	 * gone before the record disappears).
	 */
	private _agentLive(address: string, generationId?: string): boolean {
		if (this._retiring.has(address)) return false;
		const record = getAgent(readRegistry(this._layout.registryFile), address);
		return record !== undefined && (generationId === undefined || record.generationId === generationId);
	}

	/**
	 * M5: error-bounce every unprocessed envelope in a retiring agent's mailbox
	 * back to its sender (user senders fall to main, the operator of last
	 * resort). Called by retire() BEFORE the registry/teams scrub so peer
	 * bounces still pass the delivery guards. Best-effort per envelope.
	 */
	private _hasRetirementBounce(to: string, from: string, correlationId: string): boolean {
		const parsed = parseAddress(to);
		if (parsed?.kind !== "agent") return false;
		const mailboxDir = this._layout.mailboxDir(parsed.type, parsed.id);
		try {
			if (
				readPending(mailboxDir).some(
					({ envelope }) =>
						envelope.type === "error" &&
						envelope.from === from &&
						envelope.correlationId === correlationId,
				)
			) {
				return true;
			}
		} catch {
			// Fall through to the processed audit scan.
		}
		try {
			for (const name of readdirSync(this._layout.mailboxDoneDir(parsed.type, parsed.id))) {
				if (!name.endsWith(".json")) continue;
				const envelope = JSON.parse(
					readFileSync(join(this._layout.mailboxDoneDir(parsed.type, parsed.id), name), "utf8"),
				) as Envelope;
				if (
					envelope.type === "error" &&
					envelope.from === from &&
					envelope.correlationId === correlationId
				) {
					return true;
				}
			}
		} catch {
			// Missing/unreadable done dir means no verifiable earlier bounce.
		}
		return false;
	}

	private _bouncePendingMail(address: string, record: AgentRecord, quietOwnerMail = false): void {
		const mailboxDir = this._layout.mailboxDir(record.type, record.id);
		// Operational reads must abort the funeral: archiving an unread mailbox
		// would silently bury acknowledged peer/user mail. Missing after a
		// concurrent move is already represented by readPending() as [].
		const pending = readPending(mailboxDir);
		const settled: string[] = [];
		for (const p of pending) {
			// Explicit/manual retirement quietly settles owner mail because the
			// owner initiated the funeral. Automatic oneshot retirement must bounce
			// even main/user mail: those sends may have raced the final report and
			// were otherwise acknowledged then buried unprocessed.
			if (
				p.envelope.from === address ||
				(quietOwnerMail && (p.envelope.from === MAIN_ADDRESS || p.envelope.from === USER_ADDRESS))
			) {
				settled.push(p.envelope.id);
				continue;
			}
			if (this._hasRetirementBounce(p.envelope.from, address, p.envelope.id)) {
				settled.push(p.envelope.id);
				continue;
			}
			// A failed bounce aborts retirement before archive/removal. The sender
			// was already told delivery succeeded; burying its message merely
			// because the error route hit transient I/O would violate that contract.
			this._deliverer.bounceUndelivered(
				p.envelope,
				`Recipient \`${address}\` retired with this message unprocessed.`,
			);
			settled.push(p.envelope.id);
		}
		markDone(mailboxDir, settled);
	}

	// -----------------------------------------------------------------------
	// M4 run-ownership marker (defense in depth beneath the D25 host-scope lease)
	//
	// Session scopes now exclude other main conversations. The marker still
	// protects recovery bugs and overlapping runtimes inside one owner scope.
	// The DANGEROUS failure is two runtimes
	// waking the same agent (two live AgentSessions appending one JSONL); the
	// marker below prevents that: a turn stamps <instanceDir>/.run-owner.json
	// (pid + process-start token + runtime id) and no other runtime with a LIVE
	// foreign process identity will wake that agent. Markers from dead or
	// PID-reused processes are ignored and swept by startup reconciliation.
	//
	// Registry/team/index updates use per-file cross-process locks; lifecycle
	// transitions additionally share this lock so spawn/retire/run-owner claims
	// cannot interleave into a half-live identity.
	// -----------------------------------------------------------------------

	private _lifecycleFile(): string {
		return join(this._layout.subagentsRoot, ".lifecycle");
	}

	private _withLifecycleLock<T>(run: () => T): T {
		if (this._lifecycleLockDepth > 0) return run();
		return withFileLockSync(this._lifecycleFile(), () => {
			this._lifecycleLockDepth++;
			try {
				return run();
			} finally {
				this._lifecycleLockDepth--;
			}
		});
	}

	/** Path computed inline: a runtime-internal marker, kin to mailbox/.done. */
	private _runOwnerFile(type: string, id: string): string {
		return join(this._layout.agentInstanceDir(type, id), ".run-owner.json");
	}

	private _runOwnerIsOurs(type: string, id: string, generationId?: string): boolean {
		try {
			const raw = JSON.parse(readFileSync(this._runOwnerFile(type, id), "utf8")) as {
				runtimeId?: unknown;
				generationId?: unknown;
			};
			return raw.runtimeId === this._runtimeId &&
				(generationId === undefined || raw.generationId === generationId);
		} catch {
			return false;
		}
	}

	/** The live FOREIGN owner of an agent, or null (unowned / ours / provably stale). */
	private _foreignRunOwner(type: string, id: string, generationId?: string): { pid: number; runtimeId: string } | null {
		const file = this._runOwnerFile(type, id);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			// Operational uncertainty fails CLOSED. Never let EIO/EMFILE/EACCES
			// authorize a second session or a destructive retirement.
			return { pid: -1, runtimeId: "unreadable-owner" };
		}
		let raw: {
			pid?: unknown;
			runtimeId?: unknown;
			processStartToken?: unknown;
			claimedAt?: unknown;
			generationId?: unknown;
		};
		try {
			raw = JSON.parse(text) as typeof raw;
			if (typeof raw.pid !== "number" || typeof raw.runtimeId !== "string") throw new Error("invalid owner");
		} catch {
			// Compatibility for the former direct-write protocol: a crash could
			// leave a partial marker. A recent one may still have a paused writer;
			// after the grace, let the lifecycle-locked claim path verify and sweep.
			try {
				if (Date.now() - statSync(file).mtimeMs > 30_000) return null;
			} catch {
				// Operational uncertainty remains foreign.
			}
			return { pid: -1, runtimeId: "malformed-owner" };
		}
		const { pid, runtimeId } = raw as { pid: number; runtimeId: string };
		if (
			runtimeId === this._runtimeId &&
			(generationId === undefined || raw.generationId === generationId)
		) return null;
		// Runtime identity, not PID, is the ownership boundary. The process-start
		// token additionally fences a stale marker after OS PID reuse.
		return processMarkerIsLive(raw) ? { pid, runtimeId } : null;
	}

	/**
	 * Finding 5: atomically claim run-ownership. Returns true iff THIS runtime
	 * now owns the turn. The claim is an exclusive create ("wx"): two processes
	 * racing from the same "no live owner" observation cannot both win — the
	 * loser's create fails EEXIST. On EEXIST we read the existing marker: our own
	 * (same runtimeId, or an earlier core in THIS pid whose dispose cleared real
	 * ownership) counts as already held; a LIVE foreign pid means we lost the
	 * race (return false — the caller leaves the mail pending); a DEAD foreign
	 * pid is a stale marker we sweep before retrying the exclusive create once.
	 */
	private _claimRunOwner(type: string, id: string, generationId?: string): boolean {
		const instanceDir = this._layout.agentInstanceDir(type, id);
		const file = this._runOwnerFile(type, id);
		generationId ??= getAgent(readRegistry(this._layout.registryFile), formatAgentAddress(type, id))?.generationId;
		if (generationId === undefined) return false;
		const processStartToken = pidStartToken(process.pid);
		const ownerPayload = {
			pid: process.pid,
			runtimeId: this._runtimeId,
			claimedAt: new Date().toISOString(),
			generationId,
			...(processStartToken !== undefined ? { processStartToken } : {}),
		};
		const payload = `${JSON.stringify(ownerPayload)}\n`;
		try {
			mkdirSync(instanceDir, { recursive: true });
			// Sweep only complete candidates whose process instance is dead. They
			// never own the public marker, but should not leak after a crash.
			for (const name of readdirSync(instanceDir)) {
				if (!name.startsWith(".run-owner.json.candidate-")) continue;
				const candidateFile = join(instanceDir, name);
				try {
					const candidateOwner = JSON.parse(readFileSync(candidateFile, "utf8"));
					if (!processMarkerIsLive(candidateOwner)) rmSync(candidateFile, { force: true });
				} catch {
					// A private candidate never owns the public marker. Give a paused
					// writer the legacy grace, then remove malformed crash debris; if it
					// resumes, its hard-link attempt simply fails closed.
					try {
						if (Date.now() - statSync(candidateFile).mtimeMs > 30_000) rmSync(candidateFile, { force: true });
					} catch {
						// Concurrent cleanup/write or operational uncertainty: retry later.
					}
				}
			}
		} catch {
			return false;
		}
		const candidate = `${file}.candidate-${this._runtimeId}-${randomBytes(8).toString("hex")}`;
		try {
			writeFileSync(candidate, payload, { flag: "wx", mode: 0o600 });
		} catch {
			// This pathname is private to our random lockId, so cleanup cannot
			// affect another claimant even if the write failed after creation.
			rmSync(candidate, { force: true });
			return false;
		}
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					// Complete private record first, create-if-absent hard-link second:
					// a crash never publishes an empty/partial ownership marker.
					linkSync(candidate, file);
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
				}
				let text: string;
				try {
					text = readFileSync(file, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					return false; // operational uncertainty fails closed
				}
				let owner: {
					pid?: unknown;
					runtimeId?: unknown;
					processStartToken?: unknown;
					claimedAt?: unknown;
					generationId?: unknown;
				};
				try {
					owner = JSON.parse(text) as typeof owner;
					if (typeof owner.pid !== "number" || typeof owner.runtimeId !== "string") throw new Error("invalid owner");
				} catch {
					try {
						if (Date.now() - statSync(file).mtimeMs <= 30_000) return false;
						if (readFileSync(file, "utf8") !== text) return false;
						rmSync(file, { force: true });
						continue;
					} catch {
						return false;
					}
				}
				if (owner.runtimeId === this._runtimeId) {
					if (owner.generationId !== generationId) {
						try {
							if (readFileSync(file, "utf8") !== text) return false;
							rmSync(file, { force: true });
							continue;
						} catch {
							return false;
						}
					}
					try {
						atomicWriteJson(file, ownerPayload); // complete atomic refresh
					} catch {
						// Refresh failure does not transfer our existing ownership.
					}
					return true;
				}
				if (processMarkerIsLive(owner)) return false;
				// Lifecycle-locked stale replacement; operational unlink failure is
				// fail-closed and a fresh foreign marker cannot be overwritten.
				try {
					if (readFileSync(file, "utf8") !== text) return false;
					rmSync(file, { force: true });
				} catch {
					return false;
				}
			}
			return false;
		} finally {
			rmSync(candidate, { force: true });
		}
	}

	/** Remove the marker if it is ours (or unconditionally with force). */
	private _clearRunOwner(type: string, id: string, force = false, generationId?: string): void {
		const file = this._runOwnerFile(type, id);
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as {
				runtimeId?: unknown;
				generationId?: unknown;
			};
			if (!force && raw.runtimeId !== this._runtimeId) return;
			if (
				generationId !== undefined &&
				typeof raw.generationId === "string" &&
				raw.generationId !== generationId
			) return;
			rmSync(file, { force: true });
		} catch {
			// Missing/unreadable — nothing to clear.
		}
	}

	private _prepareRuntimeRetirement(record: AgentRecord, handle: Handle, evidenceText: string): string | undefined {
		if (record.lifetime !== "oneshot" || handle.retireAfterTurn) return undefined;
		const evidenceEnvelopeId = `msg_${ulid()}`;
		this._markRetireAfterTurn(record, handle, evidenceEnvelopeId, "runtime-error", evidenceText);
		return evidenceEnvelopeId;
	}

	private _warnCumulativeLimits(
		address: string,
		handle: Handle,
		ceilings: CeilingDefaults,
		turnId: string,
		taskAnchorIds: string[] = [],
	): void {
		const vitals = this._vitalsOf(handle);
		handle.limitWarnings ??= new Set();
		if (
			ceilings.maxTokensTotal !== undefined &&
			vitals.tokens >= ceilings.maxTokensTotal &&
			!handle.limitWarnings.has("maxTokensTotal")
		) {
			handle.limitWarnings.add("maxTokensTotal");
			this._emit({
				type: "limit-warning",
				address,
				limit: "maxTokensTotal",
				observed: vitals.tokens,
				threshold: ceilings.maxTokensTotal,
				turnId,
				taskAnchorIds,
			});
		}
		if (
			ceilings.maxContextCompactions !== undefined &&
			vitals.compactions >= ceilings.maxContextCompactions &&
			!handle.limitWarnings.has("maxContextCompactions")
		) {
			handle.limitWarnings.add("maxContextCompactions");
			this._emit({
				type: "limit-warning",
				address,
				limit: "maxContextCompactions",
				observed: vitals.compactions,
				threshold: ceilings.maxContextCompactions,
				turnId,
				taskAnchorIds,
			});
		}
	}

	/** Error envelope to main; mail failures must never break the turn pipeline. */
	private _sendErrorToMain(address: string, text: string, envelopeId?: string): string | null {
		try {
			return this._deliverer.send({
				...(envelopeId !== undefined ? { envelopeId } : {}),
				from: address,
				to: MAIN_ADDRESS,
				type: "error",
				text,
			}).envelope.id;
		} catch {
			return null; // the runtime turn-error event already fired
		}
	}


	/** Layer-4 inputs: address, purview, team rosters WITH purviews (D18). */
	private _identityFor(address: string, record: AgentRecord): IdentityOptions {
		const teams = readTeams(this._layout.teamsFile);
		const registry = readRegistry(this._layout.registryFile);
		const rosters: TeamRoster[] = teamsOf(teams, address).map((team) => ({
			team,
			teammates: (teams[team] ?? [])
				.filter((member) => member !== address)
				.map((member) => ({
					address: member,
					purview: getAgent(registry, member)?.purview ?? member,
				})),
		}));
		return { address, purview: record.purview, teams: rosters };
	}

	private _setState(address: string, state: AgentState, generationId?: string): boolean {
		const changed = updateRegistry(this._layout.registryFile, (registry) => {
			const record = getAgent(registry, address);
			if (!record || (generationId !== undefined && record.generationId !== generationId)) return false;
			record.state = state;
			record.updatedAt = new Date().toISOString();
			return true;
		});
		if (changed) this._emit({ type: "state-changed", address, state });
		return changed;
	}

	private _requireRecord(address: string): AgentRecord {
		if (parseAddress(address)?.kind !== "agent") {
			throw new Error(`"${address}" is not a subagent address (<type>/<id>).`);
		}
		const record = getAgent(readRegistry(this._layout.registryFile), address);
		if (!record) {
			throw new Error(
				`No subagent at "${address}" — it was retired or never spawned. ` +
					"Use subagent_status to list the live agents, or subagent_spawn to create it.",
			);
		}
		return record;
	}

	private _toRosterEntry(record: AgentRecord, teams: Record<string, string[]>): RosterEntry {
		const address = formatAgentAddress(record.type, record.id);
		const handle = this._handles.get(address);
		// Read-side joins (no new powers): mailbox unread count, and — for a
		// `waiting` agent — WHY it waits (its pending escalation, summarized).
		const waitingOn =
			record.state === "waiting"
				? this._escalations
						.pending()
						.filter((esc) => esc.agent === address)
						.map((esc) => ({
							id: esc.id,
							envelopeId: esc.envelopeId,
							tool: esc.tool,
							reason: esc.reason,
						}))
				: [];
		return {
			address,
			type: record.type,
			id: record.id,
			state: record.state,
			lifetime: record.lifetime,
			purview: record.purview,
			teams: teamsOf(teams, address),
			// Live sessions report fresh whole-life vitals; dormant ones the
			// last persisted (already whole-life, Phase 7).
			vitals: handle ? this._vitalsOf(handle) : record.vitals,
			unread: pendingCount(this._layout.mailboxDir(record.type, record.id)),
			...(waitingOn.length > 0 ? { waitingOn } : {}),
			updatedAt: record.updatedAt,
		};
	}

	/** Most recent Pi session JSONL in the instance dir (filenames sort by time). */
	private _latestSessionFile(type: string, id: string): string | undefined {
		const dir = this._layout.agentInstanceDir(type, id);
		if (!existsSync(dir)) return undefined;
		const files = readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
		const last = files[files.length - 1];
		return last ? `${dir}/${last}` : undefined;
	}

	private _emit(event: RuntimeEvent): void {
		for (const listener of this._listeners) {
			try {
				listener(event);
			} catch {
				// Listeners must never break the runtime.
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers (module-local, pure-ish)
// ---------------------------------------------------------------------------

/**
 * A wall-clock timeout that can pause (escalation `waiting`, m4/D22) and
 * resume with whatever budget remains. clear() is terminal.
 */
export function makePausableTimer(
	totalMs: number,
	onFire: () => void,
): { pause(): void; resume(): void; clear(): void } {
	let remaining = totalMs;
	let startedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(onFire, totalMs);
	let done = false;
	return {
		pause() {
			if (done || timer === undefined) return;
			clearTimeout(timer);
			timer = undefined;
			remaining = Math.max(0, remaining - (Date.now() - startedAt));
		},
		resume() {
			if (done || timer !== undefined) return;
			startedAt = Date.now();
			timer = setTimeout(onFire, remaining);
		},
		clear() {
			done = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}

/**
 * The escalation envelope's body (D10/D16): enough for the main agent to
 * re-plan or DENY — and an explicit reminder that approval is human-only.
 */
function escalationMailText(record: EscalationRecord): string {
	return [
		"A tool call was blocked by type policy and needs a HUMAN decision (approvals never flow downhill).",
		`- agent: \`${record.agent}\``,
		`- tool: ${record.tool}`,
		`- input: ${record.inputSummary}`,
		`- blocked by: ${record.reason}`,
		`- escalation id: ${record.id}`,
		"",
		"The agent is paused in `waiting` — its tool call blocks until the human approves or denies " +
			"(TUI escalation prompt).",
		"You may DENY this now (e.g. it is off-plan): send to the agent with correlationId set to THIS " +
			"envelope's id — your text becomes the deny note the tool error carries. You cannot approve; " +
			"only the human can.",
	].join("\n");
}

/**
 * The cross-wake vitals baseline (Phase 7, D15 leftover): how much of the
 * registry's persisted whole-life totals the freshly-opened session does NOT
 * already account for. Resuming the same JSONL → SessionStats recomputes the
 * full history → baseline 0 (no double count); a fresh session file (first
 * wake, or history lost/rotated) → baseline = the previous totals, so
 * cumulative accounting continues where it left off. PURE.
 */
export function vitalsBaseline(persisted: AgentVitals, liveAtOpen: AgentVitals): AgentVitals {
	return {
		contextPercent: 0, // context fill is a live figure, never carried over
		tokens: Math.max(0, persisted.tokens - liveAtOpen.tokens),
		cost: Math.max(0, persisted.cost - liveAtOpen.cost),
		turns: Math.max(0, persisted.turns - liveAtOpen.turns),
		compactions: Math.max(0, persisted.compactions - liveAtOpen.compactions),
	};
}

/** baseline + live SessionStats = whole-life vitals (Phase 7). PURE. */
export function combineVitals(base: AgentVitals, live: AgentVitals): AgentVitals {
	return {
		contextPercent: live.contextPercent,
		tokens: base.tokens + live.tokens,
		cost: base.cost + live.cost,
		turns: base.turns + live.turns,
		compactions: base.compactions + live.compactions,
	};
}

/** Live vitals from an AgentSession (D15). */
export function vitalsFrom(session: AgentSession): AgentVitals {
	const stats = session.getSessionStats();
	const compactions = session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "compaction").length;
	return {
		contextPercent: stats.contextUsage?.percent ?? 0,
		tokens: stats.tokens.total,
		cost: stats.cost,
		turns: stats.assistantMessages,
		compactions,
	};
}

/**
 * The questions an agent sent that are still unanswered (M-fix read-side
 * join, no new powers): its `.sent-questions.json` index minus every question
 * a delivered `answer`/`error` envelope (pending or .done) already correlates
 * to. Best-effort and read-only — .done GC can eventually resurrect an old
 * answered question, which is harmless for a recovery affordance.
 */
export function readOutstandingQuestions(mailboxDir: string): OutstandingQuestion[] {
	let index: Record<string, unknown>;
	try {
		const parsed = JSON.parse(readFileSync(sentQuestionsFileOf(mailboxDir), "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
		index = parsed as Record<string, unknown>;
	} catch {
		return [];
	}
	const resolved = new Set<string>();
	for (const dir of [mailboxDir, mailboxDoneDirOf(mailboxDir)]) {
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}
		for (const name of names) {
			try {
				const envelope = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
					type?: unknown;
					from?: unknown;
					correlationId?: unknown;
				};
				if (
					(envelope.type === "answer" || envelope.type === "error") &&
					typeof envelope.from === "string" &&
					typeof envelope.correlationId === "string"
				) {
					const raw = index[envelope.correlationId];
					const expectedFrom =
						typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
						typeof (raw as Record<string, unknown>).expectedFrom === "string"
							? (raw as Record<string, unknown>).expectedFrom as string
							: "";
					if (expectedFrom === "" || envelope.from === expectedFrom || envelope.from === MAIN_ADDRESS) {
						resolved.add(envelope.correlationId);
					}
				}
			} catch {
				// Unreadable envelope — never breaks a peek.
			}
		}
	}
	return Object.entries(index)
		.map(([id, raw]) => {
			if (typeof raw === "string") return { id, text: raw };
			if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).text === "string") {
				return { id, text: (raw as Record<string, unknown>).text as string };
			}
			return null;
		})
		.filter((entry): entry is OutstandingQuestion => entry !== null && !resolved.has(entry.id))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Read the last `tail` message entries of a Pi session file (peek; read-only).
 * tail <= 0 means "no tail, vitals only" and returns [] WITHOUT touching the
 * file — `slice(-0)` is `slice(0)` (the whole transcript), which both dumped
 * the entire session into the caller's context (subagent_status tail:0) and
 * made the viewer's 1s vitals poll re-read+parse the full JSONL every tick.
 */
export function readTranscriptTail(sessionFile: string, tail: number): TranscriptEntry[] {
	if (tail <= 0) return [];
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const messages = parseSessionEntries(content).filter(
		(entry): entry is SessionMessageEntry => "type" in entry && entry.type === "message",
	);
	return messages.slice(-Math.max(0, tail)).map((entry) => ({
		role: entry.message.role,
		text: flattenMessageText(entry.message),
		timestamp: entry.timestamp,
	}));
}

function flattenMessageText(message: SessionMessageEntry["message"]): string {
	const content: unknown = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content as Array<Record<string, unknown>>) {
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "thinking" && typeof part.thinking === "string") {
			parts.push(`[thinking] ${part.thinking}`);
		} else if (part.type === "toolCall") {
			parts.push(`[tool: ${String(part.name ?? "?")}] ${JSON.stringify(part.arguments ?? {})}`);
		}
	}
	return parts.join("\n");
}
