/**
 * sandbox/escalation.ts — the waiting-state plumbing behind the D10 human
 * gate (05-tui-spec §4; Phase 6 builds the modal, this is what it calls).
 *
 * When a guarded tool call needs a human, the wrapped tool awaits
 * `request()`, which:
 *   (a) persists a pending escalation record under
 *       <subagents>/.main/escalations/<id>.json (path from store/layout.ts),
 *   (b) sends an `escalation` envelope to main through the existing mail
 *       machinery (surfaced by the active barrier or next real user turn so the MAIN AGENT can
 *       react/deny/re-plan — but per D10 only the HUMAN ever approves),
 *   (c) parks the agent in `waiting` (onWaiting hook: registry state +
 *       scheduler-slot release) and BLOCKS the tool call as a promise — a
 *       clean in-process async pause, no teardown; the pause may last
 *       forever if the user is absent (BY DESIGN — that is what the waiting
 *       state is for),
 *   (d) resolves through the resolution API: approve(id) lets the tool
 *       proceed; deny(id, note?) makes the tool return an error result the
 *       agent reacts to (note included).
 *
 * Resolution API surface: `approve` is for the HUMAN UI only (Phase 6
 * modal / core passthrough). The MAIN AGENT gets NO new tool — it reacts via
 * mail; its one power here is deny: a main `subagent_send` whose
 * correlationId is the escalation envelope's id lands in `denyByEnvelope`
 * (runtime wires it), text becoming the deny note. Approval can never ride
 * that path (01-power-matrix: approvals never flow downhill).
 *
 * APPROVE-ONCE ONLY (D22): a resolution covers exactly the one blocked call;
 * nothing is remembered. The durable fix for repeat escalations is editing
 * the type's frontmatter.
 *
 * An aborted turn (interrupt/retire/dispose mid-wait) cancels the pending
 * escalation via the tool call's AbortSignal — records are marked
 * `cancelled`, the promise rejects, and the aborting turn unwinds normally.
 */

import { readdirSync, readFileSync } from "node:fs";
import { ulid } from "../mail/envelope.ts";
import { atomicWriteJson } from "../store/registry.ts";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type EscalationStatus = "pending" | "approved" | "denied" | "cancelled";

export interface EscalationRecord {
	/** `esc_<ulid>` — unique, sortable; doubles as the record filename stem. */
	id: string;
	/** The blocked agent's address `<type>/<id>`. */
	agent: string;
	/** Tool that was blocked (bash | edit | write). */
	tool: string;
	/** One-line summary of the blocked input (command / target path). */
	inputSummary: string;
	/** Why the sandbox blocked it (paths.ts / bash-guard.ts reason). */
	reason: string;
	status: EscalationStatus;
	/** The escalation envelope delivered to main; null if delivery failed. */
	envelopeId: string | null;
	/** Deny note (deny-with-note redirects the agent in the same action). */
	note: string | null;
	createdAt: string;
	resolvedAt: string | null;
}

export type EscalationResolution = { approved: true } | { approved: false; note: string | null };

export type EscalationEvent =
	| { type: "escalation-created"; escalation: EscalationRecord }
	| { type: "escalation-resolved"; escalation: EscalationRecord };

/** What a guarded tool asks for (the runtime pins `agent`). */
export interface EscalationRequest {
	agent: string;
	tool: string;
	inputSummary: string;
	reason: string;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface EscalationManagerOptions {
	/** <subagents>/.main/escalations (store/layout.ts). */
	escalationsDir: string;
	/** Record path for one id (store/layout.ts — the single path authority). */
	escalationFile: (escalationId: string) => string;
	/**
	 * Deliver the escalation envelope to main (runtime wires the Deliverer).
	 * Returns the envelope id, or null if delivery failed — the escalation
	 * still pends either way (the record + TUI widget remain the fallback).
	 */
	notifyMain: (record: EscalationRecord) => string | null;
	/** Settle main-mail notification that became obsolete before the wait began/resumed. */
	onObsoleteNotification?: (record: EscalationRecord) => void;
	/** The agent just blocked: registry → `waiting`, scheduler slot released. */
	onWaiting: (agent: string) => void;
	/**
	 * A pending escalation was approved or denied: re-acquire a scheduler
	 * slot and put the agent back to `running` BEFORE the tool proceeds /
	 * errors. May wait for a free slot.
	 */
	onResolved: (agent: string, resolution: EscalationResolution) => Promise<void>;
	/** Runtime event fan-out (Phase 6 modal + widget). */
	emit?: (event: EscalationEvent) => void;
	/** Clock override (tests). */
	now?: () => Date;
}

interface PendingEntry {
	record: EscalationRecord;
	/** A human decision was made; slot/lifecycle restoration is still in flight. */
	resolving: boolean;
	settle: (resolution: EscalationResolution) => void;
	cancel: (reason: string) => void;
}

export class EscalationManager {
	private readonly _o: EscalationManagerOptions;
	private readonly _pending = new Map<string, PendingEntry>();

	constructor(options: EscalationManagerOptions) {
		this._o = options;
	}

	/**
	 * Block one guarded tool call on a human decision. Resolves on
	 * approve/deny; rejects if the turn is aborted (signal) — the tool then
	 * unwinds with the abort.
	 */
	request(input: EscalationRequest, signal: AbortSignal | undefined): Promise<EscalationResolution> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Tool call aborted before escalation could be raised."));
		}
		const now = (this._o.now?.() ?? new Date()).toISOString();
		const record: EscalationRecord = {
			id: `esc_${ulid()}`,
			agent: input.agent,
			tool: input.tool,
			inputSummary: input.inputSummary,
			reason: input.reason,
			status: "pending",
			envelopeId: null,
			note: null,
			createdAt: now,
			resolvedAt: null,
		};
		this._persist(record);

		return new Promise<EscalationResolution>((resolve, reject) => {
			let entry: PendingEntry;
			const onAbort = (): void => {
				if (this._pending.get(record.id) !== entry) return;
				this._pending.delete(record.id);
				entry.cancel("Tool call aborted while waiting for human approval — escalation cancelled.");
			};
			const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
			const settleObsoleteNotification = (): void => {
				try {
					this._o.onObsoleteNotification?.({ ...record });
				} catch {
					// Lifecycle/startup reconciliation retries from the durable record.
				}
			};
			entry = {
				record,
				resolving: false,
				settle: (resolution) => {
					cleanup();
					resolve(resolution);
				},
				cancel: (reason) => {
					cleanup();
					try {
						this._finalize(record, "cancelled", null);
					} catch {
						// Keep the last valid atomic record; startup reconciliation retries.
					}
					settleObsoleteNotification();
					reject(new Error(reason));
				},
			};
			this._pending.set(record.id, entry);
			// Install the abort handler BEFORE notifyMain: delivery callbacks may
			// re-enter interrupt/dispose synchronously. Re-check immediately because
			// adding a listener to an already-aborted signal does not fire it.
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			try {
				record.envelopeId = this._o.notifyMain(record);
				this._persist(record);
			} catch (error) {
				if (this._pending.get(record.id) === entry) this._pending.delete(record.id);
				const message = error instanceof Error ? error.message : String(error);
				entry.cancel(`Could not raise escalation: ${message}`);
				return;
			}
			if (this._pending.get(record.id) !== entry || signal?.aborted) {
				settleObsoleteNotification();
				return;
			}
			try {
				this._o.emit?.({ type: "escalation-created", escalation: { ...record } });
				if (this._pending.get(record.id) === entry) this._o.onWaiting(input.agent);
			} catch (error) {
				if (this._pending.get(record.id) === entry) this._pending.delete(record.id);
				const message = error instanceof Error ? error.message : String(error);
				entry.cancel(`Could not enter escalation wait: ${message}`);
			}
		});
	}

	/** Pending escalations, oldest first (Phase 6 modal queue + ⚠ widget). */
	pending(): EscalationRecord[] {
		return [...this._pending.values()]
			.filter((entry) => entry.record.status === "pending")
			.map((entry) => ({ ...entry.record }))
			.sort((a, b) => (a.id < b.id ? -1 : 1));
	}

	/** Pending or resolution-in-flight entries used by lifecycle cancellation. */
	active(agent?: string): EscalationRecord[] {
		return [...this._pending.values()]
			.filter((entry) => agent === undefined || entry.record.agent === agent)
			.map((entry) => ({ ...entry.record }));
	}

	/** HUMAN-only (D10): approve once. False if the id is not pending. */
	approve(id: string): boolean {
		return this._resolve(id, { approved: true });
	}

	/** Deny (human, or main agent via mail). The note rides the tool error. */
	deny(id: string, note?: string): boolean {
		return this._resolve(id, { approved: false, note: note ?? null });
	}

	/**
	 * The main agent's deny path (no new tool surface): a main send whose
	 * correlationId equals the escalation ENVELOPE id denies, its text the
	 * note. Never approves, by construction. False if nothing matched.
	 */
	denyByEnvelope(envelopeId: string, note: string): boolean {
		for (const entry of this._pending.values()) {
			if (entry.record.status === "pending" && entry.record.envelopeId === envelopeId) {
				return this.deny(entry.record.id, note);
			}
		}
		return false;
	}

	/** Cancel every pending escalation for one agent (retire path). */
	cancelFor(agent: string, reason: string): void {
		for (const entry of [...this._pending.values()]) {
			if (entry.record.agent === agent) {
				this._pending.delete(entry.record.id);
				entry.cancel(reason);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private _resolve(id: string, resolution: EscalationResolution): boolean {
		const entry = this._pending.get(id);
		if (!entry || entry.resolving || entry.record.status !== "pending") return false;
		entry.resolving = true;
		try {
			this._finalize(
				entry.record,
				resolution.approved ? "approved" : "denied",
				resolution.approved ? null : resolution.note,
			);
		} catch {
			entry.resolving = false;
			return false; // still pending; the human may retry or abort safely
		}
		try {
			this._o.onObsoleteNotification?.({ ...entry.record });
		} catch {
			// Terminal audit state is durable; startup reconciliation retries mail.
		}
		// Keep the entry cancellable until slot re-acquisition + live-state
		// restoration succeed. retire()/dispose()/AbortSignal can therefore win a
		// race after the human decision but before the guarded tool resumes.
		void this._o
			.onResolved(entry.record.agent, resolution)
			.then(() => {
				if (this._pending.get(id) !== entry) return;
				this._pending.delete(id);
				entry.settle(resolution);
			})
			.catch((error) => {
				if (this._pending.get(id) !== entry) return;
				this._pending.delete(id);
				const message = error instanceof Error ? error.message : String(error);
				entry.cancel(`Could not resume after escalation resolution: ${message}`);
			});
		return true;
	}

	private _finalize(record: EscalationRecord, status: EscalationStatus, note: string | null): void {
		const previous = { status: record.status, note: record.note, resolvedAt: record.resolvedAt };
		record.status = status;
		record.note = note;
		record.resolvedAt = (this._o.now?.() ?? new Date()).toISOString();
		try {
			this._persist(record);
		} catch (error) {
			record.status = previous.status;
			record.note = previous.note;
			record.resolvedAt = previous.resolvedAt;
			throw error;
		}
		try {
			this._o.emit?.({ type: "escalation-resolved", escalation: { ...record } });
		} catch {
			// An observer cannot roll back a durable lifecycle decision.
		}
	}

	private _persist(record: EscalationRecord): void {
		atomicWriteJson(this._o.escalationFile(record.id), record);
	}
}

/** Read every persisted escalation record (audit / post-restart Phase 6 view). */
export function readEscalationRecords(escalationsDir: string): EscalationRecord[] {
	let files: string[];
	try {
		files = readdirSync(escalationsDir);
	} catch {
		return [];
	}
	const records: EscalationRecord[] = [];
	for (const file of files.sort()) {
		if (!file.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(readFileSync(`${escalationsDir}/${file}`, "utf8")) as EscalationRecord);
		} catch {
			// Unreadable record: skip (audit trail only).
		}
	}
	return records;
}
