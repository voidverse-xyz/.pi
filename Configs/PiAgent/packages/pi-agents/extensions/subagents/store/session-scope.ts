import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Layout } from "./layout.ts";
import { atomicWriteJson, withFileLockSync } from "./registry.ts";

export interface ScopeManifest {
	version: 2;
	cwd: string;
	ownerSessionId: string;
	persisted: boolean;
	createdAt: string;
	adoptedFrom?: string;
}

export interface HostScopeLease {
	readonly runtimeId: string;
	release(): void;
}

const HOST_HEARTBEAT_MS = 5_000;

export class SessionScopeLockedError extends Error {
	constructor(readonly ownerPid: number | null) {
		super(
			ownerPid === null
				? "This Pi session's subagent scope is locked by another live host."
				: `This Pi session's subagent scope is already open in live Pi process ${ownerPid}.`,
		);
		this.name = "SessionScopeLockedError";
	}
}

function pidStartToken(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		return afterCommand[19]; // Linux /proc stat field 22: process start ticks
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

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function ensureScopeManifest(
	layout: Layout,
	options: { persisted: boolean; adoptedFrom?: string },
): ScopeManifest {
	try {
		const parsed = JSON.parse(readFileSync(layout.scopeManifestFile, "utf8")) as ScopeManifest;
		if (
			parsed.version !== 2 ||
			parsed.cwd !== layout.cwd ||
			parsed.ownerSessionId !== layout.ownerSessionId ||
			parsed.persisted !== options.persisted
		) {
			throw new Error(`Scope metadata does not match ${layout.ownerSessionId}.`);
		}
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const manifest: ScopeManifest = {
		version: 2,
		cwd: layout.cwd,
		ownerSessionId: layout.ownerSessionId,
		persisted: options.persisted,
		createdAt: new Date().toISOString(),
		...(options.adoptedFrom !== undefined ? { adoptedFrom: options.adoptedFrom } : {}),
	};
	atomicWriteJson(layout.scopeManifestFile, manifest);
	return manifest;
}

/** Claim exclusive host ownership for one main-session scope. */
export function claimHostScope(layout: Layout): HostScopeLease {
	mkdirSync(layout.subagentsRoot, { recursive: true });
	const runtimeId = `host_${process.pid}_${randomBytes(8).toString("hex")}`;
	const claimedAt = new Date().toISOString();
	const processStartToken = pidStartToken(process.pid);
	const payload = () => ({
		pid: process.pid,
		runtimeId,
		sessionId: layout.ownerSessionId,
		claimedAt,
		...(processStartToken !== undefined ? { processStartToken } : {}),
		heartbeatAt: new Date().toISOString(),
	});
	const liveOwnerPid = (): number | null => {
		let owner: {
			pid?: unknown;
			processStartToken?: unknown;
			claimedAt?: unknown;
		};
		try {
			owner = JSON.parse(readFileSync(layout.hostOwnerFile, "utf8"));
		} catch {
			try {
				if (Date.now() - statSync(layout.hostOwnerFile).mtimeMs < 30_000) return -1;
			} catch {
				return null;
			}
			return null;
		}
		if (typeof owner.pid !== "number" || !pidAlive(owner.pid)) return null;
		const liveStartToken = pidStartToken(owner.pid);
		if (
			typeof owner.processStartToken === "string" &&
			liveStartToken !== undefined &&
			owner.processStartToken !== liveStartToken
		) {
			return null; // marker survived PID reuse
		}
		if (typeof owner.processStartToken !== "string" && typeof owner.claimedAt === "string") {
			const claimedAtMs = Date.parse(owner.claimedAt);
			const liveStartedAt = pidStartedAtMs(owner.pid);
			if (!Number.isNaN(claimedAtMs) && liveStartedAt !== undefined && liveStartedAt > claimedAtMs + 60_000) {
				return null; // heartbeat-less marker survived PID reuse
			}
		}
		return owner.pid;
	};
	const finishLease = (): HostScopeLease => {
		const heartbeat = setInterval(() => {
			try {
				const owner = JSON.parse(readFileSync(layout.hostOwnerFile, "utf8")) as { runtimeId?: unknown };
				if (owner.runtimeId === runtimeId) atomicWriteJson(layout.hostOwnerFile, payload());
			} catch {
				// A missing/replaced lease is no longer ours to refresh.
			}
		}, HOST_HEARTBEAT_MS);
		heartbeat.unref?.();
		return {
			runtimeId,
			release: () => {
				clearInterval(heartbeat);
				try {
					const owner = JSON.parse(readFileSync(layout.hostOwnerFile, "utf8")) as { runtimeId?: unknown };
					if (owner.runtimeId === runtimeId) rmSync(layout.hostOwnerFile, { force: true });
				} catch {
					// Missing/replaced lease is not ours to remove.
				}
			},
		};
	};

	try {
		writeFileSync(layout.hostOwnerFile, `${JSON.stringify(payload())}\n`, { flag: "wx", mode: 0o600 });
		return finishLease();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const ownerPid = liveOwnerPid();
	if (ownerPid !== null) throw new SessionScopeLockedError(ownerPid > 0 ? ownerPid : null);

	// Fence stale reclamation by the exact observed host generation. The claim
	// file is append-only and never reused: only one process can create it with
	// `wx`; late contenders for the same stale marker cannot unlink a winner's
	// replacement. If the winner crashes in this tiny recovery window, future
	// opens fail closed instead of risking split-brain.
	let observed: string;
	try {
		observed = readFileSync(layout.hostOwnerFile, "utf8");
	} catch {
		throw new SessionScopeLockedError(null);
	}
	// The marker may have been replaced between the earlier stale check and
	// this snapshot. Never mint a reclaim generation for a newly-live owner.
	const observedLivePid = liveOwnerPid();
	if (observedLivePid !== null) {
		throw new SessionScopeLockedError(observedLivePid > 0 ? observedLivePid : null);
	}
	try {
		if (readFileSync(layout.hostOwnerFile, "utf8") !== observed) throw new SessionScopeLockedError(null);
	} catch (error) {
		if (error instanceof SessionScopeLockedError) throw error;
		throw new SessionScopeLockedError(null);
	}
	const reclaimRoot = join(layout.stateContainerRoot, ".host-owner-reclaims", layout.ownerSessionId);
	mkdirSync(reclaimRoot, { recursive: true });
	const generation = createHash("sha256").update(observed).digest("hex");
	const reclaimFile = join(reclaimRoot, `${generation}.json`);
	try {
		writeFileSync(
			reclaimFile,
			`${JSON.stringify({ pid: process.pid, runtimeId, observedAt: new Date().toISOString() })}\n`,
			{ flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SessionScopeLockedError(null);
		throw error;
	}
	let current: string;
	try {
		current = readFileSync(layout.hostOwnerFile, "utf8");
	} catch {
		current = ""; // a late fresh claimant may now win the `wx` below
	}
	if (current !== "" && current !== observed) throw new SessionScopeLockedError(liveOwnerPid());
	if (current === observed) rmSync(layout.hostOwnerFile, { force: true });
	try {
		writeFileSync(layout.hostOwnerFile, `${JSON.stringify(payload())}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SessionScopeLockedError(liveOwnerPid());
		throw error;
	}
	return finishLease();
}

export function legacyStateRoots(layout: Layout): string[] {
	return [layout.legacyDigestSubagentsRoot, layout.legacySubagentsRoot].filter((root) => existsSync(root));
}

function scopeHasUserState(layout: Layout): boolean {
	if (!existsSync(layout.subagentsRoot)) return false;
	const ignorable = new Set(["scope.json", "autonomy.json", ".host-owner.json"]);
	return readdirSync(layout.subagentsRoot).some((name) => !ignorable.has(name));
}

function fingerprintTree(
	root: string,
	ignoreNames: ReadonlySet<string> = new Set(),
): { files: number; dirs: number; digest: string } {
	let files = 0;
	let dirs = 0;
	const hash = createHash("sha256");
	const walk = (dir: string, relativeDir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (ignoreNames.has(entry.name)) continue;
			const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
			hash.update(`${entry.isDirectory() ? "d" : "f"}:${relative}\0`);
			if (entry.isDirectory()) {
				dirs++;
				walk(join(dir, entry.name), relative);
			} else if (entry.isFile()) {
				files++;
				hash.update(readFileSync(join(dir, entry.name)));
			}
		}
	};
	walk(root, "");
	return { files, dirs, digest: hash.digest("hex") };
}

function assertNoLiveRunOwners(root: string): void {
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(file);
				continue;
			}
			if (!entry.isFile() || entry.name !== ".run-owner.json") continue;
			try {
				const owner = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
				if (typeof owner.pid === "number" && pidAlive(owner.pid)) {
					throw new Error(`Legacy state is still run-owned by live Pi process ${owner.pid}.`);
				}
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("Legacy state is still")) throw error;
			}
		}
	};
	walk(root);
}

export interface AdoptionRecoveryResult {
	recovered: boolean;
	restoredSource?: string;
}

/** Roll an interrupted pre-completion adoption back to its exact legacy root. */
export function recoverInterruptedAdoption(layout: Layout): AdoptionRecoveryResult {
	const ledger = join(layout.stateContainerRoot, ".adoption-ledger.json");
	const lockTarget = join(layout.stateContainerRoot, ".adoption");
	return withFileLockSync(lockTarget, () => {
		let record: {
			status?: unknown;
			source?: unknown;
			backup?: unknown;
			staging?: unknown;
			ownerSessionId?: unknown;
		};
		try {
			record = JSON.parse(readFileSync(ledger, "utf8"));
		} catch {
			return { recovered: false };
		}
		if (record.status !== "copying") return { recovered: false };
		if (
			record.ownerSessionId !== layout.ownerSessionId ||
			typeof record.source !== "string" ||
			typeof record.backup !== "string" ||
			typeof record.staging !== "string"
		) {
			throw new Error("Interrupted legacy adoption belongs to another session or has an invalid ledger.");
		}
		if (existsSync(record.source) && existsSync(record.backup)) {
			throw new Error("Interrupted legacy adoption has both source and backup roots; recover manually.");
		}
		if (!existsSync(record.source) && existsSync(layout.subagentsRoot)) {
			if (!existsSync(record.backup)) {
				throw new Error("Interrupted legacy adoption has an owner scope but no recoverable backup.");
			}
			const backupFingerprint = fingerprintTree(record.backup);
			const ownerFingerprint = fingerprintTree(
				layout.subagentsRoot,
				new Set(["scope.json", ".host-owner.json", ".run-owner.json"]),
			);
			if (backupFingerprint.digest !== ownerFingerprint.digest) {
				throw new Error("Interrupted adoption's owner scope differs from its backup; recover manually.");
			}
			rmSync(layout.subagentsRoot, { recursive: true, force: true });
		}
		rmSync(record.staging, { recursive: true, force: true });
		if (!existsSync(record.source) && existsSync(record.backup)) renameSync(record.backup, record.source);
		atomicWriteJson(ledger, {
			...record,
			status: "recovered",
			recoveredAt: new Date().toISOString(),
		});
		return { recovered: true, restoredSource: record.source };
	});
}

export interface AdoptLegacyResult {
	source: string;
	backup: string;
	files: number;
	dirs: number;
}

/** Human-command-only two-phase adoption of one inactive cwd-wide root. */
export function adoptLegacyState(layout: Layout): AdoptLegacyResult {
	recoverInterruptedAdoption(layout);
	const sources = legacyStateRoots(layout);
	if (sources.length === 0) throw new Error("No legacy cwd-wide subagent state was found.");
	if (sources.length > 1) {
		throw new Error("Both pre-digest and digest legacy roots exist; resolve the ambiguity manually before adoption.");
	}
	if (scopeHasUserState(layout)) throw new Error("The current session scope is not empty; legacy state cannot be merged automatically.");

	const source = sources[0]!;
	assertNoLiveRunOwners(source);
	const token = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
	const backup = `${source}.legacy-backup-${token}`;
	const staging = join(layout.ownersRoot, `.adopting-${layout.ownerSessionId}-${token}`);
	const ledger = join(layout.stateContainerRoot, ".adoption-ledger.json");
	const lockTarget = join(layout.stateContainerRoot, ".adoption");

	return withFileLockSync(lockTarget, () => {
		if (scopeHasUserState(layout)) throw new Error("The current session scope changed during adoption.");
		mkdirSync(dirname(staging), { recursive: true });
		atomicWriteJson(ledger, {
			version: 1,
			status: "copying",
			source,
			backup,
			staging,
			ownerSessionId: layout.ownerSessionId,
			startedAt: new Date().toISOString(),
		});
		renameSync(source, backup);
		let activated = false;
		try {
			cpSync(backup, staging, { recursive: true, errorOnExist: true, force: false });
			const expected = fingerprintTree(backup);
			const actual = fingerprintTree(staging);
			if (
				expected.files !== actual.files ||
				expected.dirs !== actual.dirs ||
				expected.digest !== actual.digest
			) {
				throw new Error("Legacy adoption verification failed: copied tree fingerprint differs.");
			}
			rmSync(layout.subagentsRoot, { recursive: true, force: true });
			renameSync(staging, layout.subagentsRoot);
			activated = true;
			ensureScopeManifest(layout, { persisted: true, adoptedFrom: basename(backup) });
			const baseline = fingerprintTree(
				layout.subagentsRoot,
				new Set([".host-owner.json", ".run-owner.json"]),
			);
			atomicWriteJson(ledger, {
				version: 1,
				status: "complete",
				source,
				backup,
				ownerSessionId: layout.ownerSessionId,
				completedAt: new Date().toISOString(),
				...expected,
				baselineDigest: baseline.digest,
			});
			return { source, backup, ...expected };
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			if (activated) rmSync(layout.subagentsRoot, { recursive: true, force: true });
			if (!existsSync(source) && existsSync(backup)) renameSync(backup, source);
			throw error;
		}
	});
}

export interface RollbackLegacyResult {
	restored: string;
	removedScope: string;
}

/**
 * Restore the inactive pre-adoption root only while the scoped copy is byte-for-
 * byte unchanged (transient host/run-owner markers excluded). Never guesses at
 * a merge after the session has done work.
 */
export function rollbackLegacyAdoption(layout: Layout): RollbackLegacyResult {
	const ledger = join(layout.stateContainerRoot, ".adoption-ledger.json");
	const lockTarget = join(layout.stateContainerRoot, ".adoption");
	return withFileLockSync(lockTarget, () => {
		let record: {
			status?: unknown;
			source?: unknown;
			backup?: unknown;
			ownerSessionId?: unknown;
			baselineDigest?: unknown;
		};
		try {
			record = JSON.parse(readFileSync(ledger, "utf8"));
		} catch {
			throw new Error("No completed legacy adoption ledger was found.");
		}
		if (
			record.status !== "complete" ||
			record.ownerSessionId !== layout.ownerSessionId ||
			typeof record.source !== "string" ||
			typeof record.backup !== "string" ||
			typeof record.baselineDigest !== "string"
		) {
			throw new Error("The legacy adoption ledger does not describe a rollbackable adoption for this session.");
		}
		if (!existsSync(record.backup)) throw new Error("The inactive legacy backup no longer exists.");
		if (existsSync(record.source)) throw new Error("The original legacy root already exists; refusing to overwrite it.");
		if (!existsSync(layout.subagentsRoot)) throw new Error("The adopted session scope no longer exists.");
		if (existsSync(layout.hostOwnerFile)) {
			throw new Error("Release the current session's subagent core before rollback.");
		}
		const current = fingerprintTree(
			layout.subagentsRoot,
			new Set([".host-owner.json", ".run-owner.json"]),
		);
		if (current.digest !== record.baselineDigest) {
			throw new Error(
				"The adopted scope has diverged; automatic rollback would lose work. Export it and recover manually.",
			);
		}
		rmSync(layout.subagentsRoot, { recursive: true, force: true });
		renameSync(record.backup, record.source);
		atomicWriteJson(ledger, {
			...record,
			status: "rolled-back",
			rolledBackAt: new Date().toISOString(),
		});
		return { restored: record.source, removedScope: layout.subagentsRoot };
	});
}
