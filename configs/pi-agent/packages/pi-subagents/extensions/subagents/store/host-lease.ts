/**
 * store/host-lease.ts — the ONE mutual-exclusion primitive.
 *
 * Exactly one live process may own a `subagents/<sessionId>/` scope at a time.
 * Everything else relies on this: no per-agent run-owner locks, no registry
 * advisory locks. The lease is a `.host-owner.json` marker created with an
 * exclusive create; a heartbeat keeps it fresh; a foreign marker is honored
 * only while its process is provably alive (pid liveness + start-time fence
 * against PID reuse), otherwise it's swept.
 *
 * Also owns the scope manifest (`scope.json`): records {cwd, ownerSessionId} so
 * a fork/new session that inherits a stale dir is detected.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJson, fsyncDirBestEffort } from "./atomic.ts";
import type { Layout } from "./layout.ts";

const HEARTBEAT_MS = 5000;
/** A marker whose heartbeat is older than this AND whose pid is dead is stale. */
const STALE_AFTER_MS = HEARTBEAT_MS * 4;

interface HostOwnerMarker {
	runtimeId: string;
	pid: number;
	/** Process start-time fence (Linux /proc starttime), or null when unavailable. */
	startTime: number | null;
	updatedAt: number;
}

/** Linux: field 22 of /proc/<pid>/stat is the process start time (clock ticks since boot). */
function processStartTime(pid: number): number | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The comm field (field 2) may contain spaces/parens; split after the last ')'.
		const rparen = stat.lastIndexOf(")");
		const rest = stat.slice(rparen + 2).split(" ");
		// After comm, field 3 is at index 0; starttime is field 22 → index 22 - 3 = 19.
		const start = rest[19];
		return start ? Number.parseInt(start, 10) : null;
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"; // alive but not ours
	}
}

/** Is a foreign owner marker still live (so we must NOT steal the scope)? */
function markerIsLive(marker: HostOwnerMarker, now: number): boolean {
	if (!pidAlive(marker.pid)) return false;
	if (marker.startTime !== null) {
		// The owner recorded a start-time fence (Linux). A readable current start time
		// gives a positive verdict either way; unreadable-now falls back to the
		// heartbeat window so a dead owner with a recycled pid can't block forever.
		const current = processStartTime(marker.pid);
		if (current !== null) return current === marker.startTime;
		return now - marker.updatedAt <= STALE_AFTER_MS;
	}
	// No fence was ever recorded (non-Linux): a live pid is honored, period. The
	// heartbeat runs on the owner's event loop, so a busy-but-alive owner can miss
	// the window — sweeping on staleness alone would break the single-owner
	// guarantee. Cost: PID reuse can block reclaim until the reused process exits
	// (HostScopeLockedError names the pid so the user can check it).
	return true;
}

export class HostScopeLockedError extends Error {
	constructor(public readonly ownerPid: number) {
		super(`Subagents scope is owned by a live process (pid ${ownerPid}).`);
		this.name = "HostScopeLockedError";
	}
}

function readMarker(path: string): HostOwnerMarker | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HostOwnerMarker>;
		if (typeof parsed.runtimeId !== "string" || typeof parsed.pid !== "number" || typeof parsed.updatedAt !== "number") {
			return null;
		}
		return { runtimeId: parsed.runtimeId, pid: parsed.pid, startTime: typeof parsed.startTime === "number" ? parsed.startTime : null, updatedAt: parsed.updatedAt };
	} catch {
		return null;
	}
}

export interface HostScopeLease {
	readonly runtimeId: string;
	release(): void;
}

/**
 * Publish a marker so it appears at `path` ATOMICALLY and fully-formed: write the
 * content to a tmp file (fsync'd), then hard-link it into place. `linkSync` fails
 * with EEXIST if the target already exists, giving us exclusive-create with a
 * complete payload — a foreign reader can never observe an empty/partial marker
 * (which would look "unreadable → stale" and wrongly get swept). Returns true if we
 * created the marker, false if one already existed.
 */
function publishMarkerExclusive(path: string, marker: HostOwnerMarker): boolean {
	const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = openSync(tmp, "w");
	try {
		writeFileSync(fd, JSON.stringify(marker), "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(tmp, path);
		// Persist the directory entry too (same discipline as atomicWriteJson): the
		// marker's creation should survive a power cut, not just its content.
		fsyncDirBestEffort(dirname(path));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* the link (or a failed link) leaves tmp; best-effort cleanup */
		}
	}
}

/** Ensure the scope manifest records this cwd + owner (idempotent). */
export function ensureScopeManifest(layout: Layout): void {
	type Manifest = { cwd?: string; ownerSessionId?: string };
	let existing: Manifest | null = null;
	try {
		existing = JSON.parse(readFileSync(layout.scopeManifestFile, "utf8")) as Manifest;
	} catch {
		existing = null;
	}
	if (existing && existing.cwd === layout.cwd && existing.ownerSessionId === layout.ownerSessionId) return;
	atomicWriteJson(layout.scopeManifestFile, { version: 1, cwd: layout.cwd, ownerSessionId: layout.ownerSessionId });
}

/**
 * Claim the host-scope lease for this process. Throws HostScopeLockedError if a
 * live process already owns it. Returns a lease with a heartbeat timer; call
 * release() at session end/shutdown.
 */
export function claimHostScope(layout: Layout, options: { now?: () => number } = {}): HostScopeLease {
	const now = options.now ?? Date.now;
	const path = layout.hostOwnerFile;
	mkdirSync(dirname(path), { recursive: true });
	const runtimeId = randomBytes(12).toString("hex");
	const pid = process.pid;
	const startTime = processStartTime(pid);

	// Heartbeat: refresh the marker we already own. Atomic (tmp+rename via
	// atomicWriteJson) so a concurrent reader never sees a torn write. Only writes
	// if the marker is still ours (a swept-then-reclaimed scope must not be clobbered).
	const heartbeat = (): void => {
		const current = readMarker(path);
		if (current && current.runtimeId !== runtimeId) return;
		atomicWriteJson(path, { runtimeId, pid, startTime, updatedAt: now() } satisfies HostOwnerMarker);
	};

	// Claim loop: try exclusive create; on EEXIST, sweep if dead, else fail. We must
	// end the loop provably OWNING the lease — otherwise a repeatedly-raced stale
	// marker could let us fall through and behave as owner without a marker.
	let owned = false;
	for (let attempt = 0; attempt < 5 && !owned; attempt++) {
		if (publishMarkerExclusive(path, { runtimeId, pid, startTime, updatedAt: now() })) {
			owned = true;
			break;
		}
		const foreign = readMarker(path);
		if (foreign && foreign.runtimeId !== runtimeId && markerIsLive(foreign, now())) {
			throw new HostScopeLockedError(foreign.pid);
		}
		// stale or unreadable → sweep and retry
		try {
			unlinkSync(path);
		} catch {
			/* raced away */
		}
	}
	if (!owned) {
		// The scope was contended every attempt without a live owner we could name.
		throw new HostScopeLockedError(readMarker(path)?.pid ?? -1);
	}

	ensureScopeManifest(layout);

	const timer = setInterval(() => {
		try {
			heartbeat();
		} catch {
			/* transient; next tick retries */
		}
	}, HEARTBEAT_MS);
	if (typeof timer.unref === "function") timer.unref();

	let released = false;
	return {
		runtimeId,
		release(): void {
			if (released) return;
			released = true;
			clearInterval(timer);
			const current = readMarker(path);
			if (current && current.runtimeId === runtimeId) {
				try {
					unlinkSync(path);
				} catch {
					/* already gone */
				}
			}
		},
	};
}
