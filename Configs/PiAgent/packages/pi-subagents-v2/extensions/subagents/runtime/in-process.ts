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
 * Teams + rails (Phase 4, D12/D21): the Deliverer below runs the real guards —
 * makeTeamGuard (shared-team check, live teams.json reads, envelope.team
 * stamped) and rails/hops.ts makeHopsGuard (maxHops cap; report/escalation/
 * error to main always pass — the escape route). An optional shared
 * AutonomyBudget gates _mailTurn: while paused NO new subagent turn starts
 * (mail stays queued on disk — pause never kills) and every turn that does
 * run consumes one pool turn plus its SessionStats token delta; a resume
 * refills the pool and this runtime re-drains every pending mailbox.
 * Roster-change wake-digest lines (D18): each mail turn diffs the agent's
 * `.roster.json` snapshot against teams.json and prepends the changes.
 * Sandbox + escalation (Phase 5, D10/D20/D22): _buildSessionOptions maps the
 * type's tools/readOnly/writePaths/denyPaths onto the session via
 * `noTools: "builtin"` + sandbox/tools-filter.ts customTools (Pi's own tool
 * definitions, mutating ones wrapped through sandbox/paths.ts +
 * sandbox/bash-guard.ts). A guarded call that needs a human blocks inside
 * its tool execute on EscalationManager.request(): the agent flips to
 * `waiting`, an escalation envelope reaches main (D16 auto-wake), and —
 * DECISION — the turn RELEASES its scheduler slot while waiting (a possibly-
 * forever human pause must not starve other agents; per-agent turn
 * serialization is untouched because the turn's chain promise stays pending)
 * and re-acquires one before the tool proceeds on approve/deny. The human
 * resolves via approve/deny (core → Phase 6 modal); the main agent may only
 * DENY, by mailing the waiting agent with correlationId = the escalation
 * envelope's id (no new tool surface, 01-power-matrix).
 * Ceilings (D15/D20): frontmatter maxTokensTotal/maxTurnMinutes/
 * maxContextCompactions (defaults from settings) — maxTurnMinutes aborts the
 * running turn via a timer; token/compaction ceilings are checked before and
 * after every turn. Crossing emits an `error` envelope + interrupt; oneshots
 * auto-retire (D13 — also on fatal turn errors), persistent agents park
 * dormant until the main agent decides.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	parseAddress,
	USER_ADDRESS,
} from "../mail/envelope.ts";
import { Deliverer, type DeliveryOutcome, makeTeamGuard } from "../mail/deliver.ts";
import type { AutonomyBudget } from "../rails/autonomy.ts";
import { DEFAULT_MAX_HOPS, makeHopsGuard } from "../rails/hops.ts";
import { composeWakeDigest } from "../mail/digest.ts";
import {
	beginDelivery,
	deleteSentQuestions,
	lookupSentQuestion,
	markDone,
	pendingCount,
	readPending,
} from "../mail/mailbox.ts";
import type { Layout } from "../store/layout.ts";
import { archiveAgentDir, hasRetirementTombstone } from "../store/archive.ts";
import {
	type AgentRecord,
	type AgentState,
	type AgentVitals,
	emptyVitals,
	getAgent,
	listAgents,
	readRegistry,
	removeAgent,
	updateRegistry,
	upsertAgent,
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
	/**
	 * An envelope landed in .main/mailbox/ — the host extension applies D16
	 * selective auto-wake from here. Delivery already happened (file on disk).
	 */
	onMainMail?: (envelope: Envelope) => void;
	/** D21 chain-depth cap. Default 8. A getter keeps it live (Phase 7). */
	maxHops?: number | (() => number);
	/**
	 * The session-shared D21 autonomy pool (core owns it — the same instance
	 * also meters auto-woken MAIN turns in index.ts). Omitted = unlimited
	 * (lower-phase harnesses). While paused, no new subagent turn starts; on
	 * resume this runtime re-drains every mailbox with pending envelopes.
	 */
	autonomy?: AutonomyBudget;
	/**
	 * D15/D20 global ceiling defaults (core settings); a type's frontmatter
	 * overrides field-by-field. Undefined field = unlimited. Read live per
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

/** Global ceiling defaults (D15) — same fields the frontmatter can pin. */
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
 * Which cumulative ceiling (tokens / compactions) is crossed, if any —
 * a human-readable description, or null. maxTurnMinutes is enforced by a
 * live turn timer instead (it is a rate, not a cumulative figure).
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
	/** Oneshot delivered its final report — retire at the turn boundary (D13). */
	retireAfterTurn?: boolean;
	/** Who aborted the current turn: user interrupt vs the turn-minutes timer. */
	abortedBy?: "interrupt" | "ceiling" | null;
	/** A ceiling error envelope was already sent — never spam main (D15). */
	ceilingNotified?: boolean;
}

const DEFAULT_PERSISTENT_ID = "main";

/** dispose(): how long to wait for in-flight turns to unwind (C2 clean quit). */
const DISPOSE_CHAIN_TIMEOUT_MS = 5_000;

function oneshotId(): string {
	// Crockford-ish short suffix; collision checked against the registry.
	return `tmp-${randomBytes(4).toString("hex").slice(0, 7)}`;
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
	/** This runtime instance's identity for the M4 run-ownership marker. */
	private readonly _runtimeId = `rt_${process.pid}_${randomBytes(4).toString("hex")}`;
	/** dispose() flips this: no new turn ever starts on a disposed runtime. */
	private _disposed = false;
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

	constructor(options: InProcessRuntimeOptions) {
		this._layout = options.layout;
		this._modelRegistry = options.modelRegistry;
		this._settingsManager = options.settingsManager;
		this._authStorage = options.authStorage;
		this._scheduler = new Scheduler(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
		this._autonomy = options.autonomy;
		// Pause/resume are runtime events (Phase 6 banner) and a resume drains
		// every mailbox that queued up while paused (D21: pause never kills).
		this._autonomy?.subscribe((event, status) => {
			if (event === "paused") {
				this._emit({ type: "autonomy-paused", status });
			} else {
				this._emit({ type: "autonomy-resumed", status });
				this._drainAllPendingMail();
			}
		});
		this._deliverer = new Deliverer({
			layout: options.layout,
			// Phase 4 guards: D12 shared-team check (stamps envelope.team; live
			// teams.json reads) and the D21 maxHops cap with its main escape.
			teamGuard: makeTeamGuard(() => readTeams(this._layout.teamsFile)),
			hopsGuard: makeHopsGuard(options.maxHops ?? DEFAULT_MAX_HOPS),
			recipientState: (address) => getAgent(readRegistry(this._layout.registryFile), address)?.state,
			wake: (address) => this._scheduleMailTurn(address),
			...(options.onMainMail ? { onMainMail: options.onMainMail } : {}),
			onEnvelope: (envelope) =>
				this._emit({ type: "envelope-sent", from: envelope.from, to: envelope.to, envelopeId: envelope.id }),
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
				});
				return outcome.disposition === "bounced" ? null : outcome.envelope.id;
			},
			onWaiting: (agent) => {
				this._setState(agent, "waiting");
				// Release the turn's slot while the human decides (see _slots),
				// and pause the maxTurnMinutes wall clock (m4/D22: `waiting` may
				// last forever — human deliberation must not burn turn budget).
				this._slots.get(agent)?.release();
				this._turnTimers.get(agent)?.pause();
			},
			onResolved: async (agent) => {
				const slot = this._slots.get(agent);
				if (!slot) return; // turn already unwound (interrupt/retire/timer)
				const release = await this._scheduler.acquire();
				// M1: while we waited for a slot the turn may have been unwound —
				// its finally deleted the _slots entry (and no-op-released). Do
				// NOT leak the fresh slot or stamp `running` on a turnless agent.
				if (this._slots.get(agent) !== slot) {
					release();
					return;
				}
				slot.release = release;
				this._setState(agent, "running");
				this._turnTimers.get(agent)?.resume();
			},
			emit: (event) => this._emit(event),
		});
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

	/** HUMAN-only (D10) — never expose to the main agent's tool surface. */
	approveEscalation(id: string): boolean {
		return this._escalations.approve(id);
	}

	denyEscalation(id: string, note?: string): boolean {
		return note === undefined ? this._escalations.deny(id) : this._escalations.deny(id, note);
	}

	// -----------------------------------------------------------------------
	// spawn
	// -----------------------------------------------------------------------

	async spawn(options: SpawnOptions): Promise<SpawnResult> {
		const lifetime = options.lifetime ?? "persistent";

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
			} while (getAgent(registry, formatAgentAddress(options.type, id)) !== undefined);
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

		// Get-or-create on address; only persistent agents can match (D20).
		const { record, created } = updateRegistry(this._layout.registryFile, (registry) => {
			const result = upsertAgent(registry, {
				type: options.type,
				id,
				lifetime,
				purview: id,
				typeFileHash: discovered.hash,
				state: "dormant",
			});
			if (!result.created) {
				// Wake: record the constitution this instance is now running under.
				result.record.typeFileHash = discovered.hash;
				result.record.updatedAt = new Date().toISOString();
			}
			return result;
		});

		if (options.team !== undefined) {
			updateTeams(this._layout.teamsFile, (teams) => addTo(teams, options.team!, address));
		}

		// Ensure the instance dirs exist ("the directory is the truth").
		mkdirSync(this._layout.filesDir(options.type, id), { recursive: true });

		await this._ensureHandle(address, record, discovered, def, options.inherit);

		if (options.task !== undefined) {
			// The task is mail like everything else (D18 layer 6): an envelope
			// from main that wakes the agent into a digest turn, asynchronously
			// under the scheduler cap (D13).
			this._deliverer.send({ from: MAIN_ADDRESS, to: address, type: "message", text: options.task });
		}

		const after = getAgent(readRegistry(this._layout.registryFile), address);
		return {
			address,
			created,
			state: after?.state ?? "dormant",
			vitals: after?.vitals ?? emptyVitals(),
		};
	}

	// -----------------------------------------------------------------------
	// send / sendAsUser / collect / steer / interrupt / retire
	// -----------------------------------------------------------------------

	async send(options: SendOptions): Promise<SendResult> {
		const record = this._requireRecord(options.to);
		// Main's ONE escalation power (01-power-matrix): a send correlated to a
		// pending escalation's envelope DENIES it, the text becoming the deny
		// note. Approval can never ride this path. The mail still delivers
		// normally below (the agent sees main's reasoning in its next digest).
		if (options.correlationId !== undefined) {
			this._escalations.denyByEnvelope(options.correlationId, options.text);
		}
		const outcome = this._deliverer.send({
			from: MAIN_ADDRESS,
			to: options.to,
			// Answering a question envelope = answer type (03-tool-surface).
			type: options.correlationId !== undefined ? "answer" : "message",
			text: options.text,
			...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
			...(options.when !== undefined ? { when: options.when } : {}),
		});
		return this._toSendResult(outcome, record.state);
	}

	async sendAsUser(options: SendOptions): Promise<SendResult> {
		const record = this._requireRecord(options.to);
		// D21 / Finding 14: a message typed into the subagent VIEWER is a genuine
		// USER action (D17 superuser row) — it resets the autonomy pool exactly
		// like a main-session user turn (index.ts's before_agent_start reset). If
		// the pool was paused this resumes it, and the "resumed" event drains
		// every queued mailbox (subscribe → _drainAllPendingMail), so this
		// message doesn't sit queued behind a paused pool. NOT done for send()
		// (main-agent tool sends are autonomous, never a user reset).
		this._autonomy?.reset();
		const outcome = this._deliverer.send({
			from: USER_ADDRESS,
			to: options.to,
			type: options.correlationId !== undefined ? "answer" : "message",
			text: options.text,
			...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
			...(options.when !== undefined ? { when: options.when } : {}),
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
		return { requested: true, requestId: outcome.envelope.id, recipientState: record.state };
	}

	async steer(to: string, text: string): Promise<SteerResult> {
		const handle = this._handles.get(to);
		if (!handle || !handle.session.isStreaming) return { steered: false };
		await handle.session.steer(text);
		return { steered: true };
	}

	async interrupt(to: string): Promise<InterruptResult> {
		const handle = this._handles.get(to);
		if (!handle || !handle.session.isStreaming) return { interrupted: false };
		handle.abortedBy = "interrupt"; // not a crash, not a ceiling — no error envelope
		await handle.session.abort();
		return { interrupted: true };
	}

	async retire(to: string): Promise<RetireResult> {
		const record = this._requireRecord(to);
		// Finding 13: per-address lifecycle lock. From here the agent counts as
		// not-live (_agentLive) so a concurrent _mailTurn / handle-build stands
		// down and never recreates session state under the dir we are moving.
		this._retiring.add(to);
		try {
			const handle = this._handles.get(to);
			if (handle) {
				if (handle.session.isStreaming) {
					handle.abortedBy = "interrupt";
					await handle.session.abort();
				}
				handle.session.dispose();
				this._handles.delete(to);
			}
			// Defensive: the abort's signal already cancels a paused escalation;
			// sweep anything left so no promise pends for a dead agent.
			this._escalations.cancelFor(to, `Agent ${to} was retired while the escalation was pending.`);
			this._chains.delete(to);
			// M5: bounce every UNPROCESSED envelope back to its sender before the
			// mailbox is archived. Senders were told delivery succeeded (held/
			// queued) — burying their mail in .archive/ would strand an asker in
			// dormant forever (D13's "funeral loses nothing" covers OUTBOUND
			// reports; inbound pending mail needs the bounce). Runs BEFORE the
			// archive move AND the teams scrub so peer error envelopes still pass
			// the guards.
			this._bouncePendingMail(to, record);
			// Finding 13 ordering: ARCHIVE (tombstone + move dir) BEFORE the
			// registry/team scrub. A crash between the two leaves the dir already
			// in .archive/ (memory cannot be resurrected by a later get-or-create)
			// with the registry record still present — the startup reconciliation
			// finishes the funeral. The OLD order (registry removal FIRST, move
			// LAST) left a crash window where a deregistered agent's dir stayed at
			// the live path and the next same-address spawn resurrected its memory.
			const archiveDir = archiveAgentDir(this._layout, record.type, record.id);
			updateRegistry(this._layout.registryFile, (registry) => removeAgent(registry, to));
			updateTeams(this._layout.teamsFile, (teams) => scrubAddress(teams, to));
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

	async dispose(): Promise<void> {
		// C2 (clean-quit half): stop new turns first, abort the running ones,
		// then best-effort await the in-flight _chains — their finally blocks
		// write `dormant` + clear run-owner markers, so a clean quit leaves no
		// stranded running/queued/waiting records. Bounded by a timeout (a
		// wedged turn must not block shutdown); the startup reconciliation is
		// the backstop for whatever a timeout (or crash) leaves behind.
		this._disposed = true;
		for (const [address, handle] of this._handles) {
			if (handle.session.isStreaming) {
				handle.abortedBy = "interrupt"; // shutdown, not a crash — no error mail
				await handle.session.abort().catch(() => {});
			}
			this._escalations.cancelFor(address, "Host session shut down while the escalation was pending.");
		}
		const chains = [...this._chains.values()];
		if (chains.length > 0) {
			await Promise.race([
				Promise.allSettled(chains),
				new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_CHAIN_TIMEOUT_MS)),
			]);
		}
		for (const handle of this._handles.values()) {
			handle.session.dispose();
		}
		this._handles.clear();
		this._chains.clear();
		// Any still-unsettled creation locks belong to builds that are now
		// doomed (disposed sessions / dead agents) — nothing will ever chain
		// behind them again; drop them with the handles/chains.
		this._handleLocks.clear();
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
	private _scheduleMailTurn(address: string): void {
		if (this._disposed) return;
		this._setState(address, "queued");
		const prev = this._chains.get(address) ?? Promise.resolve();
		// C1 hardening: hop through a REAL timer before each turn. Every await
		// in a no-op turn (mock providers, empty mailboxes, early bails) can
		// resolve synchronously, so chained reschedules would otherwise be a
		// pure-microtask loop that starves the host event loop. The macrotask
		// hop guarantees any reschedule path yields to timers/IO.
		const next = prev
			.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
			.then(() => this._mailTurn(address))
			.catch(() => {});
		this._chains.set(address, next);
	}

	/**
	 * Autonomy-resumed drain (D21): schedule a digest turn for every DORMANT
	 * agent whose mailbox accumulated envelopes while the system was paused.
	 * m2: only dormant — a running/waiting/queued agent already has a live
	 * turn (or a queued one) that drains its mailbox at the boundary, and
	 * stamping `queued` over `waiting`/`running` would corrupt lifecycle state.
	 */
	private _drainAllPendingMail(): void {
		for (const record of listAgents(readRegistry(this._layout.registryFile))) {
			const address = formatAgentAddress(record.type, record.id);
			if (record.state !== "dormant") continue;
			if (pendingCount(this._layout.mailboxDir(record.type, record.id)) > 0) {
				this._scheduleMailTurn(address);
			}
		}
	}

	/**
	 * C2 startup reconciliation (see constructor). Best-effort: reconciliation
	 * must never break runtime construction.
	 */
	private _reconcileStartupState(): void {
		try {
			if (!existsSync(this._layout.registryFile)) return;
			const skipForeign = new Set<string>();
			const resetAddresses = new Set<string>();
			// Finding 13: agents whose retire() crashed mid-flight — the dir was
			// already archived (or tombstoned in place) but the registry record
			// was never removed. Collected here, finished (archive + team scrub)
			// after the registry mutation closes.
			const crashedRetire: Array<{ address: string; type: string; id: string }> = [];
			updateRegistry(this._layout.registryFile, (registry) => {
				for (const record of listAgents(registry)) {
					const address = formatAgentAddress(record.type, record.id);
					if (this._foreignRunOwner(record.type, record.id) !== null) {
						skipForeign.add(address); // live elsewhere — not ours to touch
						continue;
					}
					// A marker from a DEAD process is stale — clean it up.
					this._clearRunOwner(record.type, record.id, /*force*/ true);
					// Finding 13: a crash between archiveAgentDir and removeAgent.
					// The instance dir is gone (moved to .archive/) or still present
					// but already tombstoned (crash between the marker write and the
					// rename). Finish the funeral so a later get-or-create can never
					// wake a half-retired identity with resurrected memory.
					const instanceDir = this._layout.agentInstanceDir(record.type, record.id);
					if (!existsSync(instanceDir) || hasRetirementTombstone(instanceDir)) {
						crashedRetire.push({ address, type: record.type, id: record.id });
						removeAgent(registry, address);
						continue;
					}
					if (record.state !== "dormant") {
						record.state = "dormant";
						record.updatedAt = new Date().toISOString();
						resetAddresses.add(address);
					}
				}
			});
			for (const { address, type, id } of crashedRetire) {
				// Idempotent: a no-op if the dir was already moved (Window B); it
				// completes the move if it was only tombstoned (Window A).
				archiveAgentDir(this._layout, type, id);
				updateTeams(this._layout.teamsFile, (teams) => scrubAddress(teams, address));
			}
			// A crash while `waiting` orphans the agent's pending escalation
			// record: the reset above already put the agent back to dormant,
			// its blocked tool call died with the old process, and no code
			// path ever resolves the record — gcEscalationRecords skips
			// `pending` forever, so it would linger for the project's life.
			// Mark those records cancelled (GC-eligible after N days). Only
			// records for agents WE just reset — a pending record owned by a
			// live foreign process (skipForeign) stays untouched, and this
			// fresh runtime has no in-memory pending of its own yet.
			this._cancelOrphanedEscalationRecords(resetAddresses);
			for (const record of listAgents(readRegistry(this._layout.registryFile))) {
				const address = formatAgentAddress(record.type, record.id);
				if (skipForeign.has(address)) continue;
				if (pendingCount(this._layout.mailboxDir(record.type, record.id)) > 0) {
					this._scheduleMailTurn(address);
				}
			}
		} catch {
			// Never break construction; stranded state gets another chance at
			// the next runtime construction / autonomy resume.
		}
	}

	/**
	 * Startup-reconcile helper (see caller): flip on-disk `pending` escalation
	 * records to `cancelled` for agents whose stranded non-dormant state we
	 * just reset. Best-effort per record — one unreadable file never blocks
	 * the rest, and truly-live records (foreign owners, this runtime's own
	 * waits) are never in `addresses`.
	 */
	private _cancelOrphanedEscalationRecords(addresses: Set<string>): void {
		if (addresses.size === 0) return;
		const dir = this._layout.escalationsDir;
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			const file = join(dir, name);
			try {
				const record = JSON.parse(readFileSync(file, "utf8")) as EscalationRecord;
				if (record.status !== "pending" || !addresses.has(record.agent)) continue;
				record.status = "cancelled";
				record.note = "Cancelled at startup: the owning Pi process died while this escalation was pending.";
				record.resolvedAt = new Date().toISOString();
				writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
			} catch {
				// Unreadable/unwritable record — leave it; the mtime-based GC
				// fallback in gcEscalationRecords handles corrupt files.
			}
		}
	}

	/**
	 * One digest turn: pending mail → wake digest → REAL session turn →
	 * markDone AFTER the turn is durably appended (at-least-once). The
	 * end-of-turn drain re-schedules if mail arrived mid-turn (D11 hold), and
	 * oneshot final reports retire the agent at this boundary (D13).
	 */
	private async _mailTurn(address: string): Promise<void> {
		if (this._disposed) return; // shutdown — mail stays on disk (D7)
		const record = getAgent(readRegistry(this._layout.registryFile), address);
		if (!record) return; // retired while queued

		// M4: refuse to wake an agent run-owned by another LIVE Pi process in
		// the same cwd — two live sessions appending one JSONL corrupts the
		// transcript. The mail stays on disk; the owning runtime's turn-boundary
		// drain (or the next startup reconciliation) picks it up.
		if (this._foreignRunOwner(record.type, record.id) !== null) {
			this._emit({
				type: "turn-error",
				address,
				error: `Agent is run-owned by another live Pi process — mail left queued (see ${address}'s .run-owner.json).`,
			});
			return;
		}

		// D21 rail: a paused system starts NO new autonomous turns. The mail
		// stays queued on disk (pause never kills — nothing is lost) and the
		// autonomy-resumed drain re-schedules this turn.
		if (this._autonomy && !this._autonomy.canStart()) {
			this._setState(address, "dormant");
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
			if (this._agentLive(address)) {
				this._setState(address, "dormant");
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
		if (this._disposed || !this._agentLive(address)) return;

		// D15 pre-check: an agent already over a cumulative ceiling (tokens/
		// compactions) runs NO further turns — mail stays queued on disk; the
		// error envelope (sent once) tells main to decide (retire / split /
		// raise the ceiling by editing the type). Oneshots get the funeral.
		const ceilings = effectiveCeilings(handle.def.config, this._ceilings);
		const preViolation = ceilingViolation(this._vitalsOf(handle), ceilings);
		if (preViolation !== null) {
			this._setState(address, "dormant");
			this._notifyCeiling(address, record, handle, preViolation);
			if (handle.retireAfterTurn) await this.retire(address).catch(() => {});
			return;
		}

		// The turn's scheduler slot, swappable: escalations release it while
		// `waiting` and re-acquire on resolution (see _slots).
		const slot = { release: await this._scheduler.acquire() };
		if (this._disposed || !this._agentLive(address)) {
			slot.release(); // M3: retired/disposed while waiting for a slot
			return;
		}
		this._slots.set(address, slot);
		let ran = false;
		let crashed = false;
		/**
		 * Findings 1/2/5: leave the triggering mail PENDING and do NOT auto-retry
		 * it at the turn boundary. Set when the turn did not consume its digest —
		 * an explicit interrupt / shutdown abort (F1), a paused autonomy pool
		 * (F2), or a lost run-ownership claim (F5). The mail waits for the next
		 * real wake / resume-drain / the owner's boundary instead of looping.
		 */
		let leavePending = false;
		let tokensBefore = 0;
		let turnTimer: { pause(): void; resume(): void; clear(): void } | undefined;
		let unsubscribe: (() => void) | undefined;
		/** Final assistant stopReason error/aborted, captured off the event stream. */
		let turnFailure: { stopReason: "error" | "aborted"; errorMessage: string } | null = null;
		try {
			const pending = readPending(mailboxDir);
			if (pending.length === 0) return; // duplicate schedule — no-op
			const ids = pending.map((p) => p.envelope.id);

			// Finding 5: the AUTHORITATIVE, atomic run-ownership claim. The early
			// _foreignRunOwner check above is only a fast bail; THIS exclusive
			// create is the claim of record, so two processes racing from the same
			// "no live owner" observation cannot both win and append one JSONL. If
			// a live foreign process took it in the race window, stand down and
			// leave the mail pending (its owner's boundary / the next startup
			// reconciliation drains it).
			if (!this._claimRunOwner(record.type, record.id)) {
				leavePending = true;
				this._emit({
					type: "turn-error",
					address,
					error: `Lost the run-ownership claim to another live Pi process — mail left queued (${address}).`,
				});
				return;
			}

			// Finding 2: re-check AND atomically consume the autonomy budget now
			// that we hold a slot + run-ownership, BEFORE any mailbox consumption
			// or model execution. canStart() was checked before we queued for the
			// slot, but many waiters clear that gate and then an earlier turn's
			// noteTurnStart() trips the pause while they wait — each would
			// otherwise start a turn after the pool paused. The check and the
			// consume are adjacent (no await between), so consumption is atomic:
			// a tripped pool leaves the mail pending (dormant) with no double-start
			// and no double-charge (we consume exactly once, only for a turn that
			// will actually run).
			if (this._autonomy) {
				if (!this._autonomy.canStart()) {
					leavePending = true;
					return;
				}
				this._autonomy.noteTurnStart();
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
				questionLookup: (correlationId) => lookupSentQuestion(mailboxDir, correlationId),
				...(rosterChanges.length > 0 ? { rosterChanges } : {}),
			});

			ran = true;
			// D21 turn consumption (noteTurnStart) was charged ABOVE (Finding 2) —
			// before mailbox consumption, not here — so a pool that tripped while
			// this turn queued for its slot cannot start it. The consuming turn
			// still runs to completion once committed (pause never kills).
			tokensBefore = handle.session.getSessionStats().tokens.total;
			handle.trigger = pending.map((p) => p.envelope);
			handle.abortedBy = null;
			this._setState(address, "running");
			this._emit({ type: "turn-started", address });

			// D15 maxTurnMinutes: a live timer interrupts the runaway turn.
			// Pausable (m4): escalations stop the clock while `waiting` — the
			// ceiling meters RUNNING time, never an hours-long human pause
			// (D22: waiting may last forever). m5: abort() rejection is
			// swallowed — an unhandled rejection inside a timer callback would
			// crash the host process.
			if (ceilings.maxTurnMinutes !== undefined) {
				turnTimer = makePausableTimer(ceilings.maxTurnMinutes * 60_000, () => {
					handle.abortedBy = "ceiling";
					void handle.session.abort().catch(() => {});
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

			await handle.session.prompt(digest);
			await handle.session.waitForIdle();

			// M3: retire may have raced the turn — its abort unwound the prompt
			// above and the mailbox has already moved to .archive/. markDone
			// here would recreate mailbox/.done under the archived path (ghost
			// state a later spawn resurrects). retire's pending-mail bounce
			// already told the senders.
			if (!this._agentLive(address)) return;

			// Finding 1: an explicit interrupt (subagent_interrupt) or host
			// shutdown aborts the turn — session.abort() resolves prompt() with
			// stopReason "aborted", so the digest was NOT processed to completion.
			// Do NOT consume the triggering mail: leave it pending so the next
			// real wake re-delivers it (the subagent_interrupt contract: the agent
			// stays alive with its mail still pending; shutdown: the startup
			// reconciliation re-drains). leavePending also suppresses the
			// end-of-turn auto-retry — the mail waits for an EXTERNAL wake, not an
			// immediate re-run that would defeat the interrupt. A ceiling abort is
			// deliberately NOT here: it consumes the mail (below) and then parks
			// the agent, which runs no further turns until a human raises the
			// ceiling — re-delivering an over-budget digest would just re-abort.
			if (handle.abortedBy === "interrupt") {
				leavePending = true;
				return;
			}

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
					.map((env) => env.correlationId as string),
			);

			// Post-turn D13/D15 bookkeeping. Order: a ceiling abort beats the
			// generic "aborted" it caused; a fatal error beats cumulative
			// ceilings (its envelope carries the actual failure).
			const failure = turnFailure as { stopReason: "error" | "aborted"; errorMessage: string } | null;
			if (handle.abortedBy === "ceiling") {
				this._notifyCeiling(
					address,
					record,
					handle,
					`maxTurnMinutes (${ceilings.maxTurnMinutes} min) — the turn was interrupted mid-flight`,
				);
			} else if (failure !== null && failure.stopReason === "error") {
				// Fatal turn error (crash / provider failure): error envelope to
				// main; a oneshot gets its funeral like a final report (D13).
				this._emit({ type: "turn-error", address, error: failure.errorMessage });
				this._sendErrorToMain(address, `Turn failed: ${failure.errorMessage}`);
				if (record.lifetime === "oneshot") handle.retireAfterTurn = true;
			} else {
				const violation = ceilingViolation(this._vitalsOf(handle), ceilings);
				if (violation !== null) this._notifyCeiling(address, record, handle, violation);
			}
		} catch (error) {
			crashed = true;
			const message = error instanceof Error ? error.message : String(error);
			this._emit({ type: "turn-error", address, error: message });
			// A crashed turn is a fatal error envelope too; oneshot funeral (D13).
			this._sendErrorToMain(address, `Turn crashed: ${message}`);
			if (record.lifetime === "oneshot") handle.retireAfterTurn = true;
		} finally {
			turnTimer?.clear();
			if (this._turnTimers.get(address) === turnTimer) this._turnTimers.delete(address);
			unsubscribe?.();
			handle.trigger = undefined;
			handle.abortedBy = null;
			this._slots.delete(address);
			slot.release();
			this._clearRunOwner(record.type, record.id);
			const liveVitals = vitalsFrom(handle.session);
			// Registry persists WHOLE-LIFE vitals (Phase 7): base + live.
			const vitals = combineVitals(handle.baseVitals, liveVitals);
			// D21: the turn's token consumption = this session's SessionStats
			// delta across the turn, charged to the shared pool.
			if (ran) this._autonomy?.noteTokens(liveVitals.tokens - tokensBefore);
			// M3: skip all registry/mailbox writes for a mid-turn-retired agent
			// (updateRegistry no-ops on a missing record, but the reschedule
			// below would resurrect it as `queued`).
			const live = this._agentLive(address);
			if (live) {
				updateRegistry(this._layout.registryFile, (registry) => {
					const current = getAgent(registry, address);
					if (current) {
						current.state = "dormant";
						current.vitals = vitals;
						current.updatedAt = new Date().toISOString();
					}
				});
			}
			if (ran) {
				this._emit({ type: "turn-finished", address, vitals });
				if (live) this._emit({ type: "state-changed", address, state: "dormant" });
			}
			if (live && handle.retireAfterTurn) {
				// D13: the oneshot's final report is already in main's mailbox
				// (delivered before the flag was set) — the funeral loses
				// nothing; retire() bounces any UNPROCESSED pending mail (M5).
				await this.retire(address).catch(() => {});
			} else if (live && !crashed && !leavePending && !this._disposed && pendingCount(mailboxDir) > 0) {
				// Turn-boundary drain (D11): mail held during the turn gets its
				// own digest turn now. Questions the agent itself asked stay
				// outstanding — it simply goes dormant until the answer wakes it.
				// m1: after a CRASHED turn never auto-reschedule — the crash left
				// its own digest pending, and retrying immediately loops: error
				// envelope + main auto-wake every cycle until the autonomy pool
				// trips. The mail stays queued for the next EXTERNAL wake.
				// Findings 1/2/5 (leavePending): an interrupt/shutdown abort, a
				// paused pool, or a lost run-ownership claim also leave the
				// triggering mail pending and must NOT auto-retry — the next real
				// wake / resume-drain / owner boundary picks it up.
				this._scheduleMailTurn(address);
			}
		}
	}

	/** The outbound-mail port subagent tools run against (tools/sub-agent.ts). */
	private readonly _mailPort: SubagentMailPort = {
		sendFromAgent: async (options) => {
			// Hops threading (D21): a turn caused by mail sending mail is one
			// hop deeper than the deepest trigger envelope; fresh work = 0.
			const trigger = this._handles.get(options.from)?.trigger;
			const causedBy =
				trigger && trigger.length > 0
					? trigger.reduce((a, b) => (a.hops >= b.hops ? a : b))
					: undefined;
			const outcome = this._deliverer.send({
				from: options.from,
				to: options.to,
				type: options.type,
				text: options.text,
				...(options.data !== undefined ? { data: options.data } : {}),
				...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
				...(options.when !== undefined ? { when: options.when } : {}),
				...(causedBy ? { causedBy } : {}),
			});
			return {
				disposition: outcome.disposition,
				...(outcome.bounceReason !== undefined ? { bounceReason: outcome.bounceReason } : {}),
			};
		},
		noteFinalReport: (from) => {
			const record = getAgent(readRegistry(this._layout.registryFile), from);
			const handle = this._handles.get(from);
			if (record?.lifetime === "oneshot" && handle) handle.retireAfterTurn = true;
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
		const existing = this._handles.get(address);
		if (existing) {
			if (existing.typeFileHash === discovered.hash || existing.session.isStreaming) {
				return existing;
			}
			existing.session.dispose(); // idle + retuned type: rebuild below
			this._handles.delete(address);
		}
		// M3: never (re)create session state for a retired/unknown agent —
		// _buildSessionOptions mkdirs the instance dir, which would resurrect
		// a dir that retire just moved to .archive/.
		if (!this._agentLive(address)) {
			throw new Error(`Agent ${address} was retired — not building a session for it.`);
		}

		const sessionOptions = await this._buildSessionOptions(address, record, def, inherit);
		const { session } = await createAgentSession(sessionOptions);
		// M3: retire may have raced createAgentSession — drop the fresh session
		// and best-effort remove the ghost instance dir the build recreated.
		if (!this._agentLive(address)) {
			session.dispose();
			try {
				rmSync(this._layout.agentInstanceDir(record.type, record.id), { recursive: true, force: true });
			} catch {
				// Best-effort; a leftover empty dir is harmless next to the
				// alternative (a live handle for a dead agent).
			}
			throw new Error(`Agent ${address} was retired while its session was being built.`);
		}
		const handle: Handle = {
			session,
			def,
			typeFileHash: discovered.hash,
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
				this._layout.subagentsRoot,
				this._layout.globalTypeDefsDir,
				this._layout.projectTypeDefsDir,
			].map((dir) => realpathDeep(dir, realpath)),
			realpath,
		};
	}

	/**
	 * M3 liveness: the registry record still exists (retire removes it) AND no
	 * retire() is in flight for it (Finding 13 — the dir may already be archived
	 * while the record removal is pending, so a racing turn must treat it as
	 * gone before the record disappears).
	 */
	private _agentLive(address: string): boolean {
		if (this._retiring.has(address)) return false;
		return getAgent(readRegistry(this._layout.registryFile), address) !== undefined;
	}

	/**
	 * M5: error-bounce every unprocessed envelope in a retiring agent's mailbox
	 * back to its sender (user senders fall to main, the operator of last
	 * resort). Called by retire() BEFORE the registry/teams scrub so peer
	 * bounces still pass the delivery guards. Best-effort per envelope.
	 */
	private _bouncePendingMail(address: string, record: AgentRecord): void {
		let pending: ReturnType<typeof readPending>;
		try {
			pending = readPending(this._layout.mailboxDir(record.type, record.id));
		} catch {
			return;
		}
		for (const p of pending) {
			const to = p.envelope.from === USER_ADDRESS ? MAIN_ADDRESS : p.envelope.from;
			if (to === address) continue; // self-send dies with the agent
			try {
				this._deliverer.send({
					from: address,
					to,
					type: "error",
					correlationId: p.envelope.id,
					causedBy: p.envelope,
					text:
						`Delivery failure: recipient \`${address}\` retired with this message unprocessed.\n` +
						`Your message (${p.envelope.id}, ${p.envelope.type}) was NOT processed:\n${p.envelope.payload.text}`,
				});
			} catch {
				// Best-effort: one undeliverable bounce must not block the funeral.
			}
		}
	}

	// -----------------------------------------------------------------------
	// M4 run-ownership marker (two Pi processes sharing one cwd)
	//
	// D3 promises a shared roster across sessions, but registry/teams writes
	// are lock-free read-modify-write. The DANGEROUS failure is two runtimes
	// waking the same agent (two live AgentSessions appending one JSONL); the
	// marker below prevents that: a turn stamps <instanceDir>/.run-owner.json
	// (pid + runtime id) and no other runtime with a LIVE foreign pid will
	// wake that agent. Markers from dead pids are ignored and swept by the
	// startup reconciliation.
	//
	// DEVIATION (documented limitation): concurrent registry.json/teams.json
	// read-modify-write from two processes can still lose an update (e.g. two
	// simultaneous spawns of DIFFERENT agents; one roster entry's state stamp
	// wins). A cross-process advisory file lock around every updateRegistry/
	// updateTeams call would have to live in store/ (owned elsewhere) and
	// wrap sync call sites throughout — out of scope here. Lost updates are
	// self-healing (states reconcile at the next turn/startup); the JSONL
	// corruption the marker prevents is not.
	// -----------------------------------------------------------------------

	/** Path computed inline: a runtime-internal marker, kin to mailbox/.done. */
	private _runOwnerFile(type: string, id: string): string {
		return join(this._layout.agentInstanceDir(type, id), ".run-owner.json");
	}

	/** The live FOREIGN owner of an agent, or null (unowned / ours / dead pid). */
	private _foreignRunOwner(type: string, id: string): { pid: number; runtimeId: string } | null {
		try {
			const raw = JSON.parse(readFileSync(this._runOwnerFile(type, id), "utf8")) as {
				pid?: unknown;
				runtimeId?: unknown;
			};
			if (typeof raw.pid !== "number" || typeof raw.runtimeId !== "string") return null;
			if (raw.runtimeId === this._runtimeId) return null;
			// Same pid, different runtime = an earlier core in THIS process
			// (session restart) — _chains/_handles serialization already covers
			// in-process safety, and its dispose cleared real ownership.
			if (raw.pid === process.pid) return null;
			return pidAlive(raw.pid) ? { pid: raw.pid, runtimeId: raw.runtimeId } : null;
		} catch {
			return null; // no marker / unreadable → unowned
		}
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
	private _claimRunOwner(type: string, id: string): boolean {
		const file = this._runOwnerFile(type, id);
		const payload = `${JSON.stringify({ pid: process.pid, runtimeId: this._runtimeId, claimedAt: new Date().toISOString() })}\n`;
		try {
			mkdirSync(this._layout.agentInstanceDir(type, id), { recursive: true });
		} catch {
			// Best-effort; the exclusive create below fails loudly if the dir truly
			// cannot exist, and a failed claim degrades to "not owned" (return false).
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				writeFileSync(file, payload, { flag: "wx" }); // atomic exclusive create
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			}
			// The marker exists — decide whose it is.
			let owner: { pid?: unknown; runtimeId?: unknown };
			try {
				owner = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; runtimeId?: unknown };
			} catch {
				// Unreadable/garbage marker: sweep and retry the exclusive create.
				try {
					rmSync(file, { force: true });
				} catch {
					return false;
				}
				continue;
			}
			// Already ours (same runtime, or an earlier core in THIS process) —
			// refresh the marker in place and proceed.
			if (owner.runtimeId === this._runtimeId || owner.pid === process.pid) {
				try {
					writeFileSync(file, payload, "utf8");
				} catch {
					// Refresh failed but we still own it — proceed.
				}
				return true;
			}
			// A LIVE foreign process owns it: we lost the race, do not proceed.
			if (typeof owner.pid === "number" && pidAlive(owner.pid)) return false;
			// Dead foreign pid: stale marker — sweep and retry the exclusive create.
			try {
				rmSync(file, { force: true });
			} catch {
				return false;
			}
		}
		return false;
	}

	/** Remove the marker if it is ours (or unconditionally with force). */
	private _clearRunOwner(type: string, id: string, force = false): void {
		const file = this._runOwnerFile(type, id);
		try {
			if (!force) {
				const raw = JSON.parse(readFileSync(file, "utf8")) as { runtimeId?: unknown };
				if (raw.runtimeId !== this._runtimeId) return;
			}
			rmSync(file, { force: true });
		} catch {
			// Missing/unreadable — nothing to clear.
		}
	}

	/** Error envelope to main; mail failures must never break the turn pipeline. */
	private _sendErrorToMain(address: string, text: string): void {
		try {
			this._deliverer.send({ from: address, to: MAIN_ADDRESS, type: "error", text });
		} catch {
			// Nothing to do — the runtime turn-error event already fired.
		}
	}

	/**
	 * A D15 ceiling was crossed: error envelope to main (once per handle —
	 * never spam) and the D13 funeral flag for oneshots (persistent agents
	 * stay; retire remains a main-agent decision).
	 */
	private _notifyCeiling(address: string, record: AgentRecord, handle: Handle, violation: string): void {
		if (!handle.ceilingNotified) {
			handle.ceilingNotified = true;
			this._sendErrorToMain(
				address,
				`Budget ceiling crossed: ${violation}. The agent was interrupted and will run no further ` +
					"turns under this ceiling (mail queues on disk). Decide: retire it, split its purview, " +
					"or have the human raise the ceiling in the type definition.",
			);
		}
		if (record.lifetime === "oneshot") handle.retireAfterTurn = true;
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

	private _setState(address: string, state: AgentState): void {
		updateRegistry(this._layout.registryFile, (registry) => {
			const record = getAgent(registry, address);
			if (record) {
				record.state = state;
				record.updatedAt = new Date().toISOString();
			}
		});
		this._emit({ type: "state-changed", address, state });
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

/** Is a pid alive? EPERM = alive but not ours (still a live owner, M4). */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

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
					correlationId?: unknown;
				};
				if (
					(envelope.type === "answer" || envelope.type === "error") &&
					typeof envelope.correlationId === "string"
				) {
					resolved.add(envelope.correlationId);
				}
			} catch {
				// Unreadable envelope — never breaks a peek.
			}
		}
	}
	return Object.entries(index)
		.filter(([id, text]) => typeof text === "string" && !resolved.has(id))
		.map(([id, text]) => ({ id, text: text as string }))
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
