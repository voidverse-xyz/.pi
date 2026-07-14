/**
 * core.ts — the facade over runtime + store + typedefs + mail (D23 structural
 * rule 1).
 *
 * The ONLY module tools/ and tui/ import. It owns wiring (layout → runtime),
 * read-side joins, and the MAIN agent's mailbox mechanics; the runtime stays
 * swappable behind runtime/types.ts — this file holds a SubagentRuntime,
 * never the in-process class, past construction.
 *
 * The surface includes the power-matrix passthroughs, sendAsUser (D17), durable
 * main-mail claiming/reconciliation, exact anchored await, and the D27
 * current-user-turn required-task group. Direct tasks plus transitive peer
 * delegations stay joined unless a call explicitly sets background:true.
 *
 * Session turn/token accounting and per-agent token/time/compaction values are
 * warning thresholds only. They never gate, abort, or retire work; index.ts
 * resets the session window on genuine user input and renders targeted warnings.
 *
 * Phase 7: settings come from a REAL source (store/settings.ts —
 * ~/.pi/agent/subagents.json overridden by <project>/.pi/subagents.json;
 * programmatic CreateCoreOptions.settings wins for harnesses). The budget and
 * ceiling checks read their limits off the ONE mutable settings object LIVE;
 * reloadSettings() re-reads the files into it (index.ts calls it every real
 * user turn), so file edits apply without /reload — except maxConcurrent,
 * which is bound into the scheduler at core creation. runGcSweepFor() is the
 * session_start GC entry point (archive + .done mail + resolved escalations,
 * settings-controlled retention).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { collectResultNote, validateAgainstSchema } from "./mail/collect.ts";
import { composeWakeDigest, type DigestItem } from "./mail/digest.ts";
import { ENVELOPE_ID_RE, MAIN_ADDRESS, type Envelope } from "./mail/envelope.ts";
import {
	addHostDeliveryMarker,
	claimPendingForHost,
	type HostDeliveryReconcile,
	lookupAwaitAnchorGeneration,
	lookupSentQuestion,
	peekCollectRequest,
	pendingCount,
	readPending,
	readStoredHostEnvelopes,
	reconcileHostDelivery,
	recordCollectRequest,
	requeueDoneHostClaim,
	requeueHostClaim,
	takeCollectRequest,
} from "./mail/mailbox.ts";
import { AutonomyBudget } from "./rails/autonomy.ts";
import { InProcessRuntime } from "./runtime/in-process.ts";
import type { EscalationRecord } from "./sandbox/escalation.ts";
import type {
	AgentDetail,
	AwaitOptions,
	AwaitResult,
	CollectResult,
	InterruptResult,
	RetireResult,
	RosterEntry,
	SendOptions,
	SendResult,
	SpawnOptions,
	SpawnResult,
	SteerResult,
	SubagentRuntime,
} from "./runtime/types.ts";
import { gcSweep, type GcSweepResult } from "./store/archive.ts";
import { createLayout, type Layout } from "./store/layout.ts";
import {
	claimHostScope,
	ensureScopeManifest,
	type HostScopeLease,
	SessionScopeLockedError,
} from "./store/session-scope.ts";
import { atomicWriteJson, getAgent, listAgents, readRegistry } from "./store/registry.ts";
import { isValidTeamName } from "./store/teams.ts";
import {
	applySettingsInto,
	loadSettings,
	type SubagentsSettings,
} from "./store/settings.ts";
import { listTypeDefs } from "./typedefs/discover.ts";
import { parseTypeFile } from "./typedefs/parse.ts";

// Re-exported so tools/tui/harnesses keep one import surface (D23 rule 1).
export { defaultSettings, type SubagentsSettings } from "./store/settings.ts";

export interface ScopeLocator {
	sessionId: string;
	home?: string;
	stateContainerRoot?: string;
}

function layoutFor(cwd: string, locator: ScopeLocator): Layout {
	return createLayout(cwd, {
		sessionId: locator.sessionId,
		...(locator.home !== undefined ? { home: locator.home } : {}),
		...(locator.stateContainerRoot !== undefined ? { stateContainerRoot: locator.stateContainerRoot } : {}),
	});
}


/**
 * The customType prefix index.ts stamps on main-mail digest messages.
 * Reconciliation uses it to recognize OUR injected digests
 * in the main session JSONL: an envelope counts as delivered only when its id
 * appears on a JSONL line that also carries this marker — envelope ids alone
 * can leak into the session via tool results and must not finalize mail.
 */
export const MAIN_MAIL_CUSTOM_TYPE = "subagent-mail";

export interface CreateCoreOptions extends ScopeLocator {
	/** Project cwd; project resources stay shared while mutable state is session-owned. */
	cwd: string;
	/** Whether the host session has durable JSONL storage. Default true. */
	persisted?: boolean;
	/** Shared with the host session so subagents resolve the same models. */
	modelRegistry?: ModelRegistry;
	settingsManager?: SettingsManager;
	/** Override $HOME (tests). */
	home?: string;
	/** Scheduler cap (D13). Overrides settings.maxConcurrent when given. */
	maxConcurrent?: number;
	/** An envelope landed in the main agent's mailbox (already on disk). */
	onMainMail?: (envelope: Envelope) => void;
	/** Initial settings; unset fields take the doc defaults (defaultSettings). */
	settings?: Partial<SubagentsSettings>;
}

/**
 * One retired agent still viewable in .archive/ (D13 post-mortem promise;
 * Phase 6 picker's collapsed `.archive (n)` section). Read-only: no mailbox,
 * no sends — just the archived session transcript.
 */
export interface ArchivedAgentInfo {
	/** `<type>/<dirname>` — dirname may carry a `-2` collision suffix. */
	address: string;
	type: string;
	id: string;
	archiveDir: string;
	/** ISO timestamp from the .retired-at marker; null if missing. */
	retiredAt: string | null;
	/** Most recent Pi session JSONL inside the archive, if any. */
	sessionFile: string | null;
}

/** A discoverable type, as shown to the main agent's LLM when choosing. */
export interface AvailableType {
	name: string;
	description: string;
	source: "project" | "global";
	/** Present when the file failed validation — spawn would error. */
	invalid?: string;
}

export interface RequiredTaskAnchor {
	to: string;
	anchorId: string;
	waitFor: "final" | "collect";
	createdAt: string;
}

export interface SubagentsCore {
	readonly layout: Layout;
	/** The D7 swap-point — TUI live-tail and later phases hang off this. */
	readonly runtime: SubagentRuntime;
	/**
	 * The ONE mutable settings object (store/settings.ts: defaults ← global
	 * file ← project file ← programmatic overrides). The autonomy budget and
	 * ceiling checks read it LIVE; reloadSettings() refreshes it from disk.
	 */
	readonly settings: SubagentsSettings;
	/** Warnings from the settings files read at core creation. */
	readonly settingsWarnings: readonly string[];
	/**
	 * Re-read both settings files into the live settings object (programmatic
	 * overrides keep winning). Everything except maxConcurrent applies at the
	 * next turn. Returns the fresh warnings.
	 */
	reloadSettings(): string[];
	/**
	 * The session's D21 subagent autonomy pool. index.ts resets it on user
	 * input; the runtime meters subagent turns and drains their queued mail on
	 * resume. Main-agent mailbox wakeups are independent of this pool.
	 */
	readonly autonomy: AutonomyBudget;

	spawn(options: SpawnOptions): Promise<SpawnResult>;
	send(options: SendOptions): Promise<SendResult>;
	sendAsUser(options: SendOptions): Promise<SendResult>;
	steer(to: string, text: string): Promise<SteerResult>;
	interrupt(to: string, expectedTurnId?: string): Promise<InterruptResult>;
	retire(to: string): Promise<RetireResult>;
	collect(to: string, schema: unknown, background?: boolean): Promise<CollectResult>;
	/** Start/clear the required-task set for one genuine main user turn. */
	beginRequiredTaskGroup(): void;
	clearRequiredTaskGroup(): void;
	pendingRequiredTasks(): RequiredTaskAnchor[];
	/** Cancellable join for an anchored final/collect report in main mail. */
	awaitResult(options: AwaitOptions): Promise<AwaitResult>;
	status(): Promise<RosterEntry[]>;
	peek(address: string, tail?: number): Promise<AgentDetail | null>;
	/** Merged type libraries (project wins), for spawn UX and errors (D6). */
	availableTypes(): AvailableType[];

	/** Unprocessed envelopes across all subagent mailboxes. Cheap directory scans. */
	queuedMailCount(): number;

	/** Unprocessed envelopes in ONE agent's mailbox (picker unread badge). */
	agentUnreadCount(address: string): number;

	/**
	 * Retired agents still in .archive/ (picker `.archive (n)` section,
	 * viewer read-only transcript). Cheap directory scan; newest first.
	 */
	archived(): ArchivedAgentInfo[];

	/**
	 * The D10 human gate (Phase 5; the Phase 6 modal calls this). `approve`
	 * is for the HUMAN UI ONLY — it must never be reachable from any LLM tool
	 * surface (approvals never flow downhill; the main agent's one power here
	 * is deny, and it exercises it via mail, not via this API). `deny` makes
	 * the blocked tool return an error result carrying the note.
	 */
	readonly escalations: {
		pending(): EscalationRecord[];
		approve(id: string): boolean;
		deny(id: string, note?: string): boolean;
	};

	/** Unprocessed envelopes in .main/mailbox/ (📬 widget, Phase 6). */
	mainUnreadCount(): number;
	/** True when any pending envelope is waiting in the main mailbox. */
	mainHasPendingMail(): boolean;
	/**
	 * Compose the main agent's wake digest over all pending mail; null when
	 * the mailbox is empty. Collect results are validated against their
	 * recorded schemas and annotated (03-tool-surface). Callers inject the
	 * digest into the host session immediately.
	 *
	 * Durability (02-envelope-contract at-least-once, main-mailbox variant):
	 * pass the ACTIVE main session JSONL path (ctx.sessionManager
	 * .getSessionFile()) and the drained envelopes are parked in
	 * .delivering/ rather than finalized — the next drain (or the next
	 * process's session_start via reconcileMainMailFor) verifies the injected
	 * digest actually landed in that JSONL before moving them to .done/; a
	 * crash before the host append requeues them instead. Every call also
	 * finalizes previously parked envelopes whose digests are now verifiably
	 * in the JSONL. Pass null/undefined only when no persisted session file
	 * exists (print mode / stub hosts): the envelopes are finalized at compose
	 * time, as nothing durable could ever verify them.
	 */
	drainMainMail(sessionFile?: string | null): string | null;
	/** Acknowledge that the host accepted the most recently composed digest. */
	commitMainMailDrain(): void;
	/** Requeue the most recent digest after synchronous host injection failure. */
	rollbackMainMailDrain(): void;

	dispose(): Promise<void>;
}

function readAutonomySnapshot(file: string): {
	trippedBy: "turns" | "tokens" | null;
	turnsUsed: number;
	tokensUsed: number;
} | undefined {
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		if (
			(value.trippedBy === null || value.trippedBy === "turns" || value.trippedBy === "tokens") &&
			Number.isInteger(value.turnsUsed) && (value.turnsUsed as number) >= 0 &&
			typeof value.tokensUsed === "number" && Number.isFinite(value.tokensUsed) && value.tokensUsed >= 0
		) {
			return {
				trippedBy: value.trippedBy,
				turnsUsed: value.turnsUsed as number,
				tokensUsed: value.tokensUsed,
			};
		}
	} catch {
		// Missing/corrupt snapshots start with a fresh pool.
	}
	return undefined;
}

const AWAIT_DELIVERY_MARKER = "subagent_await" as const;

function awaitEnvelopeView(envelope: Envelope) {
	return {
		id: envelope.id,
		type: envelope.type as "question" | "escalation" | "error" | "report",
		text: envelope.payload.text.length > 16_000
			? `${envelope.payload.text.slice(0, 16_000)}\n… [truncated for tool context]`
			: envelope.payload.text,
		correlationId: envelope.correlationId,
		...(envelope.payload.data !== undefined ? { data: envelope.payload.data } : {}),
		...(envelope.payload.final !== undefined ? { final: envelope.payload.final } : {}),
	};
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("subagent_await cancelled"));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(done, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("subagent_await cancelled"));
		};
		function done(): void {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function awaitMainResult(
	layout: Layout,
	options: AwaitOptions,
): Promise<AwaitResult> {
	if (!ENVELOPE_ID_RE.test(options.anchorId)) throw new Error(`Malformed await anchorId ${JSON.stringify(options.anchorId)}.`);
	const timeoutSeconds = options.timeoutSeconds ?? 300;
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) {
		throw new Error("timeoutSeconds must be between 1 and 900.");
	}
	const deadline = Date.now() + timeoutSeconds * 1000;
	const mailbox = layout.mainMailboxDir;
	// Fence address reuse for the lifetime of this await. Exact correlation is
	// still causal across retirement/clock rollback, while unrelated attention
	// from a replacement generation must never satisfy the old join.
	const initialRecord = getAgent(readRegistry(layout.registryFile), options.to);
	const awaitedGenerationId =
		lookupAwaitAnchorGeneration(mailbox, options.anchorId, options.to) ?? initialRecord?.generationId;

	type Candidate = {
		envelope: Envelope;
		state: "pending" | "delivering" | "done";
	};

	for (;;) {
		if (options.signal?.aborted) throw new Error("subagent_await cancelled");
		// A prior await/digest claim may now be proven by the host JSONL. Finalize
		// it before ordering candidates so an already-returned question in
		// .delivering cannot starve a later final report in the same main turn.
		reconcileHostDelivery(mailbox, {
			marker: AWAIT_DELIVERY_MARKER,
			requeueUndelivered: false,
		});
		const currentRecord = getAgent(readRegistry(layout.registryFile), options.to);
		const sameGeneration =
			awaitedGenerationId !== undefined && currentRecord?.generationId === awaitedGenerationId;
		const candidates: Candidate[] = [
			...readPending(mailbox).map(({ envelope }) => ({ envelope, state: "pending" as const })),
			...readStoredHostEnvelopes(mailbox).map(({ envelope, state }) => ({ envelope, state })),
		];
		const seen = new Set<string>();
		const relevant = candidates
			.filter(({ envelope, state }) => {
				if (envelope.from !== options.to || seen.has(envelope.id)) return false;
				seen.add(envelope.id);
				const exactlyCorrelated = envelope.correlationId === options.anchorId;
				if (exactlyCorrelated) return true;
				if (state === "done" || envelope.id <= options.anchorId) return false;
				// New envelopes carry an exact sender-incarnation fence. Legacy
				// envelopes are eligible only while the registry still names the
				// generation captured when this await began.
				return envelope.fromGenerationId !== undefined
					? awaitedGenerationId !== undefined && envelope.fromGenerationId === awaitedGenerationId
					: sameGeneration;
			})
			.sort((a, b) => a.envelope.id.localeCompare(b.envelope.id));
		const terminalIndex = relevant.findIndex(({ envelope }) => {
			if (envelope.type === "question" || envelope.type === "escalation" || envelope.type === "error") return true;
			if (envelope.type !== "report") return false;
			return options.waitFor === "collect"
				? envelope.correlationId === options.anchorId
				: envelope.payload.final === true && envelope.correlationId === options.anchorId;
		});
		if (terminalIndex >= 0) {
			const throughTerminal = relevant.slice(0, terminalIndex + 1);
			const wantedIds = new Set(
				throughTerminal
					.filter(
						({ envelope }, index) =>
							index === terminalIndex ||
							(envelope.type === "report" &&
								envelope.payload.final !== true &&
								envelope.correlationId === options.anchorId),
					)
					.map(({ envelope }) => envelope.id),
			);
			const claimed = claimPendingForHost(
				mailbox,
				(pending) => wantedIds.has(pending.envelope.id),
				options.sessionFile,
				AWAIT_DELIVERY_MARKER,
			);
			const claimedById = new Map(claimed.map(({ envelope }) => [envelope.id, envelope]));
			const durableStoredIds = new Set<string>();
			const terminalCandidate = relevant[terminalIndex]!;
			let terminal: Envelope;
			if (terminalCandidate.state === "pending") {
				const won = claimedById.get(terminalCandidate.envelope.id);
				if (!won) continue; // drain won; next scan observes .delivering/.done
				terminal = won;
			} else if (terminalCandidate.state === "delivering") {
				// The ordinary digest claimed first. Register await as an alternate
				// durable proof, so either racing host append can finalize the mail.
				if (addHostDeliveryMarker(mailbox, terminalCandidate.envelope.id, AWAIT_DELIVERY_MARKER) === null) continue;
				durableStoredIds.add(terminalCandidate.envelope.id);
				terminal = terminalCandidate.envelope;
			} else {
				durableStoredIds.add(terminalCandidate.envelope.id);
				terminal = terminalCandidate.envelope; // idempotent retry from .done
			}
			// Progress already parked by the competing digest needs the same
			// alternate proof if it is included in this await tool result.
			for (const candidate of throughTerminal) {
				if (
					candidate.state === "delivering" &&
					candidate.envelope.type === "report" &&
					candidate.envelope.id !== terminal.id &&
					candidate.envelope.payload.final !== true &&
					candidate.envelope.correlationId === options.anchorId &&
					addHostDeliveryMarker(mailbox, candidate.envelope.id, AWAIT_DELIVERY_MARKER) !== null
				) {
					durableStoredIds.add(candidate.envelope.id);
				}
			}
			const progress = throughTerminal
				.filter(({ envelope }) =>
					envelope.type === "report" &&
					envelope.id !== terminal.id &&
					envelope.payload.final !== true &&
					envelope.correlationId === options.anchorId,
				)
				.filter(({ envelope, state }) =>
					state === "pending"
						? claimedById.has(envelope.id)
						: state === "done" || durableStoredIds.has(envelope.id),
				)
				.map(({ envelope }) => awaitEnvelopeView(envelope));
			if (terminal.type === "question" || terminal.type === "escalation" || terminal.type === "error") {
				return {
					status: "attention",
					to: options.to,
					anchorId: options.anchorId,
					deliveryMarker: AWAIT_DELIVERY_MARKER,
					attention: awaitEnvelopeView(terminal),
					...(progress.length > 0 ? { progress } : {}),
				};
			}
			let validation: { valid: boolean; errors: string[] } | undefined;
			if (options.waitFor === "collect") {
				const schema = peekCollectRequest(mailbox, options.anchorId, options.to);
				if (schema !== undefined) validation = validateAgainstSchema(terminal.payload.data, schema);
			}
			// Non-persisted pending claims finalized at claim time. Stored/done
			// observations were finalized by their original durable delivery.
			if (
				terminalCandidate.state === "pending" &&
				!options.sessionFile &&
				options.waitFor === "collect"
			) {
				takeCollectRequest(mailbox, options.anchorId, options.to);
			}
			return {
				status: "completed",
				to: options.to,
				anchorId: options.anchorId,
				deliveryMarker: AWAIT_DELIVERY_MARKER,
				report: awaitEnvelopeView(terminal),
				...(progress.length > 0 ? { progress } : {}),
				...(validation !== undefined ? { validation } : {}),
			};
		}

		if (
			awaitedGenerationId === undefined ||
			currentRecord === undefined ||
			currentRecord.generationId !== awaitedGenerationId
		) {
			return {
				status: "retired",
				to: options.to,
				anchorId: options.anchorId,
				deliveryMarker: AWAIT_DELIVERY_MARKER,
			};
		}
		if (Date.now() >= deadline) {
			return {
				status: "timeout",
				to: options.to,
				anchorId: options.anchorId,
				deliveryMarker: AWAIT_DELIVERY_MARKER,
			};
		}
		await abortableDelay(Math.min(200, Math.max(1, deadline - Date.now())), options.signal);
	}
}

export function createCore(options: CreateCoreOptions): SubagentsCore {
	const layout = layoutFor(options.cwd, options);
	const persisted = options.persisted ?? true;
	// Project settings are shared/read-only and can be loaded before claiming
	// the mutable owner scope. This avoids stranding a lease on read failure.
	const loaded = loadSettings(layout);
	const hostLease: HostScopeLease = claimHostScope(layout);
	try {
		ensureScopeManifest(layout, { persisted });
		// This host just acquired exclusive ownership, so any unverified parked
		// append belongs to a dead predecessor and is safe to requeue. Keeping
		// recovery inside the lease removes the startup check→claim race.
		reconcileHostDelivery(layout.mainMailboxDir, {
			marker: MAIN_MAIL_CUSTOM_TYPE,
			requeueUndelivered: true,
		});
	} catch (error) {
		hostLease.release();
		throw error;
	}
	// Phase 7 settings source: files first, programmatic overrides win.
	const settings: SubagentsSettings = { ...loaded.settings, ...options.settings };
	if (options.maxConcurrent !== undefined) settings.maxConcurrent = options.maxConcurrent;
	const settingsWarnings: string[] = [...loaded.warnings];
	const programmaticOverrides = {
		...options.settings,
		...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
	};
	// The one session-owned D21 pool — persisted so reload/resume cannot refill it.
	const autonomy = new AutonomyBudget(settings, readAutonomySnapshot(layout.autonomyFile), (snapshot) => {
		atomicWriteJson(layout.autonomyFile, { version: 1, ...snapshot, updatedAt: new Date().toISOString() });
	});
	let runtime: SubagentRuntime;
	try {
		runtime = new InProcessRuntime({
			layout,
			...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
			...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
			maxConcurrent: settings.maxConcurrent,
			persistentHost: persisted,
			maxHops: () => settings.maxHops,
			autonomy,
			// Per-agent warning defaults read LIVE off the settings object — a
			// settings edit applies at the next turn.
			ceilings: settings,
			...(options.onMainMail ? { onMainMail: options.onMainMail } : {}),
		});
	} catch (error) {
		hostLease.release();
		throw error;
	}
	const mainMailbox = layout.mainMailboxDir;
	let lastMainDrain: {
		ids: string[];
		persisted: boolean;
		collects: Array<{ envelopeId: string; correlationId: string; from: string; schema: unknown }>;
	} | null = null;
	let requiredGroupActive = false;
	const requiredTasks = new Map<string, RequiredTaskAnchor>();
	const trackRequired = (task: RequiredTaskAnchor, background?: boolean): void => {
		if (!requiredGroupActive || background === true) return;
		requiredTasks.set(task.anchorId, task);
	};
	const settleRequired = (result: AwaitResult): void => {
		if (
			result.status === "completed" ||
			result.status === "retired" ||
			(result.status === "attention" && result.attention?.type === "error")
		) {
			requiredTasks.delete(result.anchorId);
		}
	};
	const unsubscribeRequiredDelegation = runtime.onEvent((event) => {
		if (
			!requiredGroupActive ||
			event.type !== "envelope-sent" ||
			event.envelopeType !== "message" ||
			event.correlationId !== null ||
			event.to === MAIN_ADDRESS ||
			![...requiredTasks.values()].some((task) => task.to === event.from)
		) return;
		trackRequired({
			anchorId: event.envelopeId,
			to: event.to,
			waitFor: "final",
			createdAt: new Date().toISOString(),
		});
	});

	return {
		layout,
		runtime,
		settings,
		settingsWarnings,
		reloadSettings: () => {
			const warnings = applySettingsInto(settings, layout, programmaticOverrides);
			settingsWarnings.length = 0;
			settingsWarnings.push(...warnings);
			return warnings;
		},
		autonomy,
		spawn: async (spawnOptions) => {
			// Validate the team name at the spawn boundary — BEFORE runtime.spawn
			// commits any registry record (finding 11). The old flow committed the
			// record first and only then called addTo, so a bad name (e.g.
			// "__proto__") threw AFTER the roster was mutated, leaving partial
			// state. Rejecting here keeps spawn all-or-nothing for every caller.
			if (spawnOptions.team !== undefined && !isValidTeamName(spawnOptions.team)) {
				throw new Error(
						`Invalid team name ${JSON.stringify(spawnOptions.team)} — use a slug ` +
							"(letters, digits, and ._-, not starting with a dot), not a reserved word " +
							"(__proto__/prototype/constructor) or empty string.",
					);
			}
			const result = await runtime.spawn(spawnOptions);
			if (spawnOptions.task !== undefined && result.taskEnvelopeId !== undefined) {
				trackRequired({
					to: result.address,
					anchorId: result.taskEnvelopeId,
					waitFor: "final",
					createdAt: new Date().toISOString(),
				}, spawnOptions.background);
			}
			return result;
		},
		send: async (sendOptions) => {
			const result = await runtime.send(sendOptions);
			if (sendOptions.correlationId === undefined) {
				trackRequired({
					to: sendOptions.to,
					anchorId: result.envelopeId,
					waitFor: "final",
					createdAt: new Date().toISOString(),
				}, sendOptions.background);
			}
			return result;
		},
		sendAsUser: (sendOptions) => runtime.sendAsUser(sendOptions),
		steer: (to, text) => runtime.steer(to, text),
		interrupt: async (to, expectedTurnId) => {
			const result = await runtime.interrupt(to, expectedTurnId);
			if (result.interrupted) {
				for (const id of result.taskAnchorIds ?? []) requiredTasks.delete(id);
			}
			return result;
		},
		retire: async (to) => {
			const result = await runtime.retire(to);
			for (const [id, task] of requiredTasks) if (task.to === to) requiredTasks.delete(id);
			return result;
		},
		collect: async (to, schema, background) => {
			const result = await runtime.collect(to, schema);
			trackRequired({
				to,
				anchorId: result.requestId,
				waitFor: "collect",
				createdAt: new Date().toISOString(),
			}, background);
			return result;
		},
		beginRequiredTaskGroup: () => {
			// A user/main interruption does not detach already-delegated work.
			// Preserve the unfinished group; a genuinely completed group starts fresh.
			if (requiredGroupActive && requiredTasks.size > 0) return;
			requiredTasks.clear();
			requiredGroupActive = true;
		},
		clearRequiredTaskGroup: () => {
			requiredTasks.clear();
			requiredGroupActive = false;
		},
		pendingRequiredTasks: () => [...requiredTasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		awaitResult: async (awaitOptions) => {
			const result = await awaitMainResult(layout, awaitOptions);
			settleRequired(result);
			return result;
		},
		status: () => runtime.status(),
		peek: (address, tail) => runtime.peek(address, tail),
		availableTypes: () =>
			listTypeDefs(layout).map((discovered) => {
				const parsed = parseTypeFile(discovered.content, discovered.name);
				if (parsed.ok) {
					return {
						name: discovered.name,
						description: parsed.def.config.description,
						source: discovered.source,
					};
				}
				return {
					name: discovered.name,
					description: "(invalid type file)",
					source: discovered.source,
					invalid: parsed.errors.join("; "),
				};
			}),

		escalations: {
			pending: () => runtime.pendingEscalations(),
			approve: (id) => runtime.approveEscalation(id),
			deny: (id, note) => runtime.denyEscalation(id, note),
		},

		queuedMailCount: () =>
			listAgents(readRegistry(layout.registryFile)).reduce(
				(sum, record) => sum + pendingCount(layout.mailboxDir(record.type, record.id)),
				0,
			),

		agentUnreadCount: (address) => {
			const parts = address.split("/");
			if (parts.length !== 2) return 0;
			return pendingCount(layout.mailboxDir(parts[0]!, parts[1]!));
		},

		archived: () => listArchived(layout.archiveRoot),

		mainUnreadCount: () => pendingCount(mainMailbox),
		mainHasPendingMail: () => readPending(mainMailbox).length > 0,
		drainMainMail: (sessionFile) => {
			// A subsequent drain is an implicit acknowledgement of any prior
			// successfully returned digest from direct/core callers.
			lastMainDrain = null;
			// Settle earlier batches first: digests verified in their session
			// JSONL finalize to .done/ now (the "exactly once" half of the
			// contract); unverified ones stay in .delivering/ — in-process we
			// never requeue (the host append may still be in flight; requeueing
			// here could double-deliver and double-charge the D21 pool). Crash
			// recovery requeues at session_start via reconcileMainMailFor.
			reconcileHostDelivery(mainMailbox, {
				marker: MAIN_MAIL_CUSTOM_TYPE,
				requeueUndelivered: false,
			});
			const pending = claimPendingForHost(
				mainMailbox,
				() => true,
				sessionFile,
				MAIN_MAIL_CUSTOM_TYPE,
			);
			if (pending.length === 0) return null;
			const ids = pending.map((p) => p.envelope.id);
			const collects: Array<{ envelopeId: string; correlationId: string; from: string; schema: unknown }> = [];

			const items: DigestItem[] = pending.map((p) => {
				// Collect-result validation on arrival (03-tool-surface): a
				// report whose correlationId matches a recorded collect request.
				// PEEK, don't take (finding 8): the schema stays on record until the
				// report is DURABLY delivered, so a crash-then-requeue re-validates.
				// The record is retired at the finalize point (reconcileHostDelivery
				// for the parked path, or right after markDone for the no-session
				// path below).
				let note: string | undefined;
				if (p.envelope.type === "report" && p.envelope.correlationId !== null) {
					const schema = peekCollectRequest(mainMailbox, p.envelope.correlationId, p.envelope.from);
					if (schema !== undefined) {
						note = collectResultNote(validateAgainstSchema(p.envelope.payload.data, schema));
						collects.push({
							envelopeId: p.envelope.id,
							correlationId: p.envelope.correlationId,
							from: p.envelope.from,
							schema,
						});
					}
				}
				return {
					envelope: p.envelope,
					redelivered: p.redelivered,
					...(note !== undefined ? { note } : {}),
				};
			});

			let digest: string;
			try {
				digest = composeWakeDigest({
					items,
					questionLookup: (correlationId, from) => lookupSentQuestion(mainMailbox, correlationId, from),
				});
			} catch (error) {
				// Persisted claims were parked before rendering. Put them back if a
				// formatter unexpectedly fails so no mail is stranded in-flight.
				if (typeof sessionFile === "string" && sessionFile.length > 0) requeueHostClaim(mainMailbox, ids);
				else requeueDoneHostClaim(mainMailbox, ids);
				lastMainDrain = null;
				throw error;
			}
			if (!(typeof sessionFile === "string" && sessionFile.length > 0)) {
				// No persisted session file — claimPendingForHost finalized at claim
				// time. Retire collect records after their verdict was composed.
				for (const p of pending) {
					if (p.envelope.type === "report" && p.envelope.correlationId !== null) {
						takeCollectRequest(mainMailbox, p.envelope.correlationId, p.envelope.from);
					}
				}
			}
			lastMainDrain = {
				ids,
				persisted: typeof sessionFile === "string" && sessionFile.length > 0,
				collects,
			};
			return digest;
		},
		commitMainMailDrain: () => {
			lastMainDrain = null;
		},
		rollbackMainMailDrain: () => {
			const batch = lastMainDrain;
			lastMainDrain = null;
			if (!batch) return;
			if (batch.persisted) requeueHostClaim(mainMailbox, batch.ids);
			else requeueDoneHostClaim(mainMailbox, batch.ids);
			const pendingIds = new Set(readPending(mainMailbox).map(({ envelope }) => envelope.id));
			for (const collect of batch.collects) {
				// An alternate await marker may have finalized this report while
				// the racing ordinary digest injection failed. Restore schema only
				// when the report was actually requeued, never resurrect metadata
				// for an envelope already durable in .done/.
				if (pendingIds.has(collect.envelopeId)) {
					recordCollectRequest(mainMailbox, collect.correlationId, collect.schema, collect.from);
				}
			}
		},

		dispose: async () => {
			unsubscribeRequiredDelegation();
			requiredTasks.clear();
			requiredGroupActive = false;
			try {
				await runtime.dispose();
			} finally {
				hostLease.release();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Session-start GC (Phase 7)
// ---------------------------------------------------------------------------

/**
 * One retention sweep for a project cwd, without needing a live core:
 * .archive/ funerals, processed .done/ mail, resolved escalation records —
 * all under the settings-controlled archiveGcDays window (default 7).
 * index.ts fires this from session_start as cheap, unref'd async work.
 */
export function runGcSweepFor(cwd: string, locator: ScopeLocator): GcSweepResult {
	const layout = layoutFor(cwd, locator);
	const { settings } = loadSettings(layout);
	return gcSweep(layout, { days: settings.archiveGcDays });
}

/**
 * Out-of-band reconciliation helper for tests/recovery tooling. Normal startup
 * performs the same reconciliation inside createCore's newly acquired host
 * lease. This helper first claims a temporary lease; only that exclusive path
 * may classify an unverified append as crash-lost and requeue it. If a live
 * host owns the scope, verified mail may finalize but unverified mail remains
 * in flight. Idempotent and cheap (one directory scan; session files cached).
 */
export function reconcileMainMailFor(cwd: string, locator: ScopeLocator): HostDeliveryReconcile {
	const layout = layoutFor(cwd, locator);
	let recoveryLease: HostScopeLease | null = null;
	try {
		// Claiming a temporary host lease makes the "fresh process, therefore an
		// unverified append was lost" inference atomic with normal host startup.
		// If a live owner already exists, reconciliation may finalize verified
		// records but MUST leave unverified delivery in flight.
		recoveryLease = claimHostScope(layout);
	} catch (error) {
		if (!(error instanceof SessionScopeLockedError)) throw error;
		return reconcileHostDelivery(layout.mainMailboxDir, {
			marker: MAIN_MAIL_CUSTOM_TYPE,
			requeueUndelivered: false,
		});
	}
	try {
		return reconcileHostDelivery(layout.mainMailboxDir, {
			marker: MAIN_MAIL_CUSTOM_TYPE,
			requeueUndelivered: true,
		});
	} finally {
		recoveryLease.release();
	}
}

// ---------------------------------------------------------------------------
// Archive listing (read side of store/archive.ts's move; Phase 6 picker)
// ---------------------------------------------------------------------------

/** Marker filename store/archive.ts stamps on retirement. */
const RETIRED_AT_FILE = ".retired-at";

function listArchived(archiveRoot: string): ArchivedAgentInfo[] {
	if (!existsSync(archiveRoot)) return [];
	const out: ArchivedAgentInfo[] = [];
	for (const typeName of readdirSync(archiveRoot).sort()) {
		const typeDir = join(archiveRoot, typeName);
		let ids: string[];
		try {
			ids = readdirSync(typeDir);
		} catch {
			continue; // a stray file, not a type dir
		}
		for (const id of ids.sort()) {
			const dir = join(typeDir, id);
			let retiredAt: string | null = null;
			try {
				const stamp = readFileSync(join(dir, RETIRED_AT_FILE), "utf8").trim();
				if (!Number.isNaN(Date.parse(stamp))) retiredAt = stamp;
			} catch {
				// No marker — old archive; still listed.
			}
			let sessionFile: string | null = null;
			try {
				const jsonl = readdirSync(dir)
					.filter((name) => name.endsWith(".jsonl"))
					.sort();
				sessionFile = jsonl.length > 0 ? join(dir, jsonl[jsonl.length - 1]!) : null;
			} catch {
				// Unreadable dir — transcript unavailable.
			}
			out.push({
				address: `${typeName}/${id}`,
				type: typeName,
				id,
				archiveDir: dir,
				retiredAt,
				sessionFile,
			});
		}
	}
	// Newest funerals first (picker section order).
	return out.sort((a, b) => (b.retiredAt ?? "").localeCompare(a.retiredAt ?? ""));
}
