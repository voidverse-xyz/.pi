/**
 * mail/mailbox.ts — file-per-message mailbox IO with at-least-once delivery.
 *
 * One JSON file per envelope under a mailbox dir. Processing order is envelope
 * id (ULID) order. At-least-once: an `.attempt` marker is stamped before the
 * receiving turn runs and removed only after the turn is durably appended
 * (markDone moves the file to `.done/`). A marker present at read time means a
 * crash between delivery and the append — the mail is RE-delivered and the
 * digest labels it. Unparseable / id-mismatched envelopes are quarantined to
 * `.corrupt/` so a poison message can't wedge the drain loop (v1 finding C1).
 *
 * v2 uses this uniform attempt-marker scheme for BOTH agent and main mailboxes
 * — there is no separate `.delivering`/JSONL-verify protocol (v1's brittlest
 * code). The single host lease (D7) means one writer, so plain atomic renames
 * suffice.
 *
 * Sender-side indexes (sent-questions, collect-requests) also live here.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	attemptMarkerOf,
	collectRequestsFileOf,
	doneEnvelopeFileOf,
	envelopeFileOf,
	mailboxCorruptDirOf,
	mailboxDoneDirOf,
	sentQuestionsFileOf,
} from "../store/layout.ts";
import { atomicWriteJson } from "../store/atomic.ts";
import { type Envelope, validateEnvelope } from "./envelope.ts";

/** Write an envelope into a mailbox (atomic). */
export function writeEnvelope(mailboxDir: string, envelope: Envelope): void {
	mkdirSync(mailboxDir, { recursive: true });
	atomicWriteJson(envelopeFileOf(mailboxDir, envelope.id), envelope);
}

export interface PendingEnvelope {
	envelope: Envelope;
	/** An attempt marker already existed → a prior delivery crashed before the append. */
	redelivered: boolean;
}

function quarantine(mailboxDir: string, fileName: string): void {
	const corruptDir = mailboxCorruptDirOf(mailboxDir);
	mkdirSync(corruptDir, { recursive: true });
	try {
		renameSync(join(mailboxDir, fileName), join(corruptDir, fileName));
	} catch {
		/* already gone */
	}
}

/** Read pending envelopes in id order. Quarantines bad files so the drain terminates. */
export function readPending(mailboxDir: string): PendingEnvelope[] {
	if (!existsSync(mailboxDir)) return [];
	const names = readdirSync(mailboxDir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.sort();
	const pending: PendingEnvelope[] = [];
	for (const name of names) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(mailboxDir, name), "utf8"));
		} catch {
			quarantine(mailboxDir, name);
			continue;
		}
		if (validateEnvelope(parsed).length > 0) {
			quarantine(mailboxDir, name);
			continue;
		}
		const envelope = parsed as Envelope;
		if (`${envelope.id}.json` !== name) {
			quarantine(mailboxDir, name); // filename↔id mismatch: corrupted state
			continue;
		}
		pending.push({ envelope, redelivered: existsSync(attemptMarkerOf(envelopeFileOf(mailboxDir, envelope.id))) });
	}
	return pending;
}

/**
 * Cheap pending count for scheduling decisions — a plain directory listing with NO
 * parse and NO quarantine side effects (readPending mutates state by moving corrupt
 * files, which is surprising on a hot path). May transiently over-count a corrupt
 * file until the next readPending drain quarantines it — self-correcting.
 */
export function pendingCount(mailboxDir: string): number {
	if (!existsSync(mailboxDir)) return 0;
	try {
		return readdirSync(mailboxDir).filter((name) => name.endsWith(".json") && !name.startsWith(".")).length;
	} catch {
		return 0;
	}
}

/** The lexically-max envelope id (= newest, since ids are ULIDs) across a mailbox's pending + .done, or null. */
export function maxEnvelopeId(mailboxDir: string): string | null {
	let max: string | null = null;
	for (const dir of [mailboxDir, mailboxDoneDirOf(mailboxDir)]) {
		if (!existsSync(dir)) continue;
		try {
			for (const name of readdirSync(dir)) {
				if (!name.endsWith(".json") || name.startsWith(".")) continue;
				const id = name.slice(0, -5);
				if (max === null || id > max) max = id;
			}
		} catch {
			/* ignore */
		}
	}
	return max;
}

/** Stamp the delivery-attempt marker before running the receiving turn. */
export function beginDelivery(mailboxDir: string, envelopeId: string): void {
	writeFileSync(attemptMarkerOf(envelopeFileOf(mailboxDir, envelopeId)), "", "utf8");
}

/** Move a processed envelope to `.done/` and drop its attempt marker. Call ONLY after a durable append. */
export function markDone(mailboxDir: string, envelopeId: string): void {
	const doneDir = mailboxDoneDirOf(mailboxDir);
	mkdirSync(doneDir, { recursive: true });
	// Move the envelope to .done BEFORE dropping the attempt marker: a crash between
	// the two leaves only an orphaned `<id>.json.attempt` in the live mailbox, which
	// is inert (it fails every endsWith(".json") filter in readPending/pendingCount/
	// maxEnvelopeId). The reverse order would leave the envelope in the live mailbox
	// with NO marker, so a crash would redeliver it unlabeled (redelivered:false).
	try {
		renameSync(envelopeFileOf(mailboxDir, envelopeId), doneEnvelopeFileOf(mailboxDir, envelopeId));
	} catch {
		/* already moved */
	}
	try {
		rmSync(attemptMarkerOf(envelopeFileOf(mailboxDir, envelopeId)), { force: true });
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Sender-side indexes
// ---------------------------------------------------------------------------

interface SentQuestion {
	text: string;
	/** The address expected to answer (so an unrelated sender can't spoof the quote). */
	expectedFrom: string;
}

function readJsonMap<T>(path: string): Record<string, T> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {}; // missing → empty (normal)
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, T>;
	} catch {
		/* fall through to quarantine */
	}
	// The file EXISTS but is corrupt/non-object. Don't silently overwrite it with a
	// near-empty map on the next record*() call (that would drop every other
	// outstanding entry with no trace) — move it aside for forensics first.
	try {
		renameSync(path, `${path}.corrupt-${randomBytes(4).toString("hex")}`);
	} catch {
		/* best effort */
	}
	return {};
}

/** Record a question we sent, so the wake digest can quote it when the answer arrives (D14). */
export function recordSentQuestion(mailboxDir: string, envelopeId: string, text: string, expectedFrom: string): void {
	const path = sentQuestionsFileOf(mailboxDir);
	const map = readJsonMap<SentQuestion>(path);
	map[envelopeId] = { text, expectedFrom };
	atomicWriteJson(path, map);
}

/** Look up the original text of a question we sent (by correlationId), gated on the answerer. */
export function lookupSentQuestion(mailboxDir: string, correlationId: string, from: string): string | undefined {
	const entry = readJsonMap<SentQuestion>(sentQuestionsFileOf(mailboxDir))[correlationId];
	if (!entry) return undefined;
	return entry.expectedFrom === from ? entry.text : undefined;
}

/** Drop sent-question entries once answered (called after markDone of the answer). */
export function deleteSentQuestion(mailboxDir: string, correlationId: string): void {
	const path = sentQuestionsFileOf(mailboxDir);
	const map = readJsonMap<SentQuestion>(path);
	if (correlationId in map) {
		delete map[correlationId];
		atomicWriteJson(path, map);
	}
}

interface CollectRequest {
	schema: unknown;
	/** The agent expected to fulfill it. */
	expectedFrom: string;
}

/** Record an outstanding collect request (main-side), keyed by request envelope id. */
export function recordCollectRequest(mailboxDir: string, requestId: string, schema: unknown, expectedFrom: string): void {
	const path = collectRequestsFileOf(mailboxDir);
	const map = readJsonMap<CollectRequest>(path);
	map[requestId] = { schema, expectedFrom };
	atomicWriteJson(path, map);
}

/** Peek a collect request's schema (non-destructive — take only after durable delivery). */
export function peekCollectRequest(mailboxDir: string, requestId: string, from: string): unknown | undefined {
	const entry = readJsonMap<CollectRequest>(collectRequestsFileOf(mailboxDir))[requestId];
	if (!entry) return undefined;
	return entry.expectedFrom === from ? entry.schema : undefined;
}

/** Remove a fulfilled collect request. */
export function takeCollectRequest(mailboxDir: string, requestId: string): void {
	const path = collectRequestsFileOf(mailboxDir);
	const map = readJsonMap<CollectRequest>(path);
	if (requestId in map) {
		delete map[requestId];
		atomicWriteJson(path, map);
	}
}
