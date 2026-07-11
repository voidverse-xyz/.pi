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
import { atomicWriteJson, withFileLockSync } from "../store/registry.ts";
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
		// The filename id and the body id must agree — the id defines processing
		// order AND is what reconciliation/markDone key off. A mismatch (corrupt
		// state, a hand-edited file) would otherwise re-deliver forever, since
		// markDone(<body-id>) never removes the <filename-id>.json file. Quarantine
		// it like any other invalid envelope.
		if (envelope.id !== name.slice(0, -".json".length)) {
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
				// This envelope is now durably delivered — the finalize point where
				// a collect request may be retired (finding 8). Read the parked
				// envelope BEFORE the move; a report carrying a correlationId whose
				// collect request is still on record has now delivered its verdict,
				// so pop the schema. Best-effort — a parse failure never blocks
				// finalization.
				retireCollectRequestOf(mailboxDir, parked);
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

interface SentQuestionRecord {
	text: string;
	expectedFrom: string;
}

function sentQuestionRecord(value: unknown): SentQuestionRecord | null {
	if (typeof value === "string") return { text: value, expectedFrom: "" }; // legacy index
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	return typeof record.text === "string" && typeof record.expectedFrom === "string"
		? { text: record.text, expectedFrom: record.expectedFrom }
		: null;
}

/** Remember a question plus its intended responder, for digest quoting/integrity. */
export function recordSentQuestion(mailboxDir: string, envelopeId: string, text: string, expectedFrom = ""): void {
	const file = sentQuestionsFileOf(mailboxDir);
	withFileLockSync(file, () => {
		const index = readIndex(file);
		index[envelopeId] = expectedFrom === "" ? text : ({ text, expectedFrom } satisfies SentQuestionRecord);
		atomicWriteJson(file, index);
	});
}

/** The original question text, only for its intended responder (legacy entries accept any). */
export function lookupSentQuestion(mailboxDir: string, correlationId: string, from?: string): string | undefined {
	const record = sentQuestionRecord(readIndex(sentQuestionsFileOf(mailboxDir))[correlationId]);
	if (!record || (record.expectedFrom !== "" && from !== undefined && record.expectedFrom !== from && from !== "main")) return undefined;
	return record.text;
}

/**
 * Drop consumed questions from the sent index. Called AFTER the wake digest
 * that quoted them was composed and the correlated `answer`/`error` envelopes
 * were markDone'd — an answered question will never be quoted again, and
 * without this delete the index grows one entry per question for the agent's
 * whole life (and is rewritten in full each time: O(n²) I/O). Missing ids are
 * ignored; the file is rewritten only when something actually matched.
 */
export function deleteSentQuestions(
	mailboxDir: string,
	answers: Array<string | { correlationId: string; from: string }>,
): void {
	if (answers.length === 0) return;
	const file = sentQuestionsFileOf(mailboxDir);
	withFileLockSync(file, () => {
		const index = readIndex(file);
		let changed = false;
		for (const answer of answers) {
			const id = typeof answer === "string" ? answer : answer.correlationId;
			const record = sentQuestionRecord(index[id]);
			const expectedMatches =
				typeof answer === "string" || record?.expectedFrom === "" || record?.expectedFrom === answer.from || answer.from === "main";
			if (record && expectedMatches) {
				delete index[id];
				changed = true;
			}
		}
		if (changed) atomicWriteJson(file, index);
	});
}

interface CollectRequestRecord {
	__subagentsCollectRequest: 1;
	schema: unknown;
	expectedFrom: string;
}

function collectRequestRecord(value: unknown): CollectRequestRecord | null {
	if (value === undefined) return null;
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (record.__subagentsCollectRequest === 1 && "schema" in record && typeof record.expectedFrom === "string") {
			return { __subagentsCollectRequest: 1, schema: record.schema, expectedFrom: record.expectedFrom };
		}
	}
	return { __subagentsCollectRequest: 1, schema: value, expectedFrom: "" }; // legacy schema-only index
}

/** Remember an outstanding collect request and its intended responder. */
export function recordCollectRequest(
	mailboxDir: string,
	envelopeId: string,
	schema: unknown,
	expectedFrom = "",
): void {
	const file = collectRequestsFileOf(mailboxDir);
	withFileLockSync(file, () => {
		const index = readIndex(file);
		index[envelopeId] = expectedFrom === ""
			? schema
			: ({ __subagentsCollectRequest: 1, schema, expectedFrom } satisfies CollectRequestRecord);
		atomicWriteJson(file, index);
	});
}

/**
 * The schema of an outstanding collect request matching a report's
 * correlationId, WITHOUT removing it (finding 8), or undefined if the report
 * isn't a collect result. Used while COMPOSING the wake digest: the schema must
 * survive until the report is DURABLY delivered, so a crash-then-requeue still
 * carries the verdict. The record is deleted only at the finalize point
 * (takeCollectRequest, called when the envelope moves to .done/).
 */
export function peekCollectRequest(mailboxDir: string, correlationId: string, from?: string): unknown {
	const record = collectRequestRecord(readIndex(collectRequestsFileOf(mailboxDir))[correlationId]);
	if (!record || (record.expectedFrom !== "" && from !== undefined && record.expectedFrom !== from && from !== "main")) return undefined;
	return record.schema;
}

/**
 * Pop (read + delete) the schema of an outstanding collect request matching a
 * report's correlationId, or undefined if none. Call ONLY at the finalize point
 * — once the report is durably delivered — never during compose (finding 8): a
 * report requeued after a crash must still find its schema.
 */
export function takeCollectRequest(mailboxDir: string, correlationId: string, from?: string): unknown {
	const file = collectRequestsFileOf(mailboxDir);
	return withFileLockSync(file, () => {
		const index = readIndex(file);
		const record = collectRequestRecord(index[correlationId]);
		if (!record || (record.expectedFrom !== "" && from !== undefined && record.expectedFrom !== from && from !== "main")) return undefined;
		delete index[correlationId];
		atomicWriteJson(file, index);
		return record.schema;
	});
}

/**
 * At an envelope's finalize point, retire the collect request it fulfilled (if
 * any): a durably-delivered `report` whose correlationId matches a recorded
 * collect request has delivered its verdict, so pop the schema (finding 8).
 * Best-effort — a missing/unparsable envelope file is simply ignored.
 */
function retireCollectRequestOf(mailboxDir: string, envelopeFile: string): void {
	let envelope: Envelope;
	try {
		envelope = JSON.parse(readFileSync(envelopeFile, "utf8")) as Envelope;
	} catch {
		return;
	}
	if (envelope.type === "report" && typeof envelope.correlationId === "string") {
		takeCollectRequest(mailboxDir, envelope.correlationId, envelope.from);
	}
}
