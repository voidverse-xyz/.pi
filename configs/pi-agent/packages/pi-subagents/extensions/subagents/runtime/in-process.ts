/**
 * runtime/in-process.ts — the in-process SubagentRuntime.
 *
 * Each live agent is a real `AgentSession` (createAgentSession) resuming a
 * Pi-native JSONL under its instance dir. Mutual exclusion is the host-scope
 * lease — NO per-agent run-owner locks. Turns are gated by the concurrency
 * scheduler and serialized per address by a chain.
 *
 * Turns are MAIL-driven: a wake drains the agent's mailbox, composes a
 * deterministic wake digest, prompts the session with it, and marks the mail
 * done only after the turn completes. A spawn `task` is just the first
 * envelope (from `main`) into the mailbox.
 *
 * Ad-hoc agents (reserved type "adhoc") resolve their constitution from the
 * instance-local `def.md` written at spawn — the same parse/hash/rebuild
 * pipeline as library type defs, so persistence and live-retune are identical.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	type ModelRegistry,
	resolveCliModel,
	SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { composeContext } from "../context/compose.ts";
import { Deliverer, type DelivererHooks, type DeliveryOutcome } from "../mail/deliver.ts";
import { composeWakeDigest, type DigestItem } from "../mail/digest.ts";
import {
	type Envelope,
	formatAgentAddress,
	isValidIdSegment,
	MAIN_ADDRESS,
	parseAddress,
	seedUlidClock,
	terminalTaskAnchors,
	USER_ADDRESS,
} from "../mail/envelope.ts";
import {
	beginDelivery,
	markDone,
	maxEnvelopeId,
	pendingCount,
	readPending,
} from "../mail/mailbox.ts";
import { archiveAgentDir, type ArchivedInfo, readArchived } from "../store/archive.ts";
import { closeAllFor, closeOpenTask, readOpenTasks, recordOpenTask } from "../store/open-tasks.ts";
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
import { atomicWriteText } from "../store/atomic.ts";
import type { Layout } from "../store/layout.ts";
import { ADHOC_TYPE, composeAdhocDef, resolveAdhocDef, type ResolveResult, resolveTypeDef, sha256 } from "../typedefs/discover.ts";
import { parseTypeFile, type TypeDefinition } from "../typedefs/parse.ts";
import { createSubagentTools, type SubagentMailPort } from "../tools/sub-agent.ts";
import { buildSandboxedTools, selectToolNames } from "../sandbox/tools-filter.ts";
import { makeCommandDenyCheck, makeSystemDenyCheck } from "../sandbox/system-deny.ts";
import { type ConfirmFn, denyAllConfirm } from "../sandbox/safety-bridge.ts";
import { readTranscriptTail } from "../session-read.ts";
import { ellipsize, labelFromSource, liveThinkingSummary, MAX_LABEL_CHARS, retainLatestThought } from "../text.ts";
import type {
	AgentActivity,
	AgentActivityRow,
	AgentDetail,
	AwaitOptions,
	AwaitResult,
	AwaitTarget,
	CancelResult,
	EnvelopeView,
	InheritedDefaults,
	OpenTaskEntry,
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
	TargetOutcome,
} from "./types.ts";
import { Scheduler } from "./scheduler.ts";

const TMP_ID_BYTES = 4;
const AWAIT_POLL_MS = 40;
const DEFAULT_AWAIT_TIMEOUT_S = 300;

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
	/** Human confirmation for guarded tool calls; default fail-closed deny. */
	confirm?: ConfirmFn;
}

interface Handle {
	session: AgentSession;
	/** Set when the current turn was aborted by a cancel (mail stays pending). */
	aborted: boolean;
	/** Envelopes driving the current turn. */
	trigger: Envelope[] | null;
	/** The current task anchor (an uncorrelated message id) for final-report correlation. */
	assignment: string | null;
	/** Set when the agent sent a final report this turn; a oneshot auto-retires after. */
	retireAfterTurn: boolean;
}

/** A terminal assistant failure observed on agent_end (stopReason error/aborted). */
interface TurnFailure {
	stopReason: string;
	message: string;
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
	/** Addresses with a mail turn currently in flight (per-address await liveness). */
	private runningAddresses = new Set<string>();
	/** Addresses with a cancel requested before their turn began streaming. */
	private pendingCancel = new Set<string>();
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
		const protectedDirs = [this.layout.projectSubagentsRoot, this.layout.globalTypeDefsDir, this.layout.projectTypeDefsDir];
		this.systemDeny = makeSystemDenyCheck(protectedDirs, realpathSync);
		this.systemDenyCommand = makeCommandDenyCheck(protectedDirs, realpathSync, homedir());
		// Seed the ULID clock from the newest id already on disk so ids minted this
		// process sort after persisted mail even after a snapshot/clock-step.
		this.seedClockFromDisk();
		const hooks: DelivererHooks = {
			mainMailboxDir: this.layout.mainMailboxDir,
			agentMailboxDir: (type, id) =>
				getAgent(this.registry, formatAgentAddress(type, id)) ? this.layout.mailboxDir(type, id) : undefined,
			agentState: (address) => getAgent(this.registry, address)?.vitals.state,
			generationOf: (address) => getAgent(this.registry, address)?.generationId,
			wake: (address) => this.scheduleMailTurn(address),
		};
		this.deliverer = new Deliverer(hooks);
	}

	// ----------------------------------------------------------------- spawn
	async spawn(options: SpawnOptions): Promise<SpawnResult> {
		if (this.disposed) throw new Error("runtime disposed");
		const explicitLabel = normalizeLabel(options.label);
		const isAdhoc = options.prompt !== undefined;
		if (isAdhoc === (options.type !== undefined)) {
			throw new Error("Pass exactly one of `type` (a library def) or `prompt` (an ad-hoc agent).");
		}
		if (!isAdhoc && (options.model !== undefined || options.thinking !== undefined || options.tools !== undefined)) {
			throw new Error("model/thinking/tools are ad-hoc-only spawn fields — typed agents configure them in their def's frontmatter.");
		}
		const type = isAdhoc ? ADHOC_TYPE : options.type!;
		const lifetime = options.lifetime ?? (isAdhoc ? "oneshot" : "persistent");
		if (lifetime === "oneshot" && options.id !== undefined) {
			throw new Error("oneshot spawns must not pass an id (named = persistent, anonymous = disposable).");
		}
		let id: string;
		if (lifetime === "oneshot") id = this.freshTmpId(type);
		else if (options.id !== undefined) id = options.id;
		else if (isAdhoc) throw new Error("persistent ad-hoc spawns require an explicit id (e.g. id: 'jwt-audit').");
		else id = "main";
		if (!isValidIdSegment(id)) throw new Error(`Invalid instance id ${JSON.stringify(id)}.`);

		let hash: string;
		if (isAdhoc) {
			if (options.tools !== undefined) selectToolNames({ name: ADHOC_TYPE, tools: options.tools }); // eager unknown-tool error
			const defContent = composeAdhocDef({
				description: adhocDescription(options.prompt!),
				prompt: options.prompt!,
				...(options.model !== undefined ? { model: options.model } : {}),
				...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
				...(options.tools !== undefined ? { tools: options.tools } : {}),
			});
			const parsed = parseTypeFile(defContent, ADHOC_TYPE);
			if (!parsed.ok) throw new Error(`Could not synthesize the ad-hoc def: ${parsed.errors.join("; ")}`);
			atomicWriteText(this.layout.adhocDefFile(type, id), defContent);
			hash = sha256(defContent);
		} else {
			const resolved = resolveTypeDef(this.layout, type, { projectTrusted: this.projectTrusted() });
			if (!resolved.ok) throw new Error(resolved.error);
			hash = resolved.resolved.hash;
		}

		const address = formatAgentAddress(type, id);
		const existing = getAgent(this.registry, address);
		// Get-or-create keeps the established human identity. A required label on a
		// later spawn fills old unlabeled records but never silently renames one.
		const label = existing?.label ?? explicitLabel ?? fallbackLabel(options, type, id);
		const now = new Date().toISOString();
		const { record, created } = upsertAgent(this.registry, { type, id, lifetime, label, typeFileHash: hash, now });
		mkdirSync(this.layout.agentInstanceDir(type, id), { recursive: true });
		this.persist();

		let taskEnvelopeId: string | undefined;
		if (options.task !== undefined) {
			if (options.inherit !== undefined) this.inheritCache.set(address, options.inherit);
			const outcome = this.deliverer.send({ from: { kind: "main" }, to: address, type: "message", text: options.task });
			taskEnvelopeId = outcome.envelopeId;
			if (outcome.delivered) {
				recordOpenTask(this.layout.openTasksFile, outcome.envelopeId, { to: address, snippet: options.task, openedAt: now });
			}
		}

		return {
			address,
			label,
			created,
			state: record.vitals.state,
			vitals: record.vitals,
			...(taskEnvelopeId !== undefined ? { taskEnvelopeId } : {}),
		};
	}

	// ------------------------------------------------------------------ send
	async send(options: SendOptions): Promise<SendResult> {
		const outcome = this.deliverer.send({ from: { kind: "main" }, to: options.to, type: "message", text: options.text });
		if (outcome.delivered) {
			recordOpenTask(this.layout.openTasksFile, outcome.envelopeId, {
				to: options.to,
				snippet: options.text,
				openedAt: new Date().toISOString(),
			});
		}
		return toSendResult(outcome);
	}

	async sendAsUser(options: SendOptions): Promise<SendResult> {
		const outcome = this.deliverer.send({ from: { kind: "user" }, to: options.to, type: "message", text: options.text });
		// Transparency: FYI report to main that the user messaged this agent directly.
		const to = parseAddress(options.to);
		if (to?.kind === "agent" && outcome.delivered) {
			this.deliverer.send({ from: to, to: MAIN_ADDRESS, type: "report", text: `The user sent me a direct message: "${options.text}"` });
		}
		return toSendResult(outcome);
	}

	/** SubagentMailPort: a report originated by a subagent's tool during its turn. */
	reportFromAgent(from: string, opts: { text: string; data?: unknown; final?: boolean }): DeliveryOutcome {
		const fromAddress = parseAddress(from);
		if (!fromAddress || fromAddress.kind !== "agent") throw new Error(`invalid agent sender ${JSON.stringify(from)}`);
		const handle = this.handles.get(from);
		const causedBy = handle?.trigger && handle.trigger.length > 0 ? handle.trigger.reduce((a, b) => (b.hops > a.hops ? b : a)) : null;
		// Correlate every report to the current assignment. Await returns only the
		// final report, but this link lets it consume earlier progress reports from
		// the same task so they cannot arrive later as stale wake digests.
		let correlationId: string | null = handle?.assignment ?? null;
		let terminalAnchors: string[] | undefined;
		if (opts.final && handle) {
			terminalAnchors = taskAnchors(handle.trigger);
			const record = getAgent(this.registry, from);
			if (record?.lifetime === "oneshot") handle.retireAfterTurn = true;
		}
		return this.deliverer.send({
			from: fromAddress,
			to: MAIN_ADDRESS,
			type: "report",
			text: opts.text,
			...(opts.data !== undefined ? { data: opts.data } : {}),
			...(opts.final !== undefined ? { final: opts.final } : {}),
			...(terminalAnchors !== undefined ? { terminalAnchors } : {}),
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

	// ----------------------------------------------------------------- steer / cancel
	async steer(to: string, text: string): Promise<SteerResult> {
		const handle = this.handles.get(to);
		if (!handle || !handle.session.isStreaming) return { steered: false };
		await handle.session.steer(text);
		return { steered: true };
	}

	async cancel(to: string): Promise<CancelResult> {
		const handle = this.handles.get(to);
		if (handle?.session.isStreaming) {
			handle.aborted = true;
			await handle.session.abort();
			return { cancelled: true };
		}
		// The agent is queued/waking (a turn scheduled, but its session isn't streaming
		// yet): record the intent so mailTurn stands the turn down once the handle is
		// built, instead of silently no-op'ing the cancel.
		const record = getAgent(this.registry, to);
		if (record && (record.vitals.state === "queued" || record.vitals.state === "running")) {
			this.pendingCancel.add(to);
			return { cancelled: true };
		}
		return { cancelled: false };
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
			// cached defaults/activity.
			this.buildLocks.delete(to);
			this.inheritCache.delete(to);
			this.activity.delete(to);
			this.pendingCancel.delete(to);
			// NB: we deliberately do NOT await this.chains.get(to) — a oneshot
			// auto-retire calls retire() from inside that very turn's tail, so
			// awaiting it would deadlock. The `retiring` flag + abort() above make
			// any in-flight/next turn stand down.
			removeAgent(this.registry, to);
			this.persist();
			closeAllFor(this.layout.openTasksFile, to);
			const archiveDir = archiveAgentDir(this.layout, record.type, record.id, new Date().toISOString(), record.label);
			this.emit({ type: "agent-retired", address: to, archiveDir });
			return { retired: true, archiveDir };
		} finally {
			this.retiring.delete(to);
		}
	}

	/** Retired agents on disk in .archive/. */
	archived(): ArchivedInfo[] {
		return readArchived(this.layout);
	}

	/** Live activity for currently-working agents (tree widget). */
	activitySnapshot(): AgentActivityRow[] {
		return [...this.activity.entries()]
			.map(([address, a]) => ({
				address,
				label: getAgent(this.registry, address)?.label ?? address,
				...a,
			}))
			.sort((x, y) => x.label.localeCompare(y.label) || x.address.localeCompare(y.address));
	}

	/**
	 * The open task anchors. Self-healing: an entry whose agent no longer exists,
	 * is not mid-turn, AND has no pending report/error in the main mailbox is
	 * stale (crash between mailbox commit and close) — pruned here.
	 */
	openTasks(): OpenTaskEntry[] {
		const map = readOpenTasks(this.layout.openTasksFile);
		const pendingMain = readPending(this.layout.mainMailboxDir);
		const out: OpenTaskEntry[] = [];
		for (const [anchorId, task] of Object.entries(map)) {
			const agentAlive = getAgent(this.registry, task.to) !== undefined || this.runningAddresses.has(task.to);
			const hasMail = pendingMain.some((p) => p.envelope.from === task.to);
			if (!agentAlive && !hasMail) {
				closeAllFor(this.layout.openTasksFile, task.to);
				continue;
			}
			out.push({ anchorId, ...task });
		}
		return out.sort((a, b) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0));
	}

	/**
	 * Explicit in-run join: block until every target (mode "all") or the first
	 * target (mode "any") reaches a terminal outcome — a FINAL report whose
	 * persisted terminalAnchors includes the target (so mail held for the next
	 * turn is never completed early), a fatal error envelope for that target, or
	 * retirement — or the timeout elapses. Matched terminal envelopes and their
	 * correlated, superseded progress are consumed; unrelated mail is untouched.
	 */
	async awaitResults(options: AwaitOptions): Promise<AwaitResult> {
		const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_AWAIT_TIMEOUT_S;
		const deadline = Date.now() + timeoutSeconds * 1000;
		const remaining = new Map<string, AwaitTarget>();
		for (const target of options.targets) remaining.set(`${target.to} ${target.anchorId}`, target);
		if (remaining.size === 0) return { status: "empty", outcomes: [], pending: [] };
		const outcomes: TargetOutcome[] = [];
		const mainbox = this.layout.mainMailboxDir;

		const resolveAnchorsFor = (to: string, anchors: ReadonlySet<string> | null, make: (target: AwaitTarget) => TargetOutcome): void => {
			for (const [key, target] of [...remaining.entries()]) {
				if (target.to !== to || (anchors !== null && !anchors.has(target.anchorId))) continue;
				outcomes.push(make(target));
				remaining.delete(key);
				closeOpenTask(this.layout.openTasksFile, target.anchorId);
			}
		};

		for (;;) {
			if (options.signal?.aborted) return { status: "timeout", outcomes, pending: [...remaining.values()] };
			const pending = readPending(mainbox);

			for (const target of [...remaining.values()]) {
				if (!remaining.has(`${target.to} ${target.anchorId}`)) continue; // resolved by an earlier sibling this pass
				const finalReport = pending.find((p) => {
					if (p.envelope.type !== "report" || p.envelope.from !== target.to || p.envelope.payload.final !== true) return false;
					return terminalAnchorList(p.envelope).includes(target.anchorId);
				});
				if (finalReport) {
					const anchors = new Set(terminalAnchorList(finalReport.envelope));
					consumeSupersededProgress(mainbox, pending, finalReport.envelope, anchors);
					markDone(mainbox, finalReport.envelope.id);
					const view = envView(finalReport.envelope);
					resolveAnchorsFor(target.to, anchors, (t) => ({ to: t.to, anchorId: t.anchorId, status: "completed", report: view }));
					continue;
				}
				const fatal = pending.find((p) => {
					if (p.envelope.type !== "error" || p.envelope.from !== target.to) return false;
					const terminal = terminalTaskAnchors(p.envelope);
					return terminal.kind === "legacy-unscoped-error" || terminal.anchors.includes(target.anchorId);
				});
				if (fatal) {
					const terminal = terminalTaskAnchors(fatal.envelope);
					const anchors = terminal.kind === "anchors" ? new Set(terminal.anchors) : null;
					if (anchors !== null && anchors.size > 0) consumeSupersededProgress(mainbox, pending, fatal.envelope, anchors);
					markDone(mainbox, fatal.envelope.id);
					const view = envView(fatal.envelope);
					resolveAnchorsFor(target.to, anchors, (t) => ({ to: t.to, anchorId: t.anchorId, status: "error", error: view }));
					continue;
				}
				// Retired detection keys on the TARGET's own liveness, not the fleet-wide
				// turn count — otherwise any other busy agent would mask retirement and
				// force this await to spin to timeout.
				if (!getAgent(this.registry, target.to) && !this.runningAddresses.has(target.to)) {
					closeAllFor(this.layout.openTasksFile, target.to);
					resolveAnchorsFor(target.to, null, (t) => ({ to: t.to, anchorId: t.anchorId, status: "retired" }));
				}
			}

			if (options.mode === "any" && outcomes.length > 0) return { status: "completed", outcomes, pending: [...remaining.values()] };
			if (remaining.size === 0) return { status: "completed", outcomes, pending: [] };
			if (Date.now() >= deadline) return { status: "timeout", outcomes, pending: [...remaining.values()] };
			await new Promise((resolve) => setTimeout(resolve, AWAIT_POLL_MS));
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
		this.pendingCancel.clear();
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

	/** Resolve an instance's constitution: adhoc → instance-local def.md; else the type libraries. */
	private resolveDef(record: AgentRecord): ResolveResult {
		return record.type === ADHOC_TYPE
			? resolveAdhocDef(this.layout, record.id)
			: resolveTypeDef(this.layout, record.type, { projectTrusted: this.projectTrusted() });
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
			label: record.label ?? address,
			type: record.type,
			id: record.id,
			state: record.vitals.state,
			lifetime: record.lifetime,
			purview: record.label ?? record.id,
			vitals: record.vitals,
			unread: pendingCount(this.layout.mailboxDir(record.type, record.id)),
			updatedAt: record.lastActiveAt,
		};
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

		const resolved = this.resolveDef(record);
		if (!resolved.ok) {
			this.emit({ type: "turn-error", address, error: resolved.error });
			return; // leave mail pending; a fixed def + next wake retries
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
				// fixed def + next wake retries.
				this.setState(address, "dormant");
				this.emit({ type: "turn-error", address, error: error instanceof Error ? error.message : String(error) });
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
			// A cancel requested before streaming began: stand the turn down now,
			// leave its mail pending, and go dormant (don't linger in "queued").
			if (this.pendingCancel.delete(address)) {
				leavePending = true;
				this.setState(address, "dormant");
				this.emit({ type: "turn-finished", address, vitals: getAgent(this.registry, address)?.vitals ?? vitalsFrom(handle.session, "dormant") });
				return;
			}
			turnHandle = handle;
			handle.trigger = pending.map((p) => p.envelope);
			handle.aborted = false;
			handle.retireAfterTurn = false;
			// The current assignment (for final-report correlation): the first
			// uncorrelated task message from main driving this turn.
			const task = pending.find((p) => p.envelope.type === "message" && p.envelope.correlationId === null && p.envelope.from !== USER_ADDRESS);
			if (task) handle.assignment = task.envelope.id;
			this.setState(address, "running");
			this.emit({ type: "turn-started", address });

			for (const p of pending) beginDelivery(mailboxDir, p.envelope.id);
			const digest = composeWakeDigest({
				items: pending.map((p): DigestItem => ({ envelope: p.envelope, redelivered: p.redelivered })),
			});

			const telemetry = this.trackTurnActivity(address, handle);
			try {
				await handle.session.prompt(digest);
				await handle.session.waitForIdle();
			} finally {
				telemetry.unsubscribe();
			}

			leavePending = this.finishTurn({ address, record, handle, mailboxDir, pending, failure: telemetry.failure() });
		} finally {
			this.activity.delete(address);
			// Consume any cancel intent that landed in the sliver where the session
			// was prompted but not yet streaming (isStreaming still false → cancel()
			// records intent instead of aborting). Left in the set, the stale flag would
			// stand down the NEXT, unrelated turn for this address.
			this.pendingCancel.delete(address);
			release();
		}

		// A oneshot that sent its final report this turn auto-retires. Read the
		// flag off the LOCAL handle we ran — not this.handles, which may have been
		// replaced/cleared during the turn.
		if (!leavePending && turnHandle?.retireAfterTurn) {
			await this.retire(address);
			return;
		}
		// More mail arrived during the turn (held, never interrupts) → drain again.
		if (!leavePending && !this.disposed && pendingCount(mailboxDir) > 0) this.scheduleMailTurn(address);
	}

	/**
	 * Seed the live activity row and subscribe to the session's stream events:
	 * current tool call + count for the tree widget, provider-visible thinking,
	 * live tokens/ctx refresh on message_end, and terminal-failure capture off
	 * agent_end. Pure telemetry —
	 * no mail or lifecycle decisions here. Returns the unsubscribe plus a getter
	 * for the failure observed this turn (if any).
	 */
	private trackTurnActivity(address: string, handle: Handle): { unsubscribe: () => void; failure: () => TurnFailure | null } {
		const startingVitals = vitalsFrom(handle.session, "running");
		this.activity.set(address, {
			tool: "",
			summary: "thinking…",
			toolUses: 0,
			tokens: startingVitals.tokens,
			ctxPercent: startingVitals.ctxPercent,
		});
		let failure: TurnFailure | null = null;
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
			// message_end is emitted just before SessionManager persistence. Defer one
			// microtask so getSessionStats() includes that finalized message, then
			// refresh cumulative tokens/context and any tool calls it introduced.
			if (event.type === "message_end") {
				queueMicrotask(() => {
					const prev = this.activity.get(address);
					if (!prev) return;
					const live = vitalsFrom(handle.session, "running");
					publishActivity({ ...prev, tokens: live.tokens, ctxPercent: live.ctxPercent });
				});
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
		return { unsubscribe, failure: () => failure };
	}

	/**
	 * Post-turn commit: complete (or deliberately leave pending) the drained
	 * mail, persist vitals, surface a terminal failure as an error envelope with
	 * this turn's exact task anchors, and emit the closing events. Returns
	 * leavePending — true when the turn was aborted/shut down and its triggering
	 * mail must stay pending.
	 */
	private finishTurn(args: {
		address: string;
		record: AgentRecord;
		handle: Handle;
		mailboxDir: string;
		pending: ReturnType<typeof readPending>;
		failure: TurnFailure | null;
	}): boolean {
		const { address, record, handle, mailboxDir, pending, failure } = args;
		let leavePending = false;
		if (this.disposed || handle.aborted || failure?.stopReason === "aborted") {
			// cancel/shutdown: leave the triggering mail pending, don't auto-retry
			leavePending = true;
		} else {
			for (const p of pending) markDone(mailboxDir, p.envelope.id);
		}

		const vitals = vitalsFrom(handle.session, "dormant");
		patchAgent(this.registry, address, { vitals, lastActiveAt: new Date().toISOString() });
		this.persist();
		handle.trigger = null;

		if (failure?.stopReason === "error") {
			this.emit({ type: "turn-error", address, error: failure.message });
			// Persist exactly the task anchors consumed by this failed turn. Mail that
			// arrived while it ran remains pending for the next turn and must not be
			// completed by this error.
			this.deliverer.send({
				from: { kind: "agent", type: record.type, id: record.id },
				to: MAIN_ADDRESS,
				type: "error",
				text: `Turn failed: ${failure.message}`,
				terminalAnchors: taskAnchors(pending.map((p) => p.envelope)),
			});
		}
		this.activity.delete(address);
		this.emit({ type: "state-changed", address, state: "dormant" });
		this.emit({ type: "turn-finished", address, vitals });
		if (!leavePending) handle.assignment = null;
		return leavePending;
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

		const purview = record.type === ADHOC_TYPE ? def.config.description : record.id;
		const composed = composeContext(def, { address, purview, lifetime: record.lifetime });
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
				...createSubagentTools(address, this),
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
		return { session, aborted: false, trigger: null, assignment: null, retireAfterTurn: false };
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

/** Validate and normalize an explicit LLM/user display label. */
function normalizeLabel(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const flat = value.replace(/\s+/g, " ").trim();
	if (!flat) throw new Error("Subagent label must not be empty.");
	if (Array.from(flat).length > MAX_LABEL_CHARS) throw new Error(`Subagent label must be at most ${MAX_LABEL_CHARS} characters.`);
	return flat;
}

/** Backward-compatible label for direct callers and resumed pre-label tool calls. */
function fallbackLabel(options: SpawnOptions, type: string, id: string): string {
	const source = options.task ?? (options.prompt !== undefined ? options.prompt.replace(/^You are\s+/i, "") : "");
	return labelFromSource(source) || `${type}/${id}`;
}

/** A one-line description for an ad-hoc def, derived from its prompt. */
function adhocDescription(prompt: string): string {
	return ellipsize(prompt.replace(/\s+/g, " ").trim(), 100);
}

/** A short one-line summary of a tool call for the tree widget. */
function toolSummary(tool: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const label = tool.charAt(0).toUpperCase() + tool.slice(1);
	const detail =
		typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : typeof a.pattern === "string" ? a.pattern : typeof a.to === "string" ? String(a.to) : "";
	const flat = detail.replace(/\s+/g, " ").trim();
	return flat ? `${label}: ${ellipsize(flat, 48)}` : label;
}

/** Task anchors consumed by one mail-turn snapshot (never includes held future mail). */
function taskAnchors(trigger: Envelope[] | null): string[] {
	if (!trigger) return [];
	return [...new Set(trigger
		.filter((envelope) => envelope.type === "message" && envelope.from === MAIN_ADDRESS && envelope.correlationId === null)
		.map((envelope) => envelope.id))];
}

/** Flat anchor-list view for final reports, including correlation fallback. */
function terminalAnchorList(envelope: Envelope): string[] {
	const result = terminalTaskAnchors(envelope);
	return result.kind === "anchors" ? result.anchors : [];
}

/**
 * A joined terminal outcome supersedes progress from the same assignment. Move
 * those progress envelopes to `.done` with the final/error so the idle wake pump
 * cannot deliver an already-obsolete checkpoint after `subagent_await` returns.
 * Only explicitly correlated reports are coalesced. Older uncorrelated mail is
 * left untouched because it cannot be attributed to an assignment safely.
 */
function consumeSupersededProgress(
	mailboxDir: string,
	pending: ReturnType<typeof readPending>,
	terminal: Envelope,
	anchors: ReadonlySet<string>,
): void {
	for (const candidate of pending) {
		const envelope = candidate.envelope;
		if (envelope.type !== "report" || envelope.payload.final === true || envelope.from !== terminal.from) continue;
		if (
			envelope.fromGenerationId !== undefined &&
			terminal.fromGenerationId !== undefined &&
			envelope.fromGenerationId !== terminal.fromGenerationId
		) continue;
		if (envelope.correlationId !== null && anchors.has(envelope.correlationId)) {
			markDone(mailboxDir, envelope.id);
		}
	}
}

function envView(envelope: Envelope): EnvelopeView {
	return {
		id: envelope.id,
		type: envelope.type as EnvelopeView["type"],
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

