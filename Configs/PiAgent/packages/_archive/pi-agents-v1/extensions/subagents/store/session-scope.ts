import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	statSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Layout } from "./layout.ts";
import { pidStartToken, processMarkerIsLive } from "./process-identity.ts";
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

/**
 * Claim exclusive host ownership for one main-session scope. Adoption rollback
 * takes the same short lock, making its no-live-host check + removal atomic
 * against publication of a new host lease.
 */
export function claimHostScope(layout: Layout): HostScopeLease {
	const adoptionLock = join(layout.stateContainerRoot, ".adoption");
	return withFileLockSync(adoptionLock, () => claimHostScopeUnlocked(layout));
}

function claimHostScopeUnlocked(layout: Layout): HostScopeLease {
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
		return processMarkerIsLive(owner) ? owner.pid : null;
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

	// claimHostScope holds the shared .adoption generation lock for this entire
	// transaction. Exact observation still fences heartbeat/release changes,
	// while the outer lock makes a separate permanent reclaim file unnecessary.
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
	let current: string;
	try {
		current = readFileSync(layout.hostOwnerFile, "utf8");
	} catch {
		current = "";
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
	const roots: string[] = [];
	for (const root of [layout.legacyDigestSubagentsRoot, layout.legacySubagentsRoot]) {
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`Legacy subagent state root must be a real directory, not a symlink or special file: ${root}`);
		}
		roots.push(root);
	}
	return roots;
}

function isLifecycleLockArtifact(name: string): boolean {
	return name === ".lifecycle.lock" ||
		name.startsWith(".lifecycle.lock.candidate-") ||
		name.startsWith(".lifecycle.lock.stale-") ||
		name.startsWith(".lifecycle.lock.reclaim-");
}

function removeLifecycleLockArtifacts(root: string): void {
	if (!existsSync(root)) return;
	for (const name of readdirSync(root)) {
		if (isLifecycleLockArtifact(name)) rmSync(join(root, name), { recursive: true, force: true });
	}
}

function scopeHasUserState(layout: Layout): boolean {
	if (!existsSync(layout.subagentsRoot)) return false;
	const ignorable = new Set(["scope.json", "autonomy.json", ".host-owner.json"]);
	return readdirSync(layout.subagentsRoot).some((name) => !ignorable.has(name) && !isLifecycleLockArtifact(name));
}

/** Destructive migration steps must never run beneath a live host lease. */
function clearStaleOrRejectHostOwner(layout: Layout): void {
	if (!existsSync(layout.hostOwnerFile)) return;
	let owner: { pid?: unknown; processStartToken?: unknown; claimedAt?: unknown };
	try {
		owner = JSON.parse(readFileSync(layout.hostOwnerFile, "utf8"));
	} catch {
		throw new Error("Release the current session's subagent core before migration recovery/adoption/rollback.");
	}
	if (processMarkerIsLive(owner)) {
		throw new Error("Release the current session's subagent core before migration recovery/adoption/rollback.");
	}
	rmSync(layout.hostOwnerFile, { force: true });
}

interface FingerprintOptions {
	/** Ignore only runtime ownership markers at their reserved layout paths. */
	ignoreTransientOwnership?: boolean;
	/** Additional exact root-relative paths (never basename-wide). */
	ignoreRootPaths?: ReadonlySet<string>;
}

function fingerprintTree(
	root: string,
	options: FingerprintOptions = {},
): { files: number; dirs: number; digest: string } {
	let files = 0;
	let dirs = 0;
	const hash = createHash("sha256");
	const walk = (dir: string, relativeDir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
			if (options.ignoreRootPaths?.has(relative)) continue;
			if (
				relativeDir === "" &&
				options.ignoreRootPaths?.has(".lifecycle.lock") &&
				isLifecycleLockArtifact(entry.name)
			) continue;
			if (options.ignoreTransientOwnership) {
				const parts = relative.split("/");
				const agentRunOwner =
					parts.length === 3 &&
					parts[2] === ".run-owner.json" &&
					!parts[0]!.startsWith(".") &&
					!parts[1]!.startsWith(".");
				if (relative === ".host-owner.json" || agentRunOwner) continue;
			}
			const kind = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : entry.isFile() ? "f" : "o";
			hash.update(`${kind}:${relative}\0`);
			if (entry.isDirectory()) {
				dirs++;
				walk(join(dir, entry.name), relative);
			} else {
				files++;
				if (entry.isSymbolicLink()) {
					// Hash the link itself, never external target contents. Retargeting is
					// still a scope mutation and must block destructive rollback.
					hash.update(`->${readlinkSync(join(dir, entry.name))}\0`);
				} else if (entry.isFile()) {
					hash.update(readFileSync(join(dir, entry.name)));
				} else {
					const stat = lstatSync(join(dir, entry.name));
					hash.update(`${stat.mode}:${stat.size}:${stat.mtimeMs}\0`);
				}
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
			if (entry.name !== ".run-owner.json" || (!entry.isFile() && !entry.isSymbolicLink())) continue;
			try {
				const owner = JSON.parse(readFileSync(file, "utf8")) as {
					pid?: unknown;
					processStartToken?: unknown;
					claimedAt?: unknown;
				};
				if (processMarkerIsLive(owner)) {
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
		clearStaleOrRejectHostOwner(layout);
		let record: {
			status?: unknown;
			protocol?: unknown;
			activationStartedAt?: unknown;
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
		if (record.status === "rolling-back") {
			if (
				record.ownerSessionId !== layout.ownerSessionId ||
				typeof record.source !== "string" ||
				typeof record.backup !== "string"
			) {
				throw new Error("Interrupted rollback belongs to another session or has an invalid ledger.");
			}
			const result = completeLegacyRollback(layout, ledger, record as RollingBackRecord);
			return { recovered: true, restoredSource: result.restored };
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
		const protocol2PreActivation = record.protocol === 2 && typeof record.activationStartedAt !== "string";
		if (!protocol2PreActivation && existsSync(layout.subagentsRoot)) {
			const legacySnapshot = existsSync(record.source)
				? record.source
				: existsSync(record.backup)
					? record.backup
					: null;
			if (legacySnapshot === null) {
				throw new Error("Interrupted legacy adoption has an owner scope but no recoverable source/backup.");
			}
			// Once activation was announced, the destination is either the original
			// empty/generated scope or the verified legacy copy. Empty machinery is
			// safe to retain; a populated destination must match exactly before
			// deletion. Anything divergent remains a manual-recovery stop.
			if (scopeHasUserState(layout)) {
				const legacyFingerprint = fingerprintTree(legacySnapshot, {
					ignoreRootPaths: new Set([".lifecycle.lock"]),
				});
				const ownerFingerprint = fingerprintTree(layout.subagentsRoot, {
					ignoreRootPaths: new Set(["scope.json"]),
				});
				if (legacyFingerprint.digest !== ownerFingerprint.digest) {
					throw new Error("Interrupted adoption's owner scope differs from its legacy snapshot; recover manually.");
				}
				rmSync(layout.subagentsRoot, { recursive: true, force: true });
			}
		}
		// Protocol 2 proves no destination mutation happens before the durable
		// activation marker. A copy-phase crash therefore deletes only staging
		// and never compares ordinary empty scope metadata to the legacy tree.
		rmSync(record.staging, { recursive: true, force: true });
		if (!existsSync(record.source) && existsSync(record.backup)) {
			removeLifecycleLockArtifacts(record.backup);
			renameSync(record.backup, record.source);
		}
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
	const lockTarget = join(layout.stateContainerRoot, ".adoption");

	// Discovery, destination emptiness, source identity, and ledger publication
	// are one adoption-lock transaction. A second session can no longer retain a
	// pre-lock source pathname that the first adopter moved to its backup.
	return withFileLockSync(lockTarget, () => {
		const sources = legacyStateRoots(layout);
		if (sources.length === 0) throw new Error("No legacy cwd-wide subagent state was found.");
		if (sources.length > 1) {
			throw new Error("Both pre-digest and digest legacy roots exist; resolve the ambiguity manually before adoption.");
		}
		if (scopeHasUserState(layout)) {
			throw new Error("The current session scope is not empty; legacy state cannot be merged automatically.");
		}

		const source = sources[0]!;
		const sourceIdentity = lstatSync(source);
		const token = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
		const backup = `${source}.legacy-backup-${token}`;
		const staging = join(layout.ownersRoot, `.adopting-${layout.ownerSessionId}-${token}`);
		const ledger = join(layout.stateContainerRoot, ".adoption-ledger.json");

		return withFileLockSync(join(source, ".lifecycle"), () => {
			const lockedIdentity = lstatSync(source);
			if (
				!lockedIdentity.isDirectory() || lockedIdentity.isSymbolicLink() ||
				lockedIdentity.dev !== sourceIdentity.dev || lockedIdentity.ino !== sourceIdentity.ino
			) {
				throw new Error("Legacy subagent state root changed while adoption locks were being acquired.");
			}
			clearStaleOrRejectHostOwner(layout);
		// The legacy runtime claims per-agent ownership beneath this same lock.
		// Keep the source pathname + lock stable through copy and activation; the
		// source is renamed to its inactive backup only as the final publication.
		assertNoLiveRunOwners(source);
		if (scopeHasUserState(layout)) throw new Error("The current session scope changed during adoption.");
		mkdirSync(dirname(staging), { recursive: true });
		atomicWriteJson(ledger, {
			version: 1,
			protocol: 2,
			status: "copying",
			source,
			backup,
			staging,
			ownerSessionId: layout.ownerSessionId,
			startedAt: new Date().toISOString(),
		});
		let activated = false;
		let sourceMoved = false;
		try {
			cpSync(source, staging, {
				recursive: true,
				errorOnExist: true,
				force: false,
				verbatimSymlinks: true,
			});
			// The held lifecycle generation is runtime machinery, not legacy state.
			removeLifecycleLockArtifacts(staging);
			const expected = fingerprintTree(source, {
				ignoreRootPaths: new Set([".lifecycle.lock"]),
			});
			const actual = fingerprintTree(staging);
			if (
				expected.files !== actual.files ||
				expected.dirs !== actual.dirs ||
				expected.digest !== actual.digest
			) {
				throw new Error("Legacy adoption verification failed: copied tree fingerprint differs.");
			}
			// This durable phase boundary makes pre-activation copy crashes
			// distinguishable from crashes after destination mutation begins.
			atomicWriteJson(ledger, {
				version: 1,
				protocol: 2,
				status: "copying",
				source,
				backup,
				staging,
				ownerSessionId: layout.ownerSessionId,
				startedAt: new Date().toISOString(),
				activationStartedAt: new Date().toISOString(),
			});
			rmSync(layout.subagentsRoot, { recursive: true, force: true });
			renameSync(staging, layout.subagentsRoot);
			activated = true;
			ensureScopeManifest(layout, { persisted: true, adoptedFrom: basename(backup) });
			// Only now move the stable, locked source out of the legacy pathname.
			// No write can be omitted from the already-verified activated copy.
			renameSync(source, backup);
			sourceMoved = true;
			removeLifecycleLockArtifacts(backup);
			const baseline = fingerprintTree(layout.subagentsRoot, { ignoreTransientOwnership: true });
			atomicWriteJson(ledger, {
				version: 1,
				protocol: 2,
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
			if (sourceMoved && !existsSync(source) && existsSync(backup)) renameSync(backup, source);
			throw error;
			}
		});
	});
}

export interface RollbackLegacyResult {
	restored: string;
	removedScope: string;
}

interface RollingBackRecord {
	status?: unknown;
	source: string;
	backup: string;
	ownerSessionId: string;
	[key: string]: unknown;
}

function completeLegacyRollback(
	layout: Layout,
	ledger: string,
	record: RollingBackRecord,
): RollbackLegacyResult {
	const sourceExists = existsSync(record.source);
	const backupExists = existsSync(record.backup);
	if (sourceExists && backupExists) {
		throw new Error("Rollback recovery found both source and backup roots; recover manually.");
	}
	if (!sourceExists && !backupExists) {
		throw new Error("Rollback recovery found neither source nor backup root; recover manually.");
	}
	const lockRoot = sourceExists ? record.source : record.backup;
	return withFileLockSync(join(lockRoot, ".lifecycle"), () => {
		try {
			// Restore first: there is never a crash point with neither usable copy.
			if (!existsSync(record.source)) renameSync(record.backup, record.source);
			rmSync(layout.subagentsRoot, { recursive: true, force: true });
			atomicWriteJson(ledger, {
				...record,
				status: "rolled-back",
				rolledBackAt: new Date().toISOString(),
			});
			return { restored: record.source, removedScope: layout.subagentsRoot };
		} finally {
			// The lock may have moved backup→source with the restored tree.
			removeLifecycleLockArtifacts(record.source);
		}
	});
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
		clearStaleOrRejectHostOwner(layout);
		const current = fingerprintTree(layout.subagentsRoot, { ignoreTransientOwnership: true });
		if (current.digest !== record.baselineDigest) {
			throw new Error(
				"The adopted scope has diverged; automatic rollback would lose work. Export it and recover manually.",
			);
		}
		const rollingBack: RollingBackRecord = {
			...record,
			status: "rolling-back",
			source: record.source,
			backup: record.backup,
			ownerSessionId: record.ownerSessionId,
			rollbackStartedAt: new Date().toISOString(),
		};
		atomicWriteJson(ledger, rollingBack);
		return completeLegacyRollback(layout, ledger, rollingBack);
	});
}
