/**
 * mail/mailbox.ts — the on-disk mailbox: one file per envelope, processed in
 * ulid order, at-least-once (02-envelope-contract §Ordering & at-least-once).
 *
 * Life of an envelope file under <mailboxDir> (agent mailbox or .main/mailbox,
 * paths from store/layout.ts):
 *
 *   <msg-id>.json           written atomically by delivery (tmp + rename)
 *   <msg-id>.json.attempt   stamped by beginDelivery() when a receiving turn
 *                           starts consuming it
 *   .done/<msg-id>.json     moved by markDone() only AFTER the receiving turn
 *                           was durably appended to the session JSONL
 *   .corrupt/<msg-id>.json  quarantined by readPending() when the file fails
 *                           to parse/validate (kept for debugging; keeps
 *                           pendingCount honest — see readPending)
 *
 * A crash between beginDelivery and markDone leaves the envelope in place with
 * its .attempt marker — the next wake re-delivers it and readPending reports
 * redelivered:true so the digest can label it (at-least-once, never lost).
 *
 * MAIN-mailbox extra state (the host owns the main session JSONL, so there is
 * no after-append hook — durability is closed by RECONCILIATION instead):
 *
 *   .delivering/<msg-id>.json       moved by beginHostDelivery() when the
 *                                   composed digest is handed to the host
 *   .delivering/<msg-id>.json.meta  { sessionFile } — where the digest was
 *                                   injected (written BEFORE the move)
 *
 * reconcileHostDelivery() later checks the recorded session JSONL for the
 * envelope id (every digest embeds it) on a line carrying our customType
 * marker: found → finalize to .done/; missing → the injection was lost
 * (crash before the host append) and the envelope is requeued as pending
 * (redelivered:true) — at-least-once for the main mailbox too.
 *
 * Also owns the two small sender-side JSON indexes (paths from layout):
 *   .sent-questions.json    envelopeId → question text (digest quoting, D14)
 *   .collect-requests.json  envelopeId → schema (collect validation, D16/03)
 *
 * fs-only module: no runtime imports; all paths derive from store/layout.ts
 * helpers.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../store/registry.ts";
import {
	attemptMarkerOf,
	collectRequestsFileOf,
	deliveringMetaOf,
	mailboxDeliveringDirOf,
	mailboxDoneDirOf,
	sentQuestionsFileOf,
} from "../store/layout.ts";
import { type Envelope, validateEnvelope } from "./envelope.ts";

/** Envelope filename shape: msg_<ulid>.json (envelope ids double as names). */
const ENVELOPE_FILE_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}\.json$/;

// ---------------------------------------------------------------------------
// Write / read / done
// ---------------------------------------------------------------------------

/** Durably write one envelope into a mailbox (atomic tmp + rename). */
export function writeEnvelope(mailboxDir: string, envelope: Envelope): string {
	mkdirSync(mailboxDir, { recursive: true });
	const file = join(mailboxDir, `${envelope.id}.json`);
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(envelope, null, "\t")}\n`, "utf8");
	renameSync(tmp, file);
	return file;
}

export interface PendingEnvelope {
	envelope: Envelope;
	/** Absolute path of the envelope file. */
	file: string;
	/** True if a previous delivery attempt was never marked done (crash) — the digest labels it. */
	redelivered: boolean;
}

/**
 * All unprocessed envelopes in ulid (= filename) order. Files that fail to
 * parse or validate are QUARANTINED into <mailboxDir>/.corrupt/ (kept for
 * debugging, emits nothing), never thrown on — a corrupt envelope must not
 * wedge the whole mailbox. Quarantining (rather than skipping in place) keeps
 * readPending and pendingCount in agreement: a skipped-but-counted file made
 * the runtime's end-of-turn drain reschedule forever, a synchronous microtask
 * loop that starved the host event loop (C1 fix).
 */
export function readPending(mailboxDir: string): PendingEnvelope[] {
	if (!existsSync(mailboxDir)) return [];
	const pending: PendingEnvelope[] = [];
	const names = readdirSync(mailboxDir)
		.filter((name) => ENVELOPE_FILE_RE.test(name))
		.sort();
	for (const name of names) {
		const file = join(mailboxDir, name);
		let envelope: Envelope;
		try {
			envelope = JSON.parse(readFileSync(file, "utf8")) as Envelope;
		} catch {
			quarantineEnvelopeFile(mailboxDir, name);
			continue;
		}
		if (validateEnvelope(envelope).length > 0) {
			quarantineEnvelopeFile(mailboxDir, name);
			continue;
		}
		pending.push({ envelope, file, redelivered: existsSync(attemptMarkerOf(file)) });
	}
	return pending;
}

/**
 * Move an unparsable/invalid envelope file to <mailboxDir>/.corrupt/ so it no
 * longer counts as pending but stays on disk for debugging. Best-effort: any
 * fs failure here must never break mail reading. (Path computed inline — a
 * mailbox-internal sibling like .done/, deliberately not in store/layout.ts.)
 */
function quarantineEnvelopeFile(mailboxDir: string, name: string): void {
	const file = join(mailboxDir, name);
	try {
		const corruptDir = join(mailboxDir, ".corrupt");
		mkdirSync(corruptDir, { recursive: true });
		renameSync(file, join(corruptDir, name));
	} catch {
		// Could not quarantine (permissions/races) — fall back to deleting the
		// attempt marker only; the file will be retried/requarantined next read.
	}
	rmSync(attemptMarkerOf(file), { force: true });
}

/** Unprocessed-envelope count (📬 widget, quiet-queue accounting). */
export function pendingCount(mailboxDir: string): number {
	if (!existsSync(mailboxDir)) return 0;
	return readdirSync(mailboxDir).filter((name) => ENVELOPE_FILE_RE.test(name)).length;
}

/**
 * Stamp delivery-attempt markers for the envelopes a receiving turn is about
 * to consume. Idempotent; a marker that survives a crash flags re-delivery.
 */
export function beginDelivery(mailboxDir: string, envelopeIds: string[]): void {
	for (const id of envelopeIds) {
		const marker = attemptMarkerOf(join(mailboxDir, `${id}.json`));
		if (!existsSync(marker)) writeFileSync(marker, "", "utf8");
	}
}

/**
 * Move processed envelopes to .done/ and drop their attempt markers. Call
 * ONLY after the receiving turn is durably in the session JSONL (the
 * at-least-once contract) — never before or during the turn.
 */
export function markDone(mailboxDir: string, envelopeIds: string[]): void {
	const doneDir = mailboxDoneDirOf(mailboxDir);
	mkdirSync(doneDir, { recursive: true });
	for (const id of envelopeIds) {
		const file = join(mailboxDir, `${id}.json`);
		if (existsSync(file)) renameSync(file, join(doneDir, `${id}.json`));
		rmSync(attemptMarkerOf(file), { force: true });
	}
}

// ---------------------------------------------------------------------------
// MAIN-mailbox host-delivery reconciliation (at-least-once without an
// after-append hook — see the module header)
// ---------------------------------------------------------------------------

/**
 * Park composed-into-a-digest envelopes in .delivering/ instead of finalizing
 * them: the digest was handed to the HOST for injection into the main session
 * JSONL, but the append is not yet verified. For each envelope the target
 * `sessionFile` is recorded in a sibling .meta BEFORE the envelope moves, so
 * every crash window degrades to at-least-once:
 *   - crash before the move → envelope still pending (orphan meta is swept by
 *     the next reconcile) → recomposed next drain;
 *   - crash after the move → reconcileHostDelivery decides from the JSONL.
 * Call ONLY for the main mailbox (subagent appends are runtime-owned and use
 * markDone directly).
 */
export function beginHostDelivery(mailboxDir: string, envelopeIds: string[], sessionFile: string): void {
	const deliveringDir = mailboxDeliveringDirOf(mailboxDir);
	mkdirSync(deliveringDir, { recursive: true });
	for (const id of envelopeIds) {
		const file = join(mailboxDir, `${id}.json`);
		if (!existsSync(file)) continue;
		const parked = join(deliveringDir, `${id}.json`);
		writeFileSync(
			deliveringMetaOf(parked),
			`${JSON.stringify({ sessionFile, recordedAt: new Date().toISOString() })}\n`,
			"utf8",
		);
		renameSync(file, parked);
		rmSync(attemptMarkerOf(file), { force: true });
	}
}

export interface HostDeliveryReconcile {
	/** Envelope ids verified in their session JSONL and finalized to .done/. */
	finalized: string[];
	/** Envelope ids whose injection was lost — moved back to pending (redelivered). */
	requeued: string[];
	/** Envelope ids left in .delivering/ (injection may still be in flight). */
	inFlight: string[];
}

export interface ReconcileHostDeliveryOptions {
	/**
	 * A JSONL line counts as the delivered digest only if it contains BOTH the
	 * envelope id and this marker (the extension's customType prefix) — the id
	 * alone can leak into the session via tool results (e.g. subagent_status
	 * listing outstanding question ids) and must not finalize undelivered mail.
	 */
	marker: string;
	/**
	 * True (session_start, fresh process): an unverified envelope is a CRASH
	 * LOSS — requeue it as pending so the next drain re-delivers. False
	 * (in-process reconcile at the next drain): the host append may still be
	 * in flight — leave it in .delivering/ (never re-deliver in-process: that
	 * would double-deliver and double-charge the D21 pool).
	 */
	requeueUndelivered: boolean;
}

/**
 * Settle the .delivering/ state against the source of truth — the recorded
 * main session JSONL files. Delivered (id + marker found on one line) →
 * finalize to .done/. Not delivered → requeue as pending (with an .attempt
 * marker so the digest labels the re-delivery) or leave in flight, per
 * options. Orphan .meta files (crash between meta write and move) are swept.
 * Best-effort per envelope: one unreadable file never wedges the mailbox.
 */
export function reconcileHostDelivery(
	mailboxDir: string,
	options: ReconcileHostDeliveryOptions,
): HostDeliveryReconcile {
	const out: HostDeliveryReconcile = { finalized: [], requeued: [], inFlight: [] };
	const deliveringDir = mailboxDeliveringDirOf(mailboxDir);
	if (!existsSync(deliveringDir)) return out;
	let names: string[];
	try {
		names = readdirSync(deliveringDir).sort();
	} catch {
		return out;
	}
	const sessionCache = new Map<string, string[] | null>(); // file → lines (null = unreadable)
	const readSessionLines = (file: string): string[] | null => {
		if (!sessionCache.has(file)) {
			try {
				sessionCache.set(file, readFileSync(file, "utf8").split("\n"));
			} catch {
				sessionCache.set(file, null);
			}
		}
		return sessionCache.get(file) ?? null;
	};

	const envelopeNames = names.filter((name) => ENVELOPE_FILE_RE.test(name));
	// Sweep orphan metas first (crash between meta write and envelope move —
	// the envelope is still pending and will be recomposed; the meta is stale).
	for (const name of names) {
		if (!name.endsWith(".meta")) continue;
		if (!envelopeNames.includes(name.slice(0, -".meta".length))) {
			rmSync(join(deliveringDir, name), { force: true });
		}
	}

	for (const name of envelopeNames) {
		const id = name.slice(0, -".json".length);
		const parked = join(deliveringDir, name);
		const metaFile = deliveringMetaOf(parked);
		let sessionFile: string | null = null;
		try {
			const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { sessionFile?: unknown };
			if (typeof meta.sessionFile === "string") sessionFile = meta.sessionFile;
		} catch {
			// Missing/corrupt meta — treat as unverifiable (undelivered).
		}
		const lines = sessionFile !== null ? readSessionLines(sessionFile) : null;
		const delivered =
			lines !== null && lines.some((line) => line.includes(id) && line.includes(options.marker));
		try {
			if (delivered) {
				const doneDir = mailboxDoneDirOf(mailboxDir);
				mkdirSync(doneDir, { recursive: true });
				renameSync(parked, join(doneDir, name));
				rmSync(metaFile, { force: true });
				out.finalized.push(id);
			} else if (options.requeueUndelivered) {
				const restored = join(mailboxDir, name);
				renameSync(parked, restored);
				writeFileSync(attemptMarkerOf(restored), "", "utf8"); // digest labels the re-delivery
				rmSync(metaFile, { force: true });
				out.requeued.push(id);
			} else {
				out.inFlight.push(id);
			}
		} catch {
			out.inFlight.push(id); // fs race — settled on a later reconcile
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Sender-side indexes
// ---------------------------------------------------------------------------

function readIndex(file: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	return parsed;
}

/** Remember a question this mailbox's owner sent, for digest quoting (D14). */
export function recordSentQuestion(mailboxDir: string, envelopeId: string, text: string): void {
	const file = sentQuestionsFileOf(mailboxDir);
	const index = readIndex(file);
	index[envelopeId] = text;
	atomicWriteJson(file, index);
}

/** The original question text behind an answer's correlationId, if on record. */
export function lookupSentQuestion(mailboxDir: string, correlationId: string): string | undefined {
	const value = readIndex(sentQuestionsFileOf(mailboxDir))[correlationId];
	return typeof value === "string" ? value : undefined;
}

/**
 * Drop consumed questions from the sent index. Called AFTER the wake digest
 * that quoted them was composed and the correlated `answer`/`error` envelopes
 * were markDone'd — an answered question will never be quoted again, and
 * without this delete the index grows one entry per question for the agent's
 * whole life (and is rewritten in full each time: O(n²) I/O). Missing ids are
 * ignored; the file is rewritten only when something actually matched.
 */
export function deleteSentQuestions(mailboxDir: string, envelopeIds: string[]): void {
	if (envelopeIds.length === 0) return;
	const file = sentQuestionsFileOf(mailboxDir);
	const index = readIndex(file);
	let changed = false;
	for (const id of envelopeIds) {
		if (id in index) {
			delete index[id];
			changed = true;
		}
	}
	if (changed) atomicWriteJson(file, index);
}

/** Remember an outstanding collect request (envelopeId → schema). */
export function recordCollectRequest(mailboxDir: string, envelopeId: string, schema: unknown): void {
	const file = collectRequestsFileOf(mailboxDir);
	const index = readIndex(file);
	index[envelopeId] = schema;
	atomicWriteJson(file, index);
}

/**
 * Pop the schema of an outstanding collect request matching a report's
 * correlationId, or undefined if the report isn't a collect result.
 */
export function takeCollectRequest(mailboxDir: string, correlationId: string): unknown {
	const file = collectRequestsFileOf(mailboxDir);
	const index = readIndex(file);
	if (!(correlationId in index)) return undefined;
	const schema = index[correlationId];
	delete index[correlationId];
	atomicWriteJson(file, index);
	return schema;
}
