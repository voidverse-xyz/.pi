/**
 * runtime/in-process.ts — the in-process SubagentRuntime (D7).
 *
 * Each live agent is a real `AgentSession` (createAgentSession) resuming a
 * Pi-native JSONL under its instance dir (D3). Mutual exclusion is the host-scope
 * lease (D7) — NO per-agent run-owner locks. Turns are gated by the concurrency
 * scheduler (D13) and serialized per address by a chain.
 *
 * Turns are MAIL-driven (D11/D14): a wake drains the agent's mailbox, composes a
 * deterministic wake digest (answers-with-quoted-questions first), prompts the
 * session with it, and marks the mail done only after the turn completes. A
 * spawn `task` is just the first envelope (from `main`) into the mailbox.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	type ModelRegistry,
	parseSessionEntries,
	resolveCliModel,
	type SessionMessageEntry,
	SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { composeContext, type IdentityOptions, type PeerInfo } from "../context/compose.ts";
import { Deliverer, type DelivererHooks, type DeliveryOutcome, type HopsGuard } from "../mail/deliver.ts";
import { composeWakeDigest, type DigestItem } from "../mail/digest.ts";
import {
	type Address,
	type Envelope,
	type EnvelopeType,
	formatAgentAddress,
	isValidIdSegment,
	MAIN_ADDRESS,
	makeEnvelope,
	parseAddress,
	seedUlidClock,
	USER_ADDRESS,
} from "../mail/envelope.ts";
import {
	beginDelivery,
	deleteSentQuestion,
	lookupSentQuestion,
	markDone,
	maxEnvelopeId,
	peekCollectRequest,
	pendingCount,
	readPending,
	recordCollectRequest,
	takeCollectRequest,
	writeEnvelope,
} from "../mail/mailbox.ts";
import { validateAgainstSchema } from "../mail/collect.ts";
import { archiveAgentDir, type ArchivedInfo, readArchived } from "../store/archive.ts";
import {
	type AgentRecord,
	type AgentState,
	type AgentVitals,
	getAgent,
	listAgents,
	patchAgent,
	type Registry,
	readRegistry,
	removeAgent,
	upsertAgent,
	writeRegistry,
} from "../store/registry.ts";
import type { Layout } from "../store/layout.ts";
import { resolveTypeDef } from "../typedefs/discover.ts";
import type { TypeDefinition } from "../typedefs/parse.ts";
import { createSubagentTools, type SubagentMailPort } from "../tools/sub-agent.ts";
import { collapseWhitespace, flattenMessageContent, liveThinkingSummary, retainLatestThought } from "../text.ts";
import { toolSummary } from "../tui/activity.ts";
import { buildSandboxedTools } from "../sandbox/tools-filter.ts";
import { makeCommandDenyCheck, makeSystemDenyCheck } from "../sandbox/system-deny.ts";
import { type ConfirmFn, denyAllConfirm } from "../sandbox/safety-bridge.ts";
import type {
	AgentActivity,
	AgentActivityRow,
	AgentDetail,
	AwaitEnvelopeView,
	AwaitOptions,
	AwaitResult,
	CollectResult,
	InheritedDefaults,
	InterruptResult,
	PeerMode,
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
import { Scheduler } from "./scheduler.ts";

const TMP_ID_BYTES = 4;

type ModelRuntime = NonNullable<CreateAgentSessionServicesOptions["modelRuntime"]>;

export interface RuntimeOptions {
	layout: Layout;
	maxConcurrent?: number;
	/** Canonical model runtime for subagent sessions. Created lazily when omitted. */
	modelRuntime?: ModelRuntime;
	/** Main-session compatibility facade, used to mirror extension-registered providers. */
	modelRegistry?: ModelRegistry;
	settingsManager?: SettingsManager;
	projectTrusted?: () => boolean;
	/** Chain-depth guard (D21), injected by the core facade; default allows everything. */
	hopsGuard?: HopsGuard;
	/** Human confirmation for guarded tool calls (D10a); default fail-closed deny. */
	confirm?: ConfirmFn;
	/** Initial user-level peer-messaging control (D12). Default "llm" (main decides). */
	peersMode?: PeerMode;
}

interface Handle {
	session: AgentSession;
	/** Set when the current turn was aborted by an interrupt (mail stays pending). */
	aborted: boolean;
	/** Envelopes driving the current turn (for hops causedBy + collect handling). */
	trigger: Envelope[] | null;
	/** The current task anchor (an uncorrelated message id) for final-report correlation (D26'). */
	assignment: string | null;
	/** Set when the agent sent a final report this turn; a oneshot auto-retires after (D13). */
	retireAfterTurn: boolean;
	/** This type's frontmatter peer default (D12); the effective setting layers user/main over it. */
	peersDefault: boolean;
}

function vitalsFrom(session: AgentSession, state: AgentState): AgentVitals {
	const stats = session.getSessionStats();
	return {
		state,
		ctxPercent: stats.contextUsage?.percent ?? null,
		tokens: stats.tokens.total,
		cost: stats.cost,
		turns: stats.assistantMessages,
	};
}

export class InProcessRuntime implements SubagentRuntime, SubagentMailPort {
	private readonly layout: Layout;
	private readonly scheduler: Scheduler;
	private registry: Registry;
	private handles = new Map<string, Handle>();
	private buildLocks = new Map<string, Promise<Handle>>();
	private chains = new Map<string, Promise<void>>();
	/** Shared across handles so model/provider/auth state stays coherent. */
	private modelRuntime: ModelRuntime | undefined;
	private retiring = new Set<string>();
	/** Addresses with a mail turn currently in flight (per-address await liveness, M4). */
	private runningAddresses = new Set<string>();
	/** Addresses with an interrupt requested before their turn began streaming. */
	private pendingInterrupt = new Set<string>();
	/** User-level peer control (D12): "on"/"off" force it; "llm" delegates to the main agent. */
	private userPeerMode: PeerMode;
	/** Main-agent peer override, honored only when userPeerMode === "llm". null = per-type default. */
	private mainPeerOverride: boolean | null = null;
	/** Live per-agent activity for the tree widget: current tool call + count. */
	private activity = new Map<string, AgentActivity>();
	private listeners = new Set<RuntimeEventListener>();
	private activeTurns = new Set<Promise<void>>();
	private disposed = false;
	private readonly deliverer: Deliverer;
	private readonly confirm: ConfirmFn;
	private readonly systemDeny: (target: string) => { denied: boolean; reason?: string };
	private readonly systemDenyCommand: (command: string) => { denied: boolean; reason?: string };

	constructor(private readonly options: RuntimeOptions) {
		this.layout = options.layout;
		this.scheduler = new Scheduler(options.maxConcurrent);
		this.modelRuntime = options.modelRuntime;
		this.registry = readRegistry(this.layout.registryFile);
		this.confirm = options.confirm ?? denyAllConfirm;
		this.userPeerMode = options.peersMode ?? "llm";
		const protectedDirs = [this.layout.projectSubagentsRoot, this.layout.globalTypeDefsDir, this.layout.projectTypeDefsDir];
		this.systemDeny = makeSystemDenyCheck(protectedDirs, realpathSync);
		this.systemDenyCommand = makeCommandDenyCheck(protectedDirs, realpathSync, homedir());
		// Seed the ULID clock from the newest id already on disk so ids minted this
		// process sort after persisted mail even after a snapshot/clock-step (M15).
		this.seedClockFromDisk();
		const hooks: DelivererHooks = {
			mainMailboxDir: this.layout.mainMailboxDir,
			agentMailboxDir: (type, id) =>
				getAgent(this.registry, formatAgentAddress(type, id)) ? this.layout.mailboxDir(type, id) : undefined,
			agentState: (address) => getAgent(this.registry, address)?.vitals.state,
			generationOf: (address) => getAgent(this.registry, address)?.generationId,
			wake: (address) => this.scheduleMailTurn(address),
			senderMailboxDir: (from) =>
				from.kind === "agent"
					? this.layout.mailboxDir(from.type, from.id)
					: from.kind === "main"
						? this.layout.mainMailboxDir
						: undefined,
		};
		this.deliverer = new Deliverer(hooks, options.hopsGuard);
	}

	// ----------------------------------------------------------------- spawn
	async spawn(options: SpawnOptions): Promise<SpawnResult> {
		if (this.disposed) throw new Error("runtime disposed");
		const type = options.type;
		const lifetime = options.lifetime ?? "persistent";
		if (lifetime === "oneshot" && options.id !== undefined) {
			throw new Error("oneshot spawns must not pass an id (named = persistent, anonymous = disposable).");
		}
		const id = options.id ?? (lifetime === "oneshot" ? this.freshTmpId(type) : "main");
		if (!isValidIdSegment(id)) throw new Error(`Invalid instance id ${JSON.stringify(id)}.`);

		const resolved = resolveTypeDef(this.layout, type, { projectTrusted: this.projectTrusted() });
		if (!resolved.ok) throw new Error(resolved.error);

		const address = formatAgentAddress(type, id);
		const now = new Date().toISOString();
		// The label is display-only: trim, collapse whitespace, cap — never trusted as a path/key.
		const label = options.label !== undefined ? collapseWhitespace(options.label).slice(0, 80) : undefined;
		const { record, created } = upsertAgent(this.registry, {
			type,
			id,
			lifetime,
			typeFileHash: resolved.resolved.hash,
			now,
			...(label ? { label } : {}),
		});
		mkdirSync(this.layout.agentInstanceDir(type, id), { recursive: true });
		this.persist();

		let taskEnvelopeId: string | undefined;
		if (options.task !== undefined) {
			if (options.inherit !== undefined) this.inheritCache.set(address, options.inherit);
			const outcome = this.deliverer.send({ from: { kind: "main" }, to: address, type: "message", text: options.task });
			taskEnvelopeId = outcome.envelopeId;
		}

		return {
			address,
			created,
			state: record.vitals.state,
			vitals: record.vitals,
			...(taskEnvelopeId !== undefined ? { taskEnvelopeId } : {}),
		};
	}

	// ------------------------------------------------------------- send/collect
	async send(options: SendOptions): Promise<SendResult> {
		return this.sendFrom({ kind: "main" }, options);
	}

	async sendAsUser(options: SendOptions): Promise<SendResult> {
		const outcome = this.deliverer.send({
			from: { kind: "user" },
			to: options.to,
			type: options.correlationId !== undefined ? "answer" : "message",
			text: options.text,
			correlationId: options.correlationId ?? null,
		});
		// D17 transparency: FYI report to main that the user messaged this agent directly.
		const to = parseAddress(options.to);
		if (to?.kind === "agent" && outcome.delivered) {
			this.deliverer.send({ from: to, to: MAIN_ADDRESS, type: "report", text: `The user sent me a direct message: "${options.text}"` });
		}
		return toSendResult(outcome);
	}

	async collect(to: string, schema: unknown): Promise<CollectResult> {
		const outcome = this.deliverer.send({
			from: { kind: "main" },
			to,
			type: "message",
			text: "The main agent requests a structured result (a collect request). Fulfil it with the `report` tool, `data` conforming to the schema, and this request's correlationId.",
			data: { collectSchema: schema },
		});
		if (outcome.delivered) {
			recordCollectRequest(this.layout.mainMailboxDir, outcome.envelopeId, schema, to);
		}
		return { requested: true, requestId: outcome.envelopeId, ...(outcome.recipientState ? { recipientState: outcome.recipientState } : {}) };
	}

	private sendFrom(from: Address, options: SendOptions): SendResult {
		const outcome = this.deliverer.send({
			from,
			to: options.to,
			type: options.correlationId !== undefined ? "answer" : "message",
			text: options.text,
			correlationId: options.correlationId ?? null,
		});
		return toSendResult(outcome);
	}

	/** SubagentMailPort: mail originated by a subagent's tool during its turn. */
	sendFromAgent(from: string, opts: { to: string; type: EnvelopeType; text: string; data?: unknown; final?: boolean; correlationId?: string | null }): DeliveryOutcome {
		const fromAddress = parseAddress(from);
		if (!fromAddress || fromAddress.kind !== "agent") throw new Error(`invalid agent sender ${JSON.stringify(from)}`);
		const handle = this.handles.get(from);
		// Peer-messaging gate (D12): block any agent→agent send when this sender's
		// effective peer setting is off. Enforced live here (not just by hiding the
		// tool), so a toggle takes effect immediately even for a session built while
		// peers were on. Upward channels (to main) are always allowed.
		if (parseAddress(opts.to)?.kind === "agent" && !this.effectivePeers(handle?.peersDefault ?? true)) {
			return {
				delivered: false,
				disposition: "bounced",
				envelopeId: "(peer messaging disabled)",
				bounceReason: "peer messaging is disabled — report to the main agent, which coordinates the team",
			};
		}
		const causedBy = handle?.trigger && handle.trigger.length > 0 ? handle.trigger.reduce((a, b) => (b.hops > a.hops ? b : a)) : null;
		// A final report with no explicit correlation is correlated to the current
		// assignment so an await on the task anchor can match it (D26'). A oneshot
		// auto-retires after its final report (D13).
		let correlationId = opts.correlationId ?? null;
		if (opts.type === "report" && opts.final && correlationId === null && handle?.assignment) {
			correlationId = handle.assignment;
		}
		if (opts.type === "report" && opts.final && handle) {
			const record = getAgent(this.registry, from);
			if (record?.lifetime === "oneshot") handle.retireAfterTurn = true;
		}
		return this.deliverer.send({
			from: fromAddress,
			to: opts.to,
			type: opts.type,
			text: opts.text,
			...(opts.data !== undefined ? { data: opts.data } : {}),
			...(opts.final !== undefined ? { final: opts.final } : {}),
			correlationId,
			causedBy,
		});
	}

	// ----------------------------------------------------------------- status / peek
	async status(): Promise<RosterEntry[]> {
		return listAgents(this.registry).map((record) => this.rosterEntry(record));
	}

	async peek(address: string, tail = 20): Promise<AgentDetail | null> {
		const record = getAgent(this.registry, address);
		if (!record) return null;
		const sessionFile = this.latestSessionFile(record.type, record.id) ?? null;
		return {
			...this.rosterEntry(record),
			typeFileHash: record.typeFileHash,
			createdAt: record.createdAt,
			sessionFile,
			tail: sessionFile ? readTranscriptTail(sessionFile, tail) : [],
		};
	}

	// ----------------------------------------------------------------- steer / interrupt
	async steer(to: string, text: string): Promise<SteerResult> {
		const handle = this.handles.get(to);
		if (!handle || !handle.session.isStreaming) return { steered: false };
		await handle.session.steer(text);
		return { steered: true };
	}

	async interrupt(to: string): Promise<InterruptResult> {
		const handle = this.handles.get(to);
		if (handle?.session.isStreaming) {
			handle.aborted = true;
			await handle.session.abort();
			return { interrupted: true };
		}
		// The agent is queued/waking (a turn scheduled, but its session isn't streaming
		// yet): record the intent so mailTurn stands the turn down once the handle is
		// built, instead of silently no-op'ing the interrupt.
		const record = getAgent(this.registry, to);
		if (record && (record.vitals.state === "queued" || record.vitals.state === "running")) {
			this.pendingInterrupt.add(to);
			return { interrupted: true };
		}
		return { interrupted: false };
	}

	async retire(to: string): Promise<RetireResult> {
		const record = getAgent(this.registry, to);
		if (!record) return { retired: true, archiveDir: null };
		this.retiring.add(to);
		try {
			const handle = this.handles.get(to);
			if (handle?.session.isStreaming) {
				handle.aborted = true;
				await handle.session.abort();
			}
			this.handles.delete(to);
			// Drop any in-flight build lock + stale per-address caches so a build that
			// resolves after this point cannot re-install a session for the gone agent
			// (the ensureHandle guard also refuses to install once the agent is removed),
			// and a respawn on the same address doesn't inherit the prior incarnation's
			// cached defaults/activity (H3 / address-reuse staleness).
			this.buildLocks.delete(to);
			this.inheritCache.delete(to);
			this.activity.delete(to);
			this.pendingInterrupt.delete(to);
			// NB: we deliberately do NOT await this.chains.get(to) — a oneshot
			// auto-retire calls retire() from inside that very turn's tail, so
			// awaiting it would deadlock. The `retiring` flag + abort() above make
			// any in-flight/next turn stand down.
			// Bounce pending PEER mail so peers don't strand (D26); owner/user mail is dropped quietly.
			const mailboxDir = this.layout.mailboxDir(record.type, record.id);
			for (const p of readPending(mailboxDir)) {
				const from = parseAddress(p.envelope.from);
				if (from?.kind === "agent") {
					const peerBox = this.layout.mailboxDir(from.type, from.id);
					if (getAgent(this.registry, p.envelope.from)) {
						writeEnvelope(peerBox, makeEnvelope({ from: MAIN_ADDRESS, to: from, type: "error", text: `\`${to}\` retired before processing your message.`, hops: p.envelope.hops }));
						if (getAgent(this.registry, p.envelope.from)?.vitals.state === "dormant") this.scheduleMailTurn(p.envelope.from);
					}
				}
			}
			removeAgent(this.registry, to);
			this.persist();
			const archiveDir = archiveAgentDir(this.layout, record.type, record.id, new Date().toISOString());
			this.emit({ type: "agent-retired", address: to, archiveDir });
			return { retired: true, archiveDir };
		} finally {
			this.retiring.delete(to);
		}
	}

	/** Retired agents on disk in .archive/ (D13). */
	archived(): ArchivedInfo[] {
		return readArchived(this.layout);
	}

	// ----------------------------------------------------------------- peer control (D12)
	/**
	 * The EFFECTIVE peer setting for an instance whose type default is `peersDefault`.
	 * Precedence: user override (on/off) wins; otherwise the main agent's override; if
	 * the main leaves it auto (null), the type's frontmatter default.
	 */
	private effectivePeers(peersDefault: boolean): boolean {
		if (this.userPeerMode === "on") return true;
		if (this.userPeerMode === "off") return false;
		return this.mainPeerOverride ?? peersDefault;
	}

	/** Refresh tools + prose for DORMANT agents so a peer-setting change lands on their next wake. */
	private refreshDormantHandles(): void {
		for (const address of [...this.handles.keys()]) {
			if (this.runningAddresses.has(address)) continue; // running agents rebuild after their turn
			this.handles.delete(address);
			this.buildLocks.delete(address);
		}
	}

	/** User-level control: "on"/"off" force peer messaging, "llm" delegates to the main agent. */
	setUserPeerMode(mode: PeerMode): void {
		if (this.userPeerMode === mode) return;
		this.userPeerMode = mode;
		this.refreshDormantHandles();
	}

	/** Main-agent override, honored only while userPeerMode === "llm". null = per-type default. */
	setMainPeerOverride(value: boolean | null): void {
		if (this.mainPeerOverride === value) return;
		this.mainPeerOverride = value;
		this.refreshDormantHandles();
	}

	/** Current peer-control state (for the tool result, command feedback, and status). */
	peerState(): { userMode: PeerMode; mainOverride: boolean | null; userControls: boolean } {
		return { userMode: this.userPeerMode, mainOverride: this.mainPeerOverride, userControls: this.userPeerMode !== "llm" };
	}

	/** Live activity and usage for currently-working agents (tree widget). */
	activitySnapshot(): AgentActivityRow[] {
		return [...this.activity.entries()]
			.map(([address, a]) => {
				const record = getAgent(this.registry, address);
				const stats = this.handles.get(address)?.session.getSessionStats();
				// A null live percentage (notably just after compaction) means unknown;
				// preserve it rather than falling back to a stale pre-compaction value.
				const ctxPercent = stats?.contextUsage === undefined ? (record?.vitals.ctxPercent ?? null) : stats.contextUsage.percent;
				const tokens = stats?.tokens.total ?? record?.vitals.tokens ?? 0;
				const unread = record ? pendingCount(this.layout.mailboxDir(record.type, record.id)) : 0;
				return {
					address,
					...(record?.label !== undefined ? { label: record.label } : {}),
					...a,
					ctxPercent,
					tokens,
					unread,
				};
			})
			.sort((x, y) => x.address.localeCompare(y.address));
	}

	/**
	 * Explicit in-run join (D24'/D26'/D27'): block until a matching final/collect
	 * report from `to` correlated to `anchorId` lands in the main mailbox
	 * (consumed on match), or the agent needs attention (question/escalation/error
	 * — returned without consuming so it can't deadlock), or it retired, or the
	 * timeout elapses (consumes nothing).
	 */
	async awaitResult(options: AwaitOptions): Promise<AwaitResult> {
		const { to, waitFor, anchorId } = options;
		const mainbox = this.layout.mainMailboxDir;
		const deadline = Date.now() + (options.timeoutSeconds ?? 300) * 1000;
		for (;;) {
			if (options.signal?.aborted) return { status: "timeout", to, anchorId };
			const pending = readPending(mainbox);

			const terminal = pending.find(
				(p) =>
					p.envelope.type === "report" &&
					p.envelope.from === to &&
					p.envelope.correlationId === anchorId &&
					(waitFor === "final" ? p.envelope.payload.final === true : true),
			);
			if (terminal) {
				markDone(mainbox, terminal.envelope.id);
				const result: AwaitResult = { status: "completed", to, anchorId, report: envView(terminal.envelope) };
				if (waitFor === "collect") {
					const schema = peekCollectRequest(mainbox, anchorId, to);
					if (schema !== undefined) {
						result.validation = validateAgainstSchema(terminal.envelope.payload.data, schema);
						takeCollectRequest(mainbox, anchorId);
					}
				}
				return result;
			}

			const attention = pending.find(
				(p) => p.envelope.from === to && (p.envelope.type === "question" || p.envelope.type === "escalation" || p.envelope.type === "error"),
			);
			if (attention) return { status: "attention", to, anchorId, attention: envView(attention.envelope) };

			// Retired detection keys on the TARGET's own liveness, not the fleet-wide
			// turn count — otherwise any other busy agent would mask retirement and
			// force this await to spin to timeout (M4).
			if (!getAgent(this.registry, to) && !this.runningAddresses.has(to)) return { status: "retired", to, anchorId };
			if (Date.now() >= deadline) return { status: "timeout", to, anchorId };
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
	}

	// ----------------------------------------------------------------- events / dispose
	onEvent(listener: RuntimeEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async whenIdle(): Promise<void> {
		while (this.activeTurns.size > 0) await Promise.allSettled([...this.activeTurns]);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const aborts: Promise<void>[] = [];
		for (const handle of this.handles.values()) if (handle.session.isStreaming) aborts.push(handle.session.abort().catch(() => {}));
		await Promise.allSettled(aborts);
		await this.whenIdle();
		this.handles.clear();
		this.listeners.clear();
		this.pendingInterrupt.clear();
	}

	// ----------------------------------------------------------------- internals
	private readonly inheritCache = new Map<string, InheritedDefaults>();

	private projectTrusted(): boolean {
		return this.options.projectTrusted ? this.options.projectTrusted() : true;
	}

	private freshTmpId(type: string): string {
		for (;;) {
			const id = `tmp-${randomHex(TMP_ID_BYTES)}`;
			if (!getAgent(this.registry, formatAgentAddress(type, id)) && !existsSync(this.layout.agentInstanceDir(type, id))) return id;
		}
	}

	private persist(): void {
		writeRegistry(this.layout.registryFile, this.registry);
	}

	/** Seed the monotonic ULID clock from the newest envelope id across all mailboxes. */
	private seedClockFromDisk(): void {
		const boxes = [this.layout.mainMailboxDir, ...listAgents(this.registry).map((r) => this.layout.mailboxDir(r.type, r.id))];
		let max: string | null = null;
		for (const box of boxes) {
			const id = maxEnvelopeId(box);
			if (id !== null && (max === null || id > max)) max = id;
		}
		if (max !== null) seedUlidClock(max);
	}

	private emit(event: RuntimeEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private setState(address: string, state: AgentState): void {
		const record = getAgent(this.registry, address);
		if (!record || record.vitals.state === state) return;
		patchAgent(this.registry, address, { vitals: { state } });
		this.persist();
		this.emit({ type: "state-changed", address, state });
	}

	private rosterEntry(record: AgentRecord): RosterEntry {
		const address = formatAgentAddress(record.type, record.id);
		return {
			address,
			type: record.type,
			id: record.id,
			state: record.vitals.state,
			lifetime: record.lifetime,
			purview: record.label ?? record.id,
			...(record.label !== undefined ? { label: record.label } : {}),
			vitals: record.vitals,
			unread: pendingCount(this.layout.mailboxDir(record.type, record.id)),
			updatedAt: record.lastActiveAt,
		};
	}

	private identityFor(address: string, record: AgentRecord): IdentityOptions {
		const peers: PeerInfo[] = listAgents(this.registry)
			.filter((other) => formatAgentAddress(other.type, other.id) !== address)
			.map((other) => ({ address: formatAgentAddress(other.type, other.id), purview: other.label ?? other.id }));
		return { address, purview: record.label ?? record.id, peers, lifetime: record.lifetime };
	}

	private latestSessionFile(type: string, id: string): string | undefined {
		const dir = this.layout.agentInstanceDir(type, id);
		if (!existsSync(dir)) return undefined;
		const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
		const last = files[files.length - 1];
		return last ? join(dir, last) : undefined;
	}

	/** Schedule a mail-drain turn for an address, serialized per address. */
	private scheduleMailTurn(address: string): void {
		const prev = this.chains.get(address) ?? Promise.resolve();
		const next = prev.then(() => this.trackedMailTurn(address));
		this.chains.set(address, next);
	}

	private trackedMailTurn(address: string): Promise<void> {
		this.runningAddresses.add(address);
		const turn = this.mailTurn(address).catch((error) => {
			this.emit({ type: "turn-error", address, error: error instanceof Error ? error.message : String(error) });
		}).finally(() => {
			this.activeTurns.delete(turn);
			this.runningAddresses.delete(address);
		});
		this.activeTurns.add(turn);
		return turn;
	}

	private async mailTurn(address: string): Promise<void> {
		if (this.disposed || this.retiring.has(address)) return;
		const record = getAgent(this.registry, address);
		if (!record) return;
		const mailboxDir = this.layout.mailboxDir(record.type, record.id);
		const pending = readPending(mailboxDir);
		if (pending.length === 0) {
			this.setState(address, "dormant");
			return;
		}

		const resolved = resolveTypeDef(this.layout, record.type, { projectTrusted: this.projectTrusted() });
		if (!resolved.ok) {
			this.emit({ type: "turn-error", address, error: resolved.error });
			return; // leave mail pending; a fixed type file + next wake retries
		}
		const def = resolved.resolved.definition;
		if (record.typeFileHash !== resolved.resolved.hash) {
			patchAgent(this.registry, address, { typeFileHash: resolved.resolved.hash });
			this.persist();
			// Rebuild with the retuned constitution — stand the old session down first
			// so we don't drop a live AgentSession (and its open JSONL fd) on the floor.
			const stale = this.handles.get(address);
			if (stale) void stale.session.abort().catch(() => {});
			this.handles.delete(address);
		}

		this.setState(address, "queued");
		const release = await this.scheduler.acquire();
		let leavePending = false;
		let turnHandle: Handle | undefined;
		try {
			// A retire/dispose that arrived while we waited for a scheduler slot must be
			// observed here — otherwise we'd build + prompt a to-be-retired agent.
			if (this.disposed || this.retiring.has(address) || !getAgent(this.registry, address)) {
				leavePending = true;
				return;
			}
			let handle: Handle;
			try {
				handle = await this.ensureHandle(address, record, def, this.inheritCache.get(address));
			} catch (error) {
				// Handle build failed (e.g. unknown model): surface it, reset the state
				// off "queued" so the agent isn't wedged, and leave the mail pending so a
				// fixed type file + next wake retries. Also notify main: an internal event
				// alone is invisible to the LLM and otherwise makes team_await time out
				// with no actionable diagnosis.
				const message = error instanceof Error ? error.message : String(error);
				this.setState(address, "dormant");
				this.emit({ type: "turn-error", address, error: message });
				this.deliverer.send({
					from: { kind: "agent", type: record.type, id: record.id },
					to: MAIN_ADDRESS,
					type: "error",
					text: `Turn failed before start: ${message}`,
				});
				leavePending = true;
				return;
			}
			// The agent may have been retired/disposed during the async build; if so the
			// handle was NOT installed (ensureHandle guard) — stand it down and bail.
			if (this.disposed || this.retiring.has(address) || this.handles.get(address) !== handle) {
				if (this.handles.get(address) !== handle) void handle.session.abort().catch(() => {});
				leavePending = true;
				return;
			}
			// An interrupt requested before streaming began: stand the turn down now,
			// leave its mail pending, and go dormant (don't linger in "queued").
			if (this.pendingInterrupt.delete(address)) {
				leavePending = true;
				this.setState(address, "dormant");
				this.emit({ type: "turn-finished", address, vitals: getAgent(this.registry, address)?.vitals ?? vitalsFrom(handle.session, "dormant") });
				return;
			}
			turnHandle = handle;
			handle.trigger = pending.map((p) => p.envelope);
			handle.aborted = false;
			handle.retireAfterTurn = false;
			// The current assignment (for final-report correlation, D26'): the first
			// uncorrelated task message (from main or a peer) driving this turn.
			const task = pending.find((p) => p.envelope.type === "message" && p.envelope.correlationId === null && p.envelope.from !== USER_ADDRESS);
			if (task) handle.assignment = task.envelope.id;
			this.setState(address, "running");
			this.emit({ type: "turn-started", address });

			for (const p of pending) beginDelivery(mailboxDir, p.envelope.id);
			const digest = composeWakeDigest({
				items: pending.map((p): DigestItem => ({ envelope: p.envelope, redelivered: p.redelivered })),
				questionLookup: (correlationId, from) => lookupSentQuestion(mailboxDir, correlationId, from),
			});

			this.activity.set(address, { tool: "", summary: "thinking…", toolUses: 0 });
			let failure: { stopReason: string; message: string } | null = null;
			let thinkingText = "";
			let latestThought = "";
			const activeTools = new Map<string, { tool: string; summary: string }>();
			const publishActivity = (next: AgentActivity): void => {
				this.activity.set(address, next);
				this.emit({ type: "state-changed", address, state: "running" });
			};
			const publishThinking = (): void => {
				latestThought = retainLatestThought(latestThought, thinkingText);
				const prev = this.activity.get(address);
				if (!prev || activeTools.size > 0) return;
				// The widget polls at 400ms, so avoid firing one runtime event per token.
				this.activity.set(address, { ...prev, tool: "", summary: liveThinkingSummary(latestThought) });
			};
			const unsubscribe = handle.session.subscribe((event) => {
				if (event.type === "message_update") {
					const streamEvent = event.assistantMessageEvent;
					if (streamEvent.type === "thinking_start") {
						thinkingText = "";
						return;
					}
					if (streamEvent.type === "thinking_delta") {
						thinkingText = `${thinkingText}${streamEvent.delta}`.slice(-4096);
						publishThinking();
						return;
					}
					if (streamEvent.type === "thinking_end") {
						thinkingText = streamEvent.content.slice(-4096);
						publishThinking();
					}
					return;
				}
				if (event.type === "tool_execution_start") {
					const prev = this.activity.get(address);
					if (!prev) return;
					const tool = event.toolName;
					const current = { tool, summary: toolSummary(tool, event.args) };
					activeTools.set(event.toolCallId, current);
					publishActivity({ ...prev, ...current, toolUses: prev.toolUses + 1 });
					return;
				}
				if (event.type === "tool_execution_end") {
					const prev = this.activity.get(address);
					if (!prev) return;
					activeTools.delete(event.toolCallId);
					const current = [...activeTools.values()].at(-1);
					publishActivity(current
						? { ...prev, ...current }
						: { ...prev, tool: "", summary: liveThinkingSummary(latestThought) });
					return;
				}
				if (event.type !== "agent_end") return;
				for (const message of event.messages) {
					const m = message as { role?: string; stopReason?: string; errorMessage?: string };
					if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
						failure = { stopReason: m.stopReason, message: m.errorMessage ?? "(no error message)" };
					}
				}
			});
			try {
				await handle.session.prompt(digest);
				await handle.session.waitForIdle();
			} finally {
				unsubscribe();
			}

			// Re-read `failure` through a const: it is assigned inside the subscribe
			// callback, so TS's flow analysis still sees the `null` initializer here.
			const turnFailure = failure as { stopReason: string; message: string } | null;
			if (this.disposed || handle.aborted || turnFailure?.stopReason === "aborted") {
				// interrupt/shutdown: leave the triggering mail pending, don't auto-retry (v1 finding #1)
				leavePending = true;
			} else {
				for (const p of pending) {
					markDone(mailboxDir, p.envelope.id);
					if (p.envelope.type === "answer" && p.envelope.correlationId) deleteSentQuestion(mailboxDir, p.envelope.correlationId);
				}
			}

			const vitals = vitalsFrom(handle.session, "dormant");
			patchAgent(this.registry, address, { vitals, lastActiveAt: new Date().toISOString() });
			this.persist();
			handle.trigger = null;

			if (turnFailure?.stopReason === "error") {
				this.emit({ type: "turn-error", address, error: turnFailure.message });
				// surface a fatal error to main
				this.deliverer.send({ from: { kind: "agent", type: record.type, id: record.id }, to: MAIN_ADDRESS, type: "error", text: `Turn failed: ${turnFailure.message}` });
			}
			this.activity.delete(address);
			this.emit({ type: "state-changed", address, state: "dormant" });
			this.emit({ type: "turn-finished", address, vitals });
			if (!leavePending) handle.assignment = null;
		} finally {
			this.activity.delete(address);
			// Consume any interrupt intent that landed in the sliver where the session
			// was prompted but not yet streaming (isStreaming still false → interrupt()
			// records intent instead of aborting). Left in the set, the stale flag would
			// stand down the NEXT, unrelated turn for this address.
			this.pendingInterrupt.delete(address);
			release();
		}

		// A oneshot that sent its final report this turn auto-retires (D13). Read the
		// flag off the LOCAL handle we ran — not this.handles, which may have been
		// replaced/cleared during the turn (M5).
		if (!leavePending && turnHandle?.retireAfterTurn) {
			await this.retire(address);
			return;
		}
		// More mail arrived during the turn (held, never interrupts) → drain again.
		if (!leavePending && !this.disposed && pendingCount(mailboxDir) > 0) this.scheduleMailTurn(address);
	}

	private async ensureHandle(address: string, record: AgentRecord, def: TypeDefinition, inherit?: InheritedDefaults): Promise<Handle> {
		const existing = this.handles.get(address);
		if (existing) return existing;
		const pending = this.buildLocks.get(address);
		if (pending) return pending;
		const build = this.buildHandle(address, record, def, inherit)
			.then((handle) => {
				// If the agent was retired (or the runtime disposed) while this session
				// was being built, do NOT install it — stand it down instead, so we don't
				// leak a live session for a gone agent. The caller (mailTurn) re-checks
				// liveness after ensureHandle and will leave the mail pending.
				if (this.disposed || this.retiring.has(address) || !getAgent(this.registry, address)) {
					void handle.session.abort().catch(() => {});
					return handle;
				}
				this.handles.set(address, handle);
				return handle;
			})
			.finally(() => this.buildLocks.delete(address));
		this.buildLocks.set(address, build);
		return build;
	}

	private async buildHandle(address: string, record: AgentRecord, def: TypeDefinition, inherit?: InheritedDefaults): Promise<Handle> {
		const layout = this.layout;
		const instanceDir = layout.agentInstanceDir(record.type, record.id);
		mkdirSync(instanceDir, { recursive: true });

		const latest = this.latestSessionFile(record.type, record.id);
		const sessionManager = latest ? SessionManager.open(latest, instanceDir, layout.cwd) : SessionManager.create(layout.cwd, instanceDir);

		const peersDefault = def.config.peers !== false;
		const peersEnabled = this.effectivePeers(peersDefault);
		const composed = composeContext(def, { ...this.identityFor(address, record), peersEnabled });
		const services = await createAgentSessionServices({
			cwd: layout.cwd,
			agentDir: layout.agentDir,
			...(this.options.settingsManager ? { settingsManager: this.options.settingsManager } : {}),
			...(this.modelRuntime ? { modelRuntime: this.modelRuntime } : {}),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: !def.config.projectContext,
				appendSystemPrompt: composed.appendSystemPrompt,
			},
		});
		this.modelRuntime = services.modelRuntime;

		// Extension-registered providers live on the main session's compatibility
		// facade. Mirror their public configs into the subagent runtime so custom
		// providers keep working without reaching into ModelRegistry internals.
		const registry = this.options.modelRegistry;
		if (registry) {
			for (const providerId of registry.getRegisteredProviderIds()) {
				const config = registry.getRegisteredProviderConfig(providerId);
				if (config) services.modelRuntime.registerProvider(providerId, config);
			}
		}

		const sessionOptions: CreateAgentSessionFromServicesOptions = {
			services,
			sessionManager,
			noTools: "builtin",
			customTools: [
				...createSubagentTools(address, this, { peers: peersEnabled }),
				...buildSandboxedTools(def.config, layout.cwd, {
					systemDeny: (path) => this.systemDeny(path),
					systemDenyCommand: (command) => this.systemDenyCommand(command),
					// Surface the human-confirmation pause as `waiting` for the widget,
					// then restore `running` for the rest of the turn.
					confirm: async (request) => {
						this.setState(address, "waiting");
						try {
							return await this.confirm({ agent: address, ...request });
						} finally {
							if (this.handles.get(address)?.session.isStreaming) this.setState(address, "running");
						}
					},
				}),
			],
		};
		const model = this.resolveModel(def, inherit, services.modelRuntime);
		if (model) sessionOptions.model = model;
		const thinkingLevel = def.config.thinking ?? inherit?.thinkingLevel;
		if (thinkingLevel !== undefined) sessionOptions.thinkingLevel = thinkingLevel;

		const { session } = await createAgentSessionFromServices(sessionOptions);
		return { session, aborted: false, trigger: null, assignment: null, retireAfterTurn: false, peersDefault };
	}

	private resolveModel(
		def: TypeDefinition,
		inherit: InheritedDefaults | undefined,
		modelRuntime: ModelRuntime,
	): CreateAgentSessionFromServicesOptions["model"] | undefined {
		const ref = def.config.model ?? inherit?.modelRef;
		if (ref === undefined) return undefined;
		const resolved = resolveCliModel({ cliModel: ref, modelRuntime });
		if (!resolved.model) {
			if (def.config.model !== undefined) throw new Error(resolved.error ?? `Type "${def.config.name}": unknown model "${ref}".`);
			return undefined;
		}
		return resolved.model;
	}
}

function envView(envelope: Envelope): AwaitEnvelopeView {
	return {
		id: envelope.id,
		type: envelope.type as AwaitEnvelopeView["type"],
		text: envelope.payload.text,
		correlationId: envelope.correlationId,
		...(envelope.payload.data !== undefined ? { data: envelope.payload.data } : {}),
		...(envelope.payload.final !== undefined ? { final: envelope.payload.final } : {}),
	};
}

function toSendResult(outcome: DeliveryOutcome): SendResult {
	return {
		delivery: outcome.disposition === "woken" ? "delivered" : "queued",
		disposition: outcome.disposition,
		...(outcome.recipientState ? { recipientState: outcome.recipientState } : {}),
		envelopeId: outcome.envelopeId,
		...(outcome.bounceReason ? { bounceReason: outcome.bounceReason } : {}),
	};
}

function randomHex(bytes: number): string {
	let out = "";
	for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
	return out;
}

function readTranscriptTail(sessionFile: string, n: number): TranscriptEntry[] {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const messages = parseSessionEntries(content).filter((entry): entry is SessionMessageEntry => "type" in entry && entry.type === "message");
	return messages.slice(-n).map((entry) => ({
		role: entry.message.role,
		text: flattenMessageContent((entry.message as { content?: unknown }).content, true),
		timestamp: typeof (entry as { timestamp?: unknown }).timestamp === "string" ? (entry as { timestamp: string }).timestamp : "",
	}));
}
