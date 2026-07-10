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
