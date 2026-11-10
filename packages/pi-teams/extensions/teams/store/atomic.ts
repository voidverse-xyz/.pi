/**
 * store/atomic.ts — crash-durable filesystem write primitives, shared by the
 * registry, host lease, and mailboxes. No policy here — just IO discipline.
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
export function atomicWriteJson(path: string, value: unknown): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const fd = openSync(tmp, "w");
		try {
			writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
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
