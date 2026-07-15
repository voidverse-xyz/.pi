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
import type { Layout } from "./layout.ts";

export const RETIREMENT_MARKER = ".retired-at";

/** Move an agent instance dir to .archive/. Returns the archive path, or null if nothing to move. */
export function archiveAgentDir(layout: Layout, type: string, id: string, nowIso: string): string | null {
	const src = layout.agentInstanceDir(type, id);
	if (!existsSync(src)) return null;
	let dest = layout.archiveDir(type, id);
	// Collision (a prior same-address retire): suffix.
	let n = 2;
	while (existsSync(dest)) dest = `${layout.archiveDir(type, id)}-${n++}`;
	mkdirSync(join(dest, ".."), { recursive: true });
	renameSync(src, dest);
	writeFileSync(join(dest, RETIREMENT_MARKER), nowIso, "utf8");
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
			let retiredAt: string | undefined;
			try {
				retiredAt = readFileSync(join(dir, RETIREMENT_MARKER), "utf8").trim() || undefined;
			} catch {
				retiredAt = undefined;
			}
			out.push({ address: `${type}/${id.replace(/-\d+$/, "")}`, ...(retiredAt ? { retiredAt } : {}) });
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
		for (const id of safeReaddir(typeDir)) {
			const dir = join(typeDir, id);
			let retiredMs = 0;
			try {
				retiredMs = Date.parse(readFileSync(join(dir, RETIREMENT_MARKER), "utf8").trim());
			} catch {
				retiredMs = 0;
			}
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
