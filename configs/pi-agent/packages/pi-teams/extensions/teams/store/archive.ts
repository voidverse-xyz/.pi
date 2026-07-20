/**
 * store/archive.ts — retirement (move-not-delete) + N-day GC (D13).
 *
 * Retire moves an agent's instance dir into `.archive/<type>/<id>/` with a
 * `.retired-at` marker, so a retired oneshot is still viewable post-mortem until
 * GC. Retirement is the only destructive lifecycle op; the move preserves memory
 * on disk (the address is deregistered separately by the runtime).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mailboxDoneDirOf, type Layout } from "./layout.ts";

export const RETIREMENT_MARKER = ".retired-at";

/** The retirement marker's content: the true address + retirement time (JSON). */
interface RetirementMarker {
	address: string;
	retiredAt: string;
}

/** Read the retirement marker (JSON — archiveAgentDir is the only writer). */
function readRetirementMarker(dir: string): { address?: string; retiredAt?: string } {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, RETIREMENT_MARKER), "utf8")) as Partial<RetirementMarker>;
		if (parsed && typeof parsed === "object") {
			return {
				...(typeof parsed.address === "string" ? { address: parsed.address } : {}),
				...(typeof parsed.retiredAt === "string" ? { retiredAt: parsed.retiredAt } : {}),
			};
		}
	} catch {
		/* missing or corrupt → callers fall back (dir name / mtime) */
	}
	return {};
}

/** Move an agent instance dir to .archive/. Returns the archive path, or null if nothing to move. */
export function archiveAgentDir(layout: Layout, type: string, id: string, nowIso: string): string | null {
	const src = layout.agentInstanceDir(type, id);
	if (!existsSync(src)) return null;
	let dest = layout.archiveDir(type, id);
	// Collision (a prior same-address retire): suffix. The TRUE address is stored in
	// the marker, so an id that legitimately ends in `-<digits>` is never mis-reported.
	let n = 2;
	while (existsSync(dest)) dest = `${layout.archiveDir(type, id)}-${n++}`;
	mkdirSync(join(dest, ".."), { recursive: true });
	renameSync(src, dest);
	const marker: RetirementMarker = { address: `${type}/${id}`, retiredAt: nowIso };
	writeFileSync(join(dest, RETIREMENT_MARKER), JSON.stringify(marker), "utf8");
	return dest;
}

export interface ArchivedInfo {
	address: string;
	retiredAt?: string;
}

/** List retired agents under .archive/<type>/<id>/. */
export function readArchived(layout: Layout): ArchivedInfo[] {
	const root = layout.archiveRoot;
	if (!existsSync(root)) return [];
	const out: ArchivedInfo[] = [];
	for (const type of safeReaddir(root)) {
		const typeDir = join(root, type);
		if (!isDir(typeDir)) continue;
		for (const id of safeReaddir(typeDir)) {
			const dir = join(typeDir, id);
			if (!isDir(dir)) continue;
			const marker = readRetirementMarker(dir);
			// Prefer the marker's true address; fall back to the dir name with the
			// collision suffix stripped only when no marker recorded the address.
			const address = marker.address ?? `${type}/${id.replace(/-\d+$/, "")}`;
			out.push({ address, ...(marker.retiredAt ? { retiredAt: marker.retiredAt } : {}) });
		}
	}
	return out.sort((a, b) => a.address.localeCompare(b.address));
}

/** Delete archived dirs whose retirement is older than `days`. Returns count removed. */
export function gcArchive(layout: Layout, days: number, nowMs: number): number {
	const root = layout.archiveRoot;
	if (!existsSync(root) || days <= 0) return 0;
	const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
	let removed = 0;
	for (const type of safeReaddir(root)) {
		const typeDir = join(root, type);
		if (!isDir(typeDir)) continue;
		for (const id of safeReaddir(typeDir)) {
			const dir = join(typeDir, id);
			if (!isDir(dir)) continue;
			const retiredAt = readRetirementMarker(dir).retiredAt;
			let retiredMs = retiredAt ? Date.parse(retiredAt) : 0;
			if (Number.isNaN(retiredMs)) retiredMs = 0;
			// No/invalid marker → fall back to the dir mtime.
			if (!retiredMs) {
				try {
					retiredMs = statSync(dir).mtimeMs;
				} catch {
					continue;
				}
			}
			if (retiredMs < cutoff) {
				rmSync(dir, { recursive: true, force: true });
				removed++;
			}
		}
		// Drop an emptied type dir so archives don't accumulate stale <type>/ shells.
		if (safeReaddir(typeDir).length === 0) {
			try {
				rmSync(typeDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
	return removed;
}

/**
 * Delete processed envelopes (`<mailboxDir>/.done/*.json`) older than `days`,
 * by file mtime. Same retention knob as gcArchive (settings.archiveGcDays);
 * `days <= 0` disables. Returns count removed.
 */
export function gcDoneMail(mailboxDirs: string[], days: number, nowMs: number): number {
	if (days <= 0) return 0;
	const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
	let removed = 0;
	for (const mailboxDir of mailboxDirs) {
		const doneDir = mailboxDoneDirOf(mailboxDir);
		let names: string[];
		try {
			names = readdirSync(doneDir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = join(doneDir, name);
			try {
				if (statSync(file).mtimeMs < cutoff) {
					rmSync(file, { force: true });
					removed++;
				}
			} catch {
				/* raced away */
			}
		}
	}
	return removed;
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => !name.startsWith("."));
	} catch {
		return [];
	}
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
