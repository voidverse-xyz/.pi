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
 * plumbing for D16 selective auto-wake: onMainMail notification, unread
 * count (📬 widget, Phase 6), and drainMainMail() — compose the wake digest
 * over .main/mailbox/ (validating collect results against their recorded
 * schemas on the way) and park the envelopes in .delivering/ until the
 * injected digest is verified in the main session JSONL (reconciliation:
 * drainMainMail finalizes in-process, reconcileMainMailFor requeues crash
 * losses at session_start — main-mailbox at-least-once).
 *
 * Phase 4 adds the D21 rails: the consolidated settings object (autoWake,
 * maxConcurrent, maxHops, autonomousTurns, autonomousTokens — doc defaults)
 * and the ONE shared AutonomyBudget per core. The budget instance is handed
 * to the runtime (which meters every subagent turn and drains on resume) and
 * exposed here so index.ts can meter auto-woken MAIN turns, reset the pool on
 * user input, and gate auto-wakes while paused. queuedMailCount() +
 * autonomy.status() feed the Phase 6 paused banner.
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
import type { Envelope } from "./mail/envelope.ts";
import {
	beginDelivery,
	beginHostDelivery,
	type HostDeliveryReconcile,
	lookupSentQuestion,
	markDone,
	pendingCount,
	readPending,
	reconcileHostDelivery,
	takeCollectRequest,
} from "./mail/mailbox.ts";
import { AutonomyBudget } from "./rails/autonomy.ts";
import { InProcessRuntime } from "./runtime/in-process.ts";
import type { EscalationRecord } from "./sandbox/escalation.ts";
import type {
	AgentDetail,
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
import { listAgents, readRegistry } from "./store/registry.ts";
import {
	applySettingsInto,
	defaultSettings,
	loadSettings,
	type SubagentsSettings,
} from "./store/settings.ts";
import { listTypeDefs } from "./typedefs/discover.ts";
import { parseTypeFile } from "./typedefs/parse.ts";

// Re-exported so tools/tui/harnesses keep one import surface (D23 rule 1).
export { defaultSettings, type SubagentsSettings } from "./store/settings.ts";

/** Envelope types that auto-wake an idle main agent (D16, option c). */
export const WAKE_WORTHY_TYPES = ["question", "escalation", "error"] as const;

/**
 * The customType (prefix) index.ts stamps on every main-mail digest message
 * it injects into the host session ("subagent-mail" and "subagent-mail-wake"
 * both contain it). Reconciliation uses it to recognize OUR injected digests
 * in the main session JSONL: an envelope counts as delivered only when its id
 * appears on a JSONL line that also carries this marker — envelope ids alone
 * can leak into the session via tool results and must not finalize mail.
 */
export const MAIN_MAIL_CUSTOM_TYPE = "subagent-mail";

export interface CreateCoreOptions {
	/** Project cwd (layout scope, D3). */
	cwd: string;
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
	 * The session's ONE shared D21 autonomy pool. index.ts resets it on user
	 * input (before_agent_start), meters auto-woken main turns against it, and
	 * gates auto-wakes on `paused`; the runtime meters subagent turns and
	 * drains queued mailboxes on resume. `resume()` = the Phase 6 banner key.
	 */
	readonly autonomy: AutonomyBudget;

	spawn(options: SpawnOptions): Promise<SpawnResult>;
	send(options: SendOptions): Promise<SendResult>;
	sendAsUser(options: SendOptions): Promise<SendResult>;
	steer(to: string, text: string): Promise<SteerResult>;
	interrupt(to: string): Promise<InterruptResult>;
	retire(to: string): Promise<RetireResult>;
	collect(to: string, schema: unknown): Promise<CollectResult>;
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
	/** True if pending main mail contains a question|escalation|error (D16). */
	mainHasWakeWorthy(): boolean;
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

export function createCore(options: CreateCoreOptions): SubagentsCore {
	const layout = createLayout(options.cwd, options.home !== undefined ? { home: options.home } : {});
	// Phase 7 settings source: files first, programmatic overrides win.
	const loaded = loadSettings(layout);
	const settings: SubagentsSettings = { ...loaded.settings, ...options.settings };
	if (options.maxConcurrent !== undefined) settings.maxConcurrent = options.maxConcurrent;
	const settingsWarnings: string[] = [...loaded.warnings];
	const programmaticOverrides = {
		...options.settings,
		...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
	};
	// The one shared D21 pool — limits read live off the settings object.
	const autonomy = new AutonomyBudget(settings);
	const runtime: SubagentRuntime = new InProcessRuntime({
		layout,
		...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
		...(options.settingsManager ? { settingsManager: options.settingsManager } : {}),
		maxConcurrent: settings.maxConcurrent,
		maxHops: () => settings.maxHops,
		autonomy,
		// D15 ceiling defaults read LIVE off the settings object (like the
		// autonomy limits) — a settings edit applies at the next turn.
		ceilings: settings,
		...(options.onMainMail ? { onMainMail: options.onMainMail } : {}),
	});
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
		spawn: (spawnOptions) => runtime.spawn(spawnOptions),
		send: (sendOptions) => runtime.send(sendOptions),
		sendAsUser: (sendOptions) => runtime.sendAsUser(sendOptions),
		steer: (to, text) => runtime.steer(to, text),
		interrupt: (to) => runtime.interrupt(to),
		retire: (to) => runtime.retire(to),
		collect: (to, schema) => runtime.collect(to, schema),
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
		mainHasWakeWorthy: () =>
			readPending(mainMailbox).some((p) =>
				(WAKE_WORTHY_TYPES as readonly string[]).includes(p.envelope.type),
			),
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
			const pending = readPending(mainMailbox);
			if (pending.length === 0) return null;
			const ids = pending.map((p) => p.envelope.id);
			beginDelivery(mainMailbox, ids);

			const items: DigestItem[] = pending.map((p) => {
				// Collect-result validation on arrival (03-tool-surface): a
				// report whose correlationId matches a recorded collect request.
				let note: string | undefined;
				if (p.envelope.type === "report" && p.envelope.correlationId !== null) {
					const schema = takeCollectRequest(mainMailbox, p.envelope.correlationId);
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

			const digest = composeWakeDigest({
				items,
				questionLookup: (correlationId) => lookupSentQuestion(mainMailbox, correlationId),
			});
			// The host owns the main session JSONL — there is no "after durable
			// append" hook. Instead of finalizing here (the old, lossy
			// DEVIATION), park the envelopes in .delivering/ with the target
			// session file on record; reconciliation (above / session_start)
			// finalizes them once the injected digest — which embeds every
			// envelope id — is verifiably in that JSONL, and requeues them
			// after a crash that lost the injection. Without a persisted
			// session file nothing could ever verify delivery, so finalize at
			// compose time as before.
			if (typeof sessionFile === "string" && sessionFile.length > 0) {
				beginHostDelivery(mainMailbox, ids, sessionFile);
			} else {
				markDone(mainMailbox, ids);
			}
			return digest;
		},

		dispose: () => runtime.dispose(),
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
export function runGcSweepFor(cwd: string, home?: string): GcSweepResult {
	const layout = createLayout(cwd, home !== undefined ? { home } : {});
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
export function reconcileMainMailFor(cwd: string, home?: string): HostDeliveryReconcile {
	const layout = createLayout(cwd, home !== undefined ? { home } : {});
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
