/**
 * store/atomic.ts — crash-durable filesystem write primitives, shared by the
 * registry, host lease, open-task index, and mailboxes. No policy here — just
 * IO discipline.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Durably record a rename/link in its directory entry (ext4 data=writeback /
 * xfs can otherwise resurrect a zero-length or missing file after a crash).
 * Best-effort — some platforms/filesystems reject O_RDONLY fsync on a directory.
 */
export function fsyncDirBestEffort(dir: string): void {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		/* ignore */
	}
}

/**
 * Atomic + crash-durable write: write a tmp file in the same dir, fsync its data,
 * rename over the target, then fsync the directory so the rename itself survives a
 * crash. The tmp file is cleaned up if the write fails (no `.<hex>.tmp` litter on
 * ENOSPC).
 */
function atomicWrite(path: string, content: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const fd = openSync(tmp, "w");
		try {
			writeFileSync(fd, content, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		throw error;
	}
	fsyncDirBestEffort(dir);
}

/** Atomic + crash-durable JSON write (see atomicWrite). */
export function atomicWriteJson(path: string, value: unknown): void {
	atomicWrite(path, JSON.stringify(value, null, 2));
}

/**
 * Atomic + crash-durable TEXT write (same discipline as atomicWriteJson) — used
 * for ad-hoc def.md files, which are markdown, not JSON.
 */
export function atomicWriteText(path: string, text: string): void {
	atomicWrite(path, text);
}
