import { readFileSync } from "node:fs";

/** Minimal process identity persisted in host/run-owner lease files. */
export interface ProcessIdentityMarker {
	pid?: unknown;
	processStartToken?: unknown;
	claimedAt?: unknown;
	/** Legacy/generic lock timestamp alias. */
	createdAt?: unknown;
}

/** Linux process-start identity (`/proc/<pid>/stat` field 22), when available. */
export function pidStartToken(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		return afterCommand[19];
	} catch {
		return undefined;
	}
}

function pidStartedAtMs(pid: number): number | undefined {
	try {
		const token = Number(pidStartToken(pid));
		const uptimeSeconds = Number(readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]);
		if (!Number.isFinite(token) || !Number.isFinite(uptimeSeconds)) return undefined;
		// Linux exposes starttime in USER_HZ, standardized as 100 for /proc.
		return Date.now() - (uptimeSeconds - token / 100) * 1000;
	} catch {
		return undefined;
	}
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * True only when a marker still identifies the process currently bearing its
 * PID. New markers use the exact Linux start token. The timestamp fallback
 * safely reclaims older token-less markers after PID reuse when observable.
 */
export function processMarkerIsLive(marker: ProcessIdentityMarker): marker is ProcessIdentityMarker & { pid: number } {
	if (typeof marker.pid !== "number" || !pidAlive(marker.pid)) return false;
	const liveStartToken = pidStartToken(marker.pid);
	if (
		typeof marker.processStartToken === "string" &&
		liveStartToken !== undefined &&
		marker.processStartToken !== liveStartToken
	) {
		return false;
	}
	const claimedAt = typeof marker.claimedAt === "string"
		? marker.claimedAt
		: typeof marker.createdAt === "string"
			? marker.createdAt
			: undefined;
	if (typeof marker.processStartToken !== "string" && claimedAt !== undefined) {
		const claimedAtMs = Date.parse(claimedAt);
		const liveStartedAt = pidStartedAtMs(marker.pid);
		if (!Number.isNaN(claimedAtMs) && liveStartedAt !== undefined && liveStartedAt > claimedAtMs + 60_000) {
			return false;
		}
	}
	return true;
}
