/**
 * store/archive.ts — retire = deregister + MOVE, never delete (D13).
 *
 * Retiring an agent moves its whole dir (sessions, mailbox, files) to
 * .archive/<type>/<id>/ so post-mortem viewing keeps working (the TUI picker's
 * collapsed .archive section), then a periodic GC sweep removes archives older
 * than N days (default 7). The same N-day policy applies to processed mail in
 * mailbox/.done/ (02-envelope-contract), so the .done sweeper lives here too.
 *
 * Registry removal and teams scrub are the caller's job (retire orchestration
 * is runtime work); this module owns only the disk moves.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "./layout.ts";
import { atomicWriteJson, listAgents, readRegistry, withFileLockSync } from "./registry.ts";

/** Marker file inside an archived agent dir recording when it was retired. */
const RETIRED_AT_FILE = ".retired-at";

/**
 * The retirement-tombstone filename (Finding 13). Exported so the runtime can
 * detect a crash-interrupted retire — an instance dir that already carries this
 * marker was tombstoned but not yet moved to .archive/, and the startup
 * reconciliation finishes its funeral.
 */
export const RETIREMENT_TOMBSTONE = RETIRED_AT_FILE;

/** True if `dir` carries a retirement tombstone (a crash-interrupted retire). */
export function hasRetirementTombstone(dir: string): boolean {
	return existsSync(join(dir, RETIRED_AT_FILE));
}

export const DEFAULT_GC_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Move a retired agent's dir to the archive, collision-safe: if
 * .archive/<type>/<id>/ already holds an earlier funeral, the new archive gets
 * a `-2`, `-3`, ... suffix instead of clobbering it.
 *
 * The retirement marker is written INTO THE SOURCE dir BEFORE the rename
 * (Finding 13), so the tombstone travels WITH the move and the archived dir is
 * never observed marker-less: a concurrent gcArchive always sees a stamp (and,
 * being recent, keeps it), and a crash after the marker write but before the
 * rename leaves a tombstoned instance dir the runtime's startup reconciliation
 * finishes archiving. The marker was previously written AFTER the rename,
 * leaving a window where GC could age the archive by its (post-rename) mtime.
 *
 * Returns the archive dir the agent landed in, or null if the agent dir
 * didn't exist (already archived — retire is idempotent on disk).
 */
export function archiveAgentDir(layout: Layout, type: string, id: string, now: Date = new Date()): string | null {
	const source = layout.agentInstanceDir(type, id);
	if (!existsSync(source)) return null;

	const base = layout.archiveDir(type, id);
	let target = base;
	for (let n = 2; existsSync(target); n++) target = `${base}-${n}`;

	// Tombstone first (into the source), then move atomically — the archived
	// dir carries its marker the instant it exists.
	try {
		writeFileSync(join(source, RETIRED_AT_FILE), `${now.toISOString()}\n`, "utf8");
	} catch {
		// Best-effort: a missing marker falls back to the dir mtime in the GC clock.
	}
	mkdirSync(dirname(target), { recursive: true });
	renameSync(source, target);
	return target;
}

export interface GcOptions {
	/** Archives older than this are removed. Default 7. */
	days?: number;
	/** Clock override (tests). */
	now?: Date;
}

/**
 * Sweep .archive/: remove archived agent dirs retired more than N days ago
 * (marker file; falls back to dir mtime for archives missing one). Type dirs
 * left empty are removed too. Returns the deleted archive dirs.
 */
export function gcArchive(layout: Layout, options: GcOptions = {}): string[] {
	const cutoff = (options.now ?? new Date()).getTime() - (options.days ?? DEFAULT_GC_DAYS) * DAY_MS;
	const root = layout.archiveRoot;
	try {
		if (!lstatSync(root).isDirectory()) return []; // never traverse a symlink root
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const deleted: string[] = [];
	for (const typeEntry of readdirSync(root, { withFileTypes: true })) {
		if (!typeEntry.isDirectory()) continue;
		const typeDir = join(root, typeEntry.name);
		for (const idEntry of readdirSync(typeDir, { withFileTypes: true })) {
			if (!idEntry.isDirectory()) continue;
			const archiveDir = join(typeDir, idEntry.name);
			if (retiredAtMs(archiveDir) < cutoff) {
				rmSync(archiveDir, { recursive: true, force: true });
				deleted.push(archiveDir);
			}
		}
		// Non-recursive removal of a supposedly-empty type dir (Finding 13): a
		// fresh archive (or an in-flight retire's tombstoned move) can land in
		// this type dir between the readdir check and the remove — rmdirSync
		// then fails with ENOTEMPTY and we skip it, instead of `rm -rf`
		// nuking a just-created sibling archive.
		try {
			if (readdirSync(typeDir).length === 0) rmdirSync(typeDir);
		} catch {
			// Non-empty (raced) or unreadable — leave it; next sweep revisits.
		}
	}
	return deleted;
}

function retiredAtMs(archiveDir: string): number {
	try {
		const stamp = readFileSync(join(archiveDir, RETIRED_AT_FILE), "utf8").trim();
		const ms = Date.parse(stamp);
		if (!Number.isNaN(ms)) return ms;
	} catch {
		// No/unreadable marker — fall back to the directory's mtime.
	}
	return statSync(archiveDir).mtimeMs;
}

/**
 * Sweep one mailbox/.done/ dir with the same N-day policy: processed
 * envelopes older than the cutoff (file mtime) are deleted. Returns the
 * deleted file paths. Callers enumerate agents' .done dirs via layout.
 */
export function gcDoneDir(doneDir: string, options: GcOptions = {}): string[] {
	const cutoff = (options.now ?? new Date()).getTime() - (options.days ?? DEFAULT_GC_DAYS) * DAY_MS;
	try {
		// The quarantine root itself is a reserved directory, never a traversal
		// point. Refuse symlink/non-directory roots so GC cannot delete entries in
		// an out-of-scope target.
		if (!lstatSync(doneDir).isDirectory()) return [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const deleted: string[] = [];
	for (const entry of readdirSync(doneDir, { withFileTypes: true })) {
		const file = join(doneDir, entry.name);
		if (lstatSync(file).mtimeMs < cutoff) {
			// Quarantine can contain structural impostors (e.g. a directory named
			// msg_<id>.json). Never follow symlinks, but age out every entry kind so
			// corrupt state cannot create a permanent disk leak.
			rmSync(file, { recursive: entry.isDirectory(), force: true });
			deleted.push(file);
		}
	}
	return deleted;
}

/**
 * Sweep .main/escalations/ (Phase 7): RESOLVED records (approved/denied/
 * cancelled) older than N days are deleted; pending records are NEVER touched
 * (a blocked agent may still be waiting on them). Age = resolvedAt (falls
 * back to createdAt, then file mtime for unparsable records). Returns the
 * deleted file paths.
 */
export function gcEscalationRecords(escalationsDir: string, options: GcOptions = {}): string[] {
	const cutoff = (options.now ?? new Date()).getTime() - (options.days ?? DEFAULT_GC_DAYS) * DAY_MS;
	try {
		if (!lstatSync(escalationsDir).isDirectory()) return []; // never traverse a symlink root
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const deleted: string[] = [];
	for (const entry of readdirSync(escalationsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const file = join(escalationsDir, entry.name);
		let ageMs: number;
		try {
			const record = JSON.parse(readFileSync(file, "utf8")) as {
				status?: string;
				resolvedAt?: string | null;
				createdAt?: string;
			};
			if (record.status === "pending") continue; // never GC a live wait
			const stamp = record.resolvedAt ?? record.createdAt;
			const parsedMs = stamp !== undefined && stamp !== null ? Date.parse(stamp) : Number.NaN;
			ageMs = Number.isNaN(parsedMs) ? statSync(file).mtimeMs : parsedMs;
		} catch {
			ageMs = statSync(file).mtimeMs; // corrupt record — age by mtime
		}
		if (ageMs < cutoff) {
			rmSync(file, { force: true });
			deleted.push(file);
		}
	}
	return deleted;
}

/**
 * Age-prune a mailbox's `.collect-requests.json` index. Entries are keyed by
 * the collect request's envelope id (`msg_<ulid>`) whose ULID timestamp IS
 * the request time — takeCollectRequest deletes an entry when the matching
 * report arrives, but a target that dies/retires without ever reporting
 * leaves its entry behind forever. Entries older than the cutoff (plus any
 * key that isn't a decodable envelope id — garbage no report can ever match)
 * are dropped; the file is rewritten only when something was pruned.
 * Returns the pruned envelope ids.
 */
function gcEnvelopeIdIndex(file: string, options: GcOptions): string[] {
	const cutoff = (options.now ?? new Date()).getTime() - (options.days ?? DEFAULT_GC_DAYS) * DAY_MS;
	try {
		return withFileLockSync(file, () => {
			let index: Record<string, unknown>;
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
				index = parsed as Record<string, unknown>;
			} catch {
				return []; // missing/corrupt index — nothing to prune
			}
			const pruned: string[] = [];
			for (const id of Object.keys(index)) {
				const bornMs = ulidTimestampMs(id);
				if (bornMs === null || bornMs < cutoff) {
					delete index[id];
					pruned.push(id);
				}
			}
			if (pruned.length > 0) atomicWriteJson(file, index);
			return pruned;
		});
	} catch {
		return []; // lock/write failure — report nothing pruned
	}
}

export function gcCollectRequests(mailboxDir: string, options: GcOptions = {}): string[] {
	return gcEnvelopeIdIndex(join(mailboxDir, ".collect-requests.json"), options);
}

/** Age-prune durable task/collect generation anchors after their retry window. */
export function gcAwaitAnchors(mailboxDir: string, options: GcOptions = {}): string[] {
	return gcEnvelopeIdIndex(join(mailboxDir, ".await-anchors.json"), options);
}

/** Crockford-base32 digit values, as used by mail/envelope.ts's ulid(). */
const B32_VALUES = new Map([..."0123456789ABCDEFGHJKMNPQRSTVWXYZ"].map((c, i) => [c, i] as const));

/** The ms timestamp encoded in a `msg_<ulid>` envelope id, or null. */
function ulidTimestampMs(envelopeId: string): number | null {
	if (!/^msg_[0-9A-HJKMNP-TV-Z]{26}$/.test(envelopeId)) return null;
	let ms = 0;
	for (const char of envelopeId.slice(4, 14)) {
		const digit = B32_VALUES.get(char);
		if (digit === undefined) return null;
		ms = ms * 32 + digit;
	}
	return ms;
}

/** What one gcSweep pass removed (Phase 7 session_start GC). */
export interface GcSweepResult {
	/** Deleted archived-agent dirs. */
	archives: string[];
	/** Deleted processed envelopes across the main + every agent .done/ dir. */
	doneFiles: string[];
	/** Deleted resolved escalation records. */
	escalations: string[];
	/** Deleted quarantined envelopes across the main + every agent .corrupt/ dir. */
	corruptFiles: string[];
	/** Aged-out `.collect-requests.json` entries (envelope ids) across all mailboxes. */
	collectRequests: string[];
	/** Aged-out durable await-anchor ownership records from the main mailbox. */
	awaitAnchors: string[];
}

/**
 * The whole Phase 7 GC pass for one project layout, with one N-day policy:
 * .archive/ funerals, processed mail in the main mailbox's and every
 * registered agent's .done/ dir (and their .corrupt/ quarantine siblings —
 * kept for debugging, not forever), aged-out collect-request index entries,
 * and resolved escalation records. Cheap: directory scans only; safe to run
 * on every session start.
 */
export function gcSweep(layout: Layout, options: GcOptions = {}): GcSweepResult {
	const doneFiles = [...gcDoneDir(layout.mainMailboxDoneDir, options)];
	// .corrupt/ is a mailbox-internal sibling of .done/ (mail/mailbox.ts
	// quarantine), deliberately not in store/layout.ts — same age policy.
	const corruptFiles = [...gcDoneDir(join(layout.mainMailboxDir, ".corrupt"), options)];
	const collectRequests = [...gcCollectRequests(layout.mainMailboxDir, options)];
	const awaitAnchors = [...gcAwaitAnchors(layout.mainMailboxDir, options)];
	let agents: ReturnType<typeof listAgents> = [];
	try {
		agents = listAgents(readRegistry(layout.registryFile));
	} catch {
		// Unreadable registry must not block the other sweeps.
	}
	for (const record of agents) {
		const mailboxDir = layout.mailboxDir(record.type, record.id);
		doneFiles.push(...gcDoneDir(layout.mailboxDoneDir(record.type, record.id), options));
		corruptFiles.push(...gcDoneDir(join(mailboxDir, ".corrupt"), options));
		collectRequests.push(...gcCollectRequests(mailboxDir, options));
	}
	return {
		archives: gcArchive(layout, options),
		doneFiles,
		escalations: gcEscalationRecords(layout.escalationsDir, options),
		corruptFiles,
		collectRequests,
		awaitAnchors,
	};
}
