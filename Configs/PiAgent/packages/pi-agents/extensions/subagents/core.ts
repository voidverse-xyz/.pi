/**
 * core.ts — the facade over runtime + store + typedefs + mail (D23 structural
 * rule 1).
 *
 * The ONLY module tools/ and tui/ import. It owns wiring (layout → runtime),
 * read-side joins, and the MAIN agent's mailbox mechanics; the runtime stays
 * swappable behind runtime/types.ts — this file holds a SubagentRuntime,
 * never the in-process class, past construction.
 *
 * Phase-3 surface: the full power-matrix passthroughs (spawn, send, steer,
 * interrupt, retire, collect, status, peek), sendAsUser (D17), and main-mail
 * plumbing for all-mail auto-wake: onMainMail notification, unread count
 * (📬 status, Phase 6), and drainMainMail() — compose the wake digest
 * over .main/mailbox/ (validating collect results against their recorded
 * schemas on the way) and park the envelopes in .delivering/ until the
 * injected digest is verified in the main session JSONL (reconciliation:
 * drainMainMail finalizes in-process, reconcileMainMailFor requeues crash
 * losses at session_start — main-mailbox at-least-once).
 *
 * Phase 4 adds the D21 rails: the consolidated settings object (autoWake,
 * maxConcurrent, maxHops, autonomousTurns, autonomousTokens — doc defaults)
 * and the ONE subagent AutonomyBudget per core. The runtime meters subagent
 * turns and drains on resume; main-agent mailbox wakeups are deliberately not
 * charged to or gated by this pool. index.ts resets the agent pool on user
 * input. queuedMailCount() + autonomy.status() feed the paused status.
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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { collectResultNote, validateAgainstSchema } from "./mail/collect.ts";
import { composeWakeDigest, type DigestItem } from "./mail/digest.ts";
import { ENVELOPE_ID_RE, type Envelope } from "./mail/envelope.ts";
import {
	claimPendingForHost,
	type HostDeliveryReconcile,
	lookupSentQuestion,
	peekCollectRequest,
	pendingCount,
	readPending,
	reconcileHostDelivery,
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
import { claimHostScope, ensureScopeManifest, type HostScopeLease } from "./store/session-scope.ts";
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

/** Read the durable abort latch for one owning main session. */
export function mainAutoWakeBlockedFor(cwd: string, locator: ScopeLocator): boolean {
	return existsSync(layoutFor(cwd, locator).mainAutoWakeLatchFile);
}

/** Persist/clear the abort latch for one owning main session. */
export function setMainAutoWakeBlockedFor(cwd: string, locator: ScopeLocator, blocked: boolean): void {
	const file = layoutFor(cwd, locator).mainAutoWakeLatchFile;
	if (!blocked) {
		rmSync(file, { force: true });
		return;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "blocked\n", { mode: 0o600 });
}

/**
 * The customType (prefix) index.ts stamps on every main-mail digest message
 * it injects into the host session ("subagent-mail" and "subagent-mail-wake"
 * both contain it). Reconciliation uses it to recognize OUR injected digests
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
	interrupt(to: string): Promise<InterruptResult>;
	retire(to: string): Promise<RetireResult>;
	collect(to: string, schema: unknown): Promise<CollectResult>;
	/** Cancellable join for an anchored final/collect report in main mail. */
	awaitResult(options: AwaitOptions): Promise<AwaitResult>;
	status(): Promise<RosterEntry[]>;
	peek(address: string, tail?: number): Promise<AgentDetail | null>;
	/** Merged type libraries (project wins), for spawn UX and errors (D6). */
	availableTypes(): AvailableType[];

	/**
	 * Unprocessed envelopes across all SUBAGENT mailboxes — while the system is
	 * paused this is the "queued mail" figure for the D21 banner (add
	 * mainUnreadCount() for the full picture). Cheap directory scans.
	 */
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

	for (;;) {
		if (options.signal?.aborted) throw new Error("subagent_await cancelled");
		const relevant = readPending(mailbox)
			.filter((pending) => pending.envelope.from === options.to && pending.envelope.id > options.anchorId)
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
			const terminalId = relevant[terminalIndex]!.envelope.id;
			const terminal = claimed.find(({ envelope }) => envelope.id === terminalId)?.envelope;
			if (!terminal) continue; // a concurrent claim won; re-scan durable state
			const progress = claimed
				.map(({ envelope }) => envelope)
				.filter((envelope) => envelope.type === "report" && envelope.id !== terminal.id)
				.map(awaitEnvelopeView);
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
			// Non-persisted host delivery finalized at claim time, so this is the
			// collect-index finalization point for that path.
			if (!options.sessionFile && options.waitFor === "collect") {
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

		if (!getAgent(readRegistry(layout.registryFile), options.to)) {
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
			// D15 ceiling defaults read LIVE off the settings object (like the
			// autonomy limits) — a settings edit applies at the next turn.
			ceilings: settings,
			...(options.onMainMail ? { onMainMail: options.onMainMail } : {}),
		});
	} catch (error) {
		hostLease.release();
		throw error;
	}
	const mainMailbox = layout.mainMailboxDir;

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
		spawn: (spawnOptions) => {
			// Validate the team name at the spawn boundary — BEFORE runtime.spawn
			// commits any registry record (finding 11). The old flow committed the
			// record first and only then called addTo, so a bad name (e.g.
			// "__proto__") threw AFTER the roster was mutated, leaving partial
			// state. Rejecting here keeps spawn all-or-nothing for every caller.
			if (spawnOptions.team !== undefined && !isValidTeamName(spawnOptions.team)) {
				return Promise.reject(
					new Error(
						`Invalid team name ${JSON.stringify(spawnOptions.team)} — use a slug ` +
							"(letters, digits, and ._-, not starting with a dot), not a reserved word " +
							"(__proto__/prototype/constructor) or empty string.",
					),
				);
			}
			return runtime.spawn(spawnOptions);
		},
		send: (sendOptions) => runtime.send(sendOptions),
		sendAsUser: (sendOptions) => runtime.sendAsUser(sendOptions),
		steer: (to, text) => runtime.steer(to, text),
		interrupt: (to) => runtime.interrupt(to),
		retire: (to) => runtime.retire(to),
		collect: (to, schema) => runtime.collect(to, schema),
		awaitResult: (awaitOptions) => awaitMainResult(layout, awaitOptions),
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
			return digest;
		},

		dispose: async () => {
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
 * Session-start reconciliation of the main mailbox's .delivering/ state,
 * without needing a live core (index.ts fires this before the lazy core
 * exists). A fresh session_start is the one point where "not in the recorded
 * session JSONL" can only mean the injection was LOST (no host append can
 * still be in flight), so undelivered envelopes are requeued as pending —
 * the next drain re-composes them into a fresh digest (at-least-once);
 * verified ones finalize to .done/ (exactly once). Idempotent and cheap
 * (one directory scan; session files read once each).
 */
export function reconcileMainMailFor(cwd: string, locator: ScopeLocator): HostDeliveryReconcile {
	const layout = layoutFor(cwd, locator);
	return reconcileHostDelivery(layout.mainMailboxDir, {
		marker: MAIN_MAIL_CUSTOM_TYPE,
		requeueUndelivered: true,
	});
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
