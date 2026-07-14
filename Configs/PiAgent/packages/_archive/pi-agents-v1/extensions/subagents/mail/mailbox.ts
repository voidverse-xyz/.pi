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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, withFileLockSync } from "../store/registry.ts";
import {
	attemptMarkerOf,
	awaitAnchorsFileOf,
	collectRequestsFileOf,
	deliveringMetaOf,
	mailboxDeliveringDirOf,
	mailboxDoneDirOf,
	sentQuestionsFileOf,
} from "../store/layout.ts";
import { type Envelope, ENVELOPE_ID_RE, validateEnvelope } from "./envelope.ts";

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

export interface StoredHostEnvelope {
	envelope: Envelope;
	file: string;
	state: "delivering" | "done";
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
	const pending: PendingEnvelope[] = [];
	let names: string[];
	try {
		names = readdirSync(mailboxDir)
			.filter((name) => ENVELOPE_FILE_RE.test(name))
			.sort();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
	for (const name of names) {
		const file = join(mailboxDir, name);
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") continue; // claimed/retired after readdir
			if (code === "EISDIR") {
				quarantineEnvelopeFile(mailboxDir, name);
				continue;
			}
			throw error; // EIO/EMFILE/EACCES: retry; never corrupt valid durable mail
		}
		let envelope: Envelope;
		try {
			envelope = JSON.parse(raw) as Envelope;
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
 * Read already-claimed host mail for durable await/retry. Unlike pending mail,
 * invalid files are left in place for reconciliation/GC; operational I/O
 * failures propagate so an await never mistakes uncertainty for absence.
 */
export function readStoredHostEnvelopes(mailboxDir: string): StoredHostEnvelope[] {
	const out: StoredHostEnvelope[] = [];
	for (const [state, dir] of [
		["delivering", mailboxDeliveringDirOf(mailboxDir)],
		["done", mailboxDoneDirOf(mailboxDir)],
	] as const) {
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => ENVELOPE_FILE_RE.test(name)).sort();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") continue;
			throw error;
		}
		for (const name of names) {
			const file = join(dir, name);
			let raw: string;
			try {
				raw = readFileSync(file, "utf8");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") continue;
				throw error;
			}
			try {
				const envelope = JSON.parse(raw) as Envelope;
				if (validateEnvelope(envelope).length === 0 && name === `${envelope.id}.json`) {
					out.push({ envelope, file, state });
				}
			} catch {
				// Reconciliation owns malformed parked mail; done mail is retained
				// only for diagnostics/GC. Neither is evidence for await.
			}
		}
	}
	return out.sort((a, b) => a.envelope.id.localeCompare(b.envelope.id));
}

/**
 * Register another durable host record that may prove delivery of a parked
 * envelope. This is used when await observes a report already claimed by the
 * ordinary main digest: either that digest OR the await tool result may then
 * finalize the same envelope without requeueing it after a crash.
 */
export function addHostDeliveryMarker(
	mailboxDir: string,
	envelopeId: string,
	marker: string,
): "delivering" | "done" | null {
	const existsStrict = (file: string): boolean => {
		try {
			lstatSync(file);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return false;
			throw error;
		}
	};
	return withFileLockSync(join(mailboxDir, ".host-delivery"), () => {
		const done = join(mailboxDoneDirOf(mailboxDir), `${envelopeId}.json`);
		if (existsStrict(done)) return "done";
		const parked = join(mailboxDeliveringDirOf(mailboxDir), `${envelopeId}.json`);
		if (!existsStrict(parked)) return null;
		const metaFile = deliveringMetaOf(parked);
		const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
			sessionFile?: unknown;
			marker?: unknown;
			markers?: unknown;
			recordedAt?: unknown;
		};
		if (typeof meta.sessionFile !== "string" || meta.sessionFile.length === 0) {
			throw new Error(`Host-delivery metadata for ${envelopeId} has no session file.`);
		}
		const markers = new Set<string>();
		if (typeof meta.marker === "string" && meta.marker.length > 0) markers.add(meta.marker);
		if (Array.isArray(meta.markers)) {
			for (const value of meta.markers) if (typeof value === "string" && value.length > 0) markers.add(value);
		}
		markers.add(marker);
		atomicWriteJson(metaFile, {
			sessionFile: meta.sessionFile,
			recordedAt: typeof meta.recordedAt === "string" ? meta.recordedAt : new Date().toISOString(),
			markers: [...markers].sort(),
		});
		return "delivering";
	});
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
	try {
		return readdirSync(mailboxDir).filter((name) => ENVELOPE_FILE_RE.test(name)).length;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Missing/not-a-directory is the expected concurrent retirement rename.
		// Other failures are transient/operational: callers must retry or surface
		// them, never misclassify durable queued mail as an empty mailbox.
		if (code === "ENOENT" || code === "ENOTDIR") return 0;
		throw error;
	}
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
export function beginHostDelivery(
	mailboxDir: string,
	envelopeIds: string[],
	sessionFile: string,
	marker?: string,
): void {
	const deliveringDir = mailboxDeliveringDirOf(mailboxDir);
	mkdirSync(deliveringDir, { recursive: true });
	for (const id of envelopeIds) {
		const file = join(mailboxDir, `${id}.json`);
		if (!existsSync(file)) continue;
		const parked = join(deliveringDir, `${id}.json`);
		writeFileSync(
			deliveringMetaOf(parked),
			`${JSON.stringify({
				sessionFile,
				recordedAt: new Date().toISOString(),
				...(marker !== undefined ? { marker } : {}),
			})}\n`,
			"utf8",
		);
		renameSync(file, parked);
		rmSync(attemptMarkerOf(file), { force: true });
	}
}

/**
 * Atomically select and park main-mail envelopes before rendering them. This
 * closes the old read-then-move race between digest delivery and await.
 */
export function claimPendingForHost(
	mailboxDir: string,
	predicate: (pending: PendingEnvelope) => boolean,
	sessionFile: string | null | undefined,
	marker: string,
): PendingEnvelope[] {
	return withFileLockSync(join(mailboxDir, ".host-delivery"), () => {
		const selected = readPending(mailboxDir).filter(predicate);
		if (selected.length === 0) return [];
		const ids = selected.map((pending) => pending.envelope.id);
		beginDelivery(mailboxDir, ids);
		if (typeof sessionFile === "string" && sessionFile.length > 0) {
			beginHostDelivery(mailboxDir, ids, sessionFile, marker);
		} else {
			markDone(mailboxDir, ids);
		}
		return selected;
	});
}

function cancelHostDeliveryUnlocked(mailboxDir: string, envelopeIds: Iterable<string>): void {
	const deliveringDir = mailboxDeliveringDirOf(mailboxDir);
	const doneDir = mailboxDoneDirOf(mailboxDir);
	mkdirSync(doneDir, { recursive: true });
	for (const id of envelopeIds) {
		const pending = join(mailboxDir, `${id}.json`);
		const parked = join(deliveringDir, `${id}.json`);
		const done = join(doneDir, `${id}.json`);
		const source = existsSync(pending) ? pending : existsSync(parked) ? parked : null;
		if (source !== null) {
			if (existsSync(done)) rmSync(source, { force: true });
			else renameSync(source, done);
		}
		rmSync(attemptMarkerOf(pending), { force: true });
		rmSync(deliveringMetaOf(parked), { force: true });
	}
}

/**
 * Permanently settle host-bound envelopes that became obsolete while pending or
 * parked for JSONL verification (for example, a cancelled escalation). The
 * host-delivery lock makes this idempotent against digest/await claiming.
 */
export function cancelHostDelivery(mailboxDir: string, envelopeIds: string[]): void {
	withFileLockSync(join(mailboxDir, ".host-delivery"), () => {
		cancelHostDeliveryUnlocked(mailboxDir, envelopeIds);
	});
}

/**
 * Find and settle matching pending OR host-parked envelopes atomically. This is
 * the crash-recovery path for records whose envelope id was never persisted.
 */
export function cancelHostDeliveriesWhere(
	mailboxDir: string,
	predicate: (envelope: Envelope) => boolean,
): string[] {
	return withFileLockSync(join(mailboxDir, ".host-delivery"), () => {
		const ids = new Set(
			readPending(mailboxDir)
				.filter(({ envelope }) => predicate(envelope))
				.map(({ envelope }) => envelope.id),
		);
		const deliveringDir = mailboxDeliveringDirOf(mailboxDir);
		try {
			for (const name of readdirSync(deliveringDir)) {
				if (!ENVELOPE_FILE_RE.test(name)) continue;
				try {
					const envelope = JSON.parse(readFileSync(join(deliveringDir, name), "utf8")) as Envelope;
					if (validateEnvelope(envelope).length === 0 && name === `${envelope.id}.json` && predicate(envelope)) {
						ids.add(envelope.id);
					}
				} catch {
					// Corrupt parked mail is left for ordinary reconciliation/GC.
				}
			}
		} catch {
			// No delivering directory.
		}
		cancelHostDeliveryUnlocked(mailboxDir, ids);
		return [...ids].sort();
	});
}

/** Requeue a failed-to-render host claim without waiting for process restart. */
export function requeueHostClaim(mailboxDir: string, envelopeIds: string[]): void {
	withFileLockSync(join(mailboxDir, ".host-delivery"), () => {
		const deliveringDir = mailboxDeliveringDirOf(mailboxDir);
		for (const id of envelopeIds) {
			const parked = join(deliveringDir, `${id}.json`);
			if (!existsSync(parked)) continue;
			const restored = join(mailboxDir, `${id}.json`);
			renameSync(parked, restored);
			writeFileSync(attemptMarkerOf(restored), "", "utf8");
			rmSync(deliveringMetaOf(parked), { force: true });
		}
	});
}

/** Requeue a no-session claim that was provisionally finalized to `.done/`. */
export function requeueDoneHostClaim(mailboxDir: string, envelopeIds: string[]): void {
	withFileLockSync(join(mailboxDir, ".host-delivery"), () => {
		const doneDir = mailboxDoneDirOf(mailboxDir);
		for (const id of envelopeIds) {
			if (!ENVELOPE_ID_RE.test(id)) continue;
			const done = join(doneDir, `${id}.json`);
			if (!existsSync(done)) continue;
			const restored = join(mailboxDir, `${id}.json`);
			renameSync(done, restored);
			writeFileSync(attemptMarkerOf(restored), "", "utf8");
		}
	});
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
 * main session JSONL files. Delivered (a complete parsed custom-message record
 * with exact marker and id in its content) → finalize to .done/. Not delivered
 * → requeue as pending (with an .attempt
 * marker so the digest labels the re-delivery) or leave in flight, per
 * options. Orphan .meta files (crash between meta write and move) are swept.
 * Best-effort per envelope: one unreadable file never wedges the mailbox.
 */
function isCompleteHostDeliveryRecord(line: string, envelopeId: string, marker: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return false; // truncated/partial final JSONL line is not durable delivery
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const outer = parsed as Record<string, unknown>;
	const candidate =
		outer.type === "message" && typeof outer.message === "object" && outer.message !== null
			? outer.message as Record<string, unknown>
			: outer;
	if (candidate.type === "custom_message" || candidate.type === "custom-message") {
		const customType = candidate.customType;
		return (
			typeof customType === "string" &&
			(customType === marker || customType.startsWith(`${marker}-`)) &&
			typeof candidate.content === "string" &&
			candidate.content.includes(envelopeId)
		);
	}
	if (candidate.role === "toolResult" && candidate.toolName === marker) {
		try {
			const content = typeof candidate.content === "string"
				? candidate.content
				: JSON.stringify(candidate.content);
			return typeof content === "string" && content.includes(envelopeId);
		} catch {
			return false;
		}
	}
	return false;
}

export function reconcileHostDelivery(
	mailboxDir: string,
	options: ReconcileHostDeliveryOptions,
): HostDeliveryReconcile {
	return withFileLockSync(join(mailboxDir, ".host-delivery"), () =>
		reconcileHostDeliveryUnlocked(mailboxDir, options));
}

function reconcileHostDeliveryUnlocked(
	mailboxDir: string,
	options: ReconcileHostDeliveryOptions,
): HostDeliveryReconcile {
	const out: HostDeliveryReconcile = { finalized: [], requeued: [], inFlight: [] };
	const deliveringDir = mailboxDeliveringDirOf(mailboxDir);
	let names: string[];
	try {
		names = readdirSync(deliveringDir).sort();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return out;
		throw error;
	}
	type SessionRead = { lines: string[] | null; uncertain: boolean };
	const sessionCache = new Map<string, SessionRead>();
	const readSessionLines = (file: string): SessionRead => {
		if (!sessionCache.has(file)) {
			try {
				sessionCache.set(file, { lines: readFileSync(file, "utf8").split("\n"), uncertain: false });
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// A missing target means no append could have landed there. Any
				// other I/O failure is uncertainty, never evidence of non-delivery.
				sessionCache.set(file, {
					lines: null,
					uncertain: code !== "ENOENT" && code !== "ENOTDIR",
				});
			}
		}
		return sessionCache.get(file)!;
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
		let metaUncertain = false;
		const markers = new Set<string>();
		try {
			const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
				sessionFile?: unknown;
				marker?: unknown;
				markers?: unknown;
			};
			if (typeof meta.sessionFile === "string") sessionFile = meta.sessionFile;
			if (typeof meta.marker === "string" && meta.marker.length > 0) markers.add(meta.marker);
			if (Array.isArray(meta.markers)) {
				for (const marker of meta.markers) {
					if (typeof marker === "string" && marker.length > 0) markers.add(marker);
				}
			}
		} catch (error) {
			// Missing/corrupt metadata is a crash artifact and therefore
			// unverifiable. Operational read failures are different: fail closed.
			if (!(error instanceof SyntaxError)) {
				const code = (error as NodeJS.ErrnoException).code;
				metaUncertain = code !== "ENOENT" && code !== "ENOTDIR";
			}
		}
		// Protocol-1 metadata has one `marker`; protocol-2 may carry several
		// accepted proofs. Only fall back to the caller's marker when metadata
		// supplied none — never let an unrelated digest finalize an await claim.
		if (markers.size === 0) markers.add(options.marker);
		const sessionRead = sessionFile !== null
			? readSessionLines(sessionFile)
			: { lines: null, uncertain: false };
		if (metaUncertain || sessionRead.uncertain) {
			out.inFlight.push(id);
			continue;
		}
		const delivered = sessionRead.lines !== null && sessionRead.lines.some((line) =>
			[...markers].some((marker) => isCompleteHostDeliveryRecord(line, id, marker)));
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

interface AwaitAnchorRecord {
	to: string;
	generationId: string;
}

/** Persist the recipient incarnation that owns a task/collect await anchor. */
export function recordAwaitAnchor(
	mainMailboxDir: string,
	envelopeId: string,
	to: string,
	generationId: string,
): void {
	const file = awaitAnchorsFileOf(mainMailboxDir);
	withFileLockSync(file, () => {
		const index = readIndex(file);
		index[envelopeId] = { to, generationId } satisfies AwaitAnchorRecord;
		atomicWriteJson(file, index);
	});
}

/** Resolve an anchor only for its exact intended recipient. */
export function lookupAwaitAnchorGeneration(
	mainMailboxDir: string,
	envelopeId: string,
	to: string,
): string | undefined {
	const value = readIndex(awaitAnchorsFileOf(mainMailboxDir))[envelopeId];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return record.to === to && typeof record.generationId === "string" && /^gen_[0-9a-f]{32}$/.test(record.generationId)
		? record.generationId
		: undefined;
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
