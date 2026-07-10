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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "./layout.ts";
import { listAgents, readRegistry } from "./registry.ts";

/** Marker file inside an archived agent dir recording when it was retired. */
const RETIRED_AT_FILE = ".retired-at";

export const DEFAULT_GC_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Move a retired agent's dir to the archive, collision-safe: if
 * .archive/<type>/<id>/ already holds an earlier funeral, the new archive gets
 * a `-2`, `-3`, ... suffix instead of clobbering it. Stamps a retirement
 * marker for the GC clock (dir mtimes don't survive renames meaningfully).
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

	mkdirSync(dirname(target), { recursive: true });
	renameSync(source, target);
	writeFileSync(join(target, RETIRED_AT_FILE), `${now.toISOString()}\n`, "utf8");
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
	if (!existsSync(root)) return [];

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
		if (readdirSync(typeDir).length === 0) rmSync(typeDir, { recursive: true, force: true });
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
	if (!existsSync(doneDir)) return [];

	const deleted: string[] = [];
	for (const entry of readdirSync(doneDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const file = join(doneDir, entry.name);
		if (statSync(file).mtimeMs < cutoff) {
			rmSync(file, { force: true });
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
	if (!existsSync(escalationsDir)) return [];

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

/** What one gcSweep pass removed (Phase 7 session_start GC). */
export interface GcSweepResult {
	/** Deleted archived-agent dirs. */
	archives: string[];
	/** Deleted processed envelopes across the main + every agent .done/ dir. */
	doneFiles: string[];
	/** Deleted resolved escalation records. */
	escalations: string[];
}

/**
 * The whole Phase 7 GC pass for one project layout, with one N-day policy:
 * .archive/ funerals, processed mail in the main mailbox's and every
 * registered agent's .done/ dir, and resolved escalation records. Cheap:
 * directory scans only; safe to run on every session start.
 */
export function gcSweep(layout: Layout, options: GcOptions = {}): GcSweepResult {
	const doneFiles = [...gcDoneDir(layout.mainMailboxDoneDir, options)];
	let agents: ReturnType<typeof listAgents> = [];
	try {
		agents = listAgents(readRegistry(layout.registryFile));
	} catch {
		// Unreadable registry must not block the other sweeps.
	}
	for (const record of agents) {
		doneFiles.push(...gcDoneDir(layout.mailboxDoneDir(record.type, record.id), options));
	}
	return {
		archives: gcArchive(layout, options),
		doneFiles,
		escalations: gcEscalationRecords(layout.escalationsDir, options),
	};
}
