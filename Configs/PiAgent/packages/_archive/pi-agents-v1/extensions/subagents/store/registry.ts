/**
 * store/registry.ts — the roster: who exists, their state, lifetime, purview,
 * vitals, and which type file (hash) they were last woken under (D6/D13/D15).
 *
 * Persisted to <subagents>/registry.json (path from store/layout.ts). Writes
 * are atomic (tmp file + rename) so a crash mid-write never corrupts the
 * roster. Team MEMBERSHIP is deliberately NOT stored here — teams.json is the
 * single source of truth (D12); status/list joins the two at read time.
 *
 * State model (D13): queued (waiting for a maxConcurrent slot) | running |
 * dormant (asleep; the default end-of-turn state) | waiting (blocked on a
 * human escalation, D22). Retired agents are REMOVED from the registry —
 * their dir moves to .archive/ (store/archive.ts); the address bounces.
 */

import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { formatAgentAddress, parseAddress } from "../mail/envelope.ts";
import { pidStartToken, processMarkerIsLive } from "./process-identity.ts";

export type AgentState = "queued" | "running" | "dormant" | "waiting";
export type Lifetime = "persistent" | "oneshot";

/** Live context/cost figures (D15). Placeholder until the runtime feeds them. */
export interface AgentVitals {
	/** Context-window fill, 0–100. */
	contextPercent: number;
	tokens: number;
	/** USD. */
	cost: number;
	turns: number;
	/** Auto-compactions so far (chronic-saturation signal, D15). */
	compactions: number;
}

export function emptyVitals(): AgentVitals {
	return { contextPercent: 0, tokens: 0, cost: 0, turns: 0, compactions: 0 };
}

export interface AgentRecord {
	/** Agent type — the type .md's name (D6). */
	type: string;
	/** Instance id — spawner-provided purview slug, or tmp-<short> for oneshots (D5/D20). */
	id: string;
	state: AgentState;
	lifetime: Lifetime;
	/** What this instance owns, for rosters and teammate listings (D18). */
	purview: string;
	vitals: AgentVitals;
	/** sha256 of the type .md as resolved at last wake (D6 visibility). */
	typeFileHash: string;
	/** Durable random incarnation fence; changes whenever an address is recreated. */
	generationId: string;
	/** ISO timestamps. */
	createdAt: string;
	updatedAt: string;
}

export interface Registry {
	version: 1;
	/** Keyed by address `<type>/<id>`. */
	agents: Record<string, AgentRecord>;
}

export function emptyRegistry(): Registry {
	return { version: 1, agents: {} };
}

export function agentAddress(record: Pick<AgentRecord, "type" | "id">): string {
	return formatAgentAddress(record.type, record.id);
}

// ---------------------------------------------------------------------------
// File I/O (atomic + cross-process serialized read/modify/write)
// ---------------------------------------------------------------------------

const LOCK_WAIT_MS = 10;
// New locks publish a complete owner record atomically via hard-link. The
// longer bound exists only for legacy/incomplete directory generations: they
// retain a 30s grace so a paused older writer is never stolen mid-publication.
const LOCK_TIMEOUT_MS = 35_000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Remove dead private candidates and file-generation tombstones from prior crashes. */
function cleanupFileLockArtifacts(lockPath: string): void {
	const parent = dirname(lockPath);
	const base = basename(lockPath);
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(`${base}.candidate-`) && !name.startsWith(`${base}.stale-`)) continue;
		const artifact = join(parent, name);
		try {
			const stat = statSync(artifact);
			// Legacy directory tombstones remain as the ABA fence for an older
			// pathname-only reclaimer; new file generations need no such leak.
			if (!stat.isFile()) continue;
			let removable = false;
			try {
				const owner = JSON.parse(readFileSync(artifact, "utf8")) as {
					pid?: unknown;
					processStartToken?: unknown;
					createdAt?: unknown;
				};
				removable = !processMarkerIsLive(owner);
			} catch {
				removable = Date.now() - stat.mtimeMs > 30_000;
			}
			if (removable) rmSync(artifact, { force: true });
		} catch {
			// A concurrent owner/reclaimer changed it; its exact generation wins.
		}
	}
}

/**
 * Serialize reclamation of one observed regular-file lock generation. The
 * lease is a COMPLETE non-empty directory published by atomic rename. Stale
 * lease generations are renamed to permanent non-empty tombstones, so a late
 * contender can never remove a replacement lease (the ABA flaw of unlink).
 */
function withReclaimLeaseSync<T>(leasePath: string, action: () => T): T {
	mkdirSync(dirname(leasePath), { recursive: true });
	const leaseId = `reclaim_${process.pid}_${randomBytes(12).toString("hex")}`;
	const candidate = `${leasePath}.candidate-${leaseId}`;
	const processStartToken = pidStartToken(process.pid);
	const payload = {
		pid: process.pid,
		lockId: leaseId,
		createdAt: new Date().toISOString(),
		...(processStartToken !== undefined ? { processStartToken } : {}),
	};

	// Sweep dead private candidates; they never owned the public lease path.
	const parent = dirname(leasePath);
	const candidatePrefix = `${basename(leasePath)}.candidate-`;
	try {
		for (const name of readdirSync(parent)) {
			if (!name.startsWith(candidatePrefix)) continue;
			const path = join(parent, name);
			try {
				const stat = lstatSync(path);
				if (!stat.isDirectory()) continue;
				let removable = false;
				try {
					removable = !processMarkerIsLive(JSON.parse(readFileSync(join(path, "owner.json"), "utf8")));
				} catch {
					removable = Date.now() - stat.mtimeMs > 30_000;
				}
				if (removable) rmSync(path, { recursive: true, force: true });
			} catch {
				// Concurrent candidate cleanup/publication; re-read next time.
			}
		}
	} catch {
		// Parent scan is best-effort; candidate publication below remains safe.
	}

	mkdirSync(candidate, { mode: 0o700 });
	try {
		writeFileSync(join(candidate, "owner.json"), `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		rmSync(candidate, { recursive: true, force: true });
		throw error;
	}
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let acquired = false;
	try {
		for (;;) {
			try {
				renameSync(candidate, leasePath);
				acquired = true;
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
			}

			let stale = false;
			let observed = "";
			try {
				const stat = lstatSync(leasePath);
				if (!stat.isDirectory()) throw new Error("reclaim lease is not a directory");
				const raw = readFileSync(join(leasePath, "owner.json"), "utf8");
				// Directory mtime is mutable: a delayed incomplete-generation marker
				// writer can touch a replacement lease. The complete generation CAS
				// therefore keys only on inode identity + immutable owner bytes.
				observed = `lease:${stat.dev}:${stat.ino}:${raw}`;
				stale = !processMarkerIsLive(JSON.parse(raw));
			} catch {
				try {
					const stat = lstatSync(leasePath);
					const marker = `incomplete-lease:${stat.dev}:${stat.ino}`;
					stale = stat.isDirectory() && Date.now() - stat.mtimeMs > 30_000;
					if (stale) {
						const markerPath = join(leasePath, ".stale-generation");
						try {
							writeFileSync(markerPath, `${marker}\n`, { flag: "wx", mode: 0o600 });
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EEXIST") stale = false;
						}
						// The marker makes the directory non-empty, so a delayed rename
						// cannot replace its tombstone. Revalidate that it was written to
						// the observed inode, not a replacement lease.
						if (stale) {
							const current = lstatSync(leasePath);
							stale = current.isDirectory() && current.dev === stat.dev && current.ino === stat.ino &&
								readFileSync(markerPath, "utf8") === `${marker}\n`;
							observed = marker;
						}
					}
				} catch {
					stale = false;
				}
			}
			if (stale) {
				const generation = createHash("sha256").update(observed).digest("hex");
				try {
					renameSync(leasePath, `${leasePath}.stale-${generation}`);
					continue;
				} catch {
					// Lost the generation-CAS race; re-read the current lease.
				}
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for reclaim lease ${leasePath}`);
			Atomics.wait(SLEEP_CELL, 0, 0, LOCK_WAIT_MS);
		}
		return action();
	} finally {
		if (acquired) {
			try {
				const owner = JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8")) as { lockId?: unknown };
				if (owner.lockId === leaseId) rmSync(leasePath, { recursive: true, force: true });
			} catch {
				// Missing/replaced lease generation is never ours to remove.
			}
		}
		rmSync(candidate, { recursive: true, force: true });
	}
}

/**
 * Serialize a complete read→mutate→write transaction across Pi processes.
 * Atomic rename prevents torn JSON; this lock prevents two valid snapshots
 * from overwriting each other's updates. A dead owner's lock is recoverable.
 */
export function withFileLockSync<T>(file: string, action: () => T): T {
	mkdirSync(dirname(file), { recursive: true });
	const lockPath = `${file}.lock`;
	cleanupFileLockArtifacts(lockPath);
	const lockId = `lock_${process.pid}_${randomBytes(12).toString("hex")}`;
	const processStartToken = pidStartToken(process.pid);
	const ownerPayload = {
		pid: process.pid,
		lockId,
		createdAt: new Date().toISOString(),
		...(processStartToken !== undefined ? { processStartToken } : {}),
	};
	// Publish only a COMPLETE record: the private candidate is written first,
	// then hard-linked into the shared pathname with create-if-absent semantics.
	// A crash can leave an irrelevant candidate, never an ownerless live lock.
	const candidatePath = `${lockPath}.candidate-${lockId}`;
	writeFileSync(candidatePath, `${JSON.stringify(ownerPayload)}\n`, { flag: "wx", mode: 0o600 });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let acquired = false;

	try {
		for (;;) {
			try {
				linkSync(candidatePath, lockPath);
				acquired = true;
				try { unlinkSync(candidatePath); } catch { /* harmless crash-candidate cleanup */ }
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}

			let stale = false;
			let observed = "";
			let observedIsDirectory = false;
			let observedDev: number | null = null;
			let observedIno: number | null = null;
			let observedMtimeMs: number | null = null;
			let observedRaw: string | null = null;
			try {
				const stat = lstatSync(lockPath);
				if (!stat.isFile() && !stat.isDirectory()) throw new Error("state lock has an unsafe file type");
				observedIsDirectory = stat.isDirectory();
				observedDev = stat.dev;
				observedIno = stat.ino;
				observedMtimeMs = stat.mtimeMs;
				const raw = readFileSync(observedIsDirectory ? join(lockPath, "owner.json") : lockPath, "utf8");
				observedRaw = raw;
				observed = observedIsDirectory
					? `dir:${stat.dev}:${stat.ino}:${raw}`
					: `file:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${raw}`;
				const owner = JSON.parse(raw) as {
					pid?: unknown;
					lockId?: unknown;
					processStartToken?: unknown;
					createdAt?: unknown;
				};
				stale = !processMarkerIsLive(owner);
			} catch {
				try {
					const stat = lstatSync(lockPath);
					if (!stat.isFile() && !stat.isDirectory()) throw new Error("state lock has an unsafe file type");
					observedIsDirectory = stat.isDirectory();
					observedDev = stat.dev;
					observedIno = stat.ino;
					observedMtimeMs = stat.mtimeMs;
					stale = Date.now() - stat.mtimeMs > 30_000;
					observed = `incomplete:${observedIsDirectory ? "dir" : "file"}:${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
					if (stale && observedIsDirectory) {
						// Compatibility with an older writer that published mkdir before
						// owner.json. A stable inode marker makes the source and resulting
						// tombstone non-empty without deriving the CAS key from the mtime
						// changed by writing that marker.
						const marker = `incomplete-dir:${stat.dev}:${stat.ino}`;
						const markerPath = join(lockPath, ".stale-generation");
						try {
							writeFileSync(markerPath, `${marker}\n`, { flag: "wx", mode: 0o600 });
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EEXIST") stale = false;
						}
						if (stale) {
							const current = lstatSync(lockPath);
							stale = current.isDirectory() && current.dev === stat.dev && current.ino === stat.ino &&
								readFileSync(markerPath, "utf8") === `${marker}\n`;
							observed = marker;
						}
					}
				} catch {
					stale = false;
				}
			}
			if (stale) {
				const generation = createHash("sha256").update(observed).digest("hex");
				const tombstone = `${lockPath}.stale-${generation}`;
				if (observedIsDirectory) {
					try {
						// Legacy directory generations are non-empty, so a deterministic
						// tombstone makes rename an atomic generation CAS.
						renameSync(lockPath, tombstone);
						continue;
					} catch {
						// Lost the reclaim race (or the generation changed): re-read.
					}
				} else {
					try {
						// All contenders that observed this exact file generation serialize
						// through a crash-recoverable directory lease. Only the lease owner
						// may unlink, and it revalidates inode+mtime+contents first. A delayed
						// contender therefore cannot unlink a replacement live lock.
						const removed = withReclaimLeaseSync(`${lockPath}.reclaim-${generation}`, () => {
							const active = lstatSync(lockPath);
							if (!active.isFile()) return false;
							if (
								observedDev === null || observedIno === null || observedMtimeMs === null ||
								active.dev !== observedDev || active.ino !== observedIno ||
								active.mtimeMs !== observedMtimeMs
							) return false;
							if (observedRaw !== null && readFileSync(lockPath, "utf8") !== observedRaw) return false;
							unlinkSync(lockPath);
							return true;
						});
						if (removed) continue;
					} catch {
						// Lost the reclaim race (or the generation changed): re-read.
					}
				}
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for state lock ${lockPath}`);
			Atomics.wait(SLEEP_CELL, 0, 0, LOCK_WAIT_MS);
		}

		return action();
	} finally {
		if (acquired) {
			try {
				if (!lstatSync(lockPath).isFile()) throw new Error("state lock was replaced with an unsafe file type");
				const current = JSON.parse(readFileSync(lockPath, "utf8")) as { lockId?: unknown };
				if (current.lockId === lockId) unlinkSync(lockPath);
			} catch {
				// Missing/replaced generation is never ours to remove.
			}
		}
		try { rmSync(candidatePath, { force: true }); } catch { /* best-effort private cleanup */ }
		cleanupFileLockArtifacts(lockPath);
	}
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
	return finiteNonNegative(value) && Number.isInteger(value);
}

function validateRecord(address: string, value: unknown): value is AgentRecord {
	const parsedAddress = parseAddress(address);
	if (parsedAddress?.kind !== "agent" || typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const vitals = record.vitals;
	return (
		record.type === parsedAddress.type &&
		record.id === parsedAddress.id &&
		(record.state === "queued" || record.state === "running" || record.state === "dormant" || record.state === "waiting") &&
		(record.lifetime === "persistent" || record.lifetime === "oneshot") &&
		typeof record.purview === "string" &&
		typeof record.typeFileHash === "string" &&
		typeof record.generationId === "string" && /^gen_[0-9a-f]{32}$/.test(record.generationId) &&
		typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt)) &&
		typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt)) &&
		typeof vitals === "object" && vitals !== null && !Array.isArray(vitals) &&
		finiteNonNegative((vitals as Record<string, unknown>).contextPercent) &&
		((vitals as Record<string, unknown>).contextPercent as number) <= 100 &&
		nonNegativeInteger((vitals as Record<string, unknown>).tokens) &&
		finiteNonNegative((vitals as Record<string, unknown>).cost) &&
		nonNegativeInteger((vitals as Record<string, unknown>).turns) &&
		nonNegativeInteger((vitals as Record<string, unknown>).compactions)
	);
}

/** Read registry.json; a missing file is an empty roster. */
export function readRegistry(file: string): Registry {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
		throw error;
	}
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (parsed.version !== 1 || typeof parsed.agents !== "object" || parsed.agents === null || Array.isArray(parsed.agents)) {
		throw new Error(`Unrecognized registry format in ${file}`);
	}
	for (const [address, record] of Object.entries(parsed.agents as Record<string, unknown>)) {
		// Backward-compatible one-time normalization: legacy registries predate
		// incarnation IDs. Derive a stable value so concurrent readers agree;
		// the next ordinary update persists it. Fresh/recreated agents use random.
		if (
			typeof record === "object" && record !== null && !Array.isArray(record) &&
			(record as Record<string, unknown>).generationId === undefined &&
			typeof (record as Record<string, unknown>).createdAt === "string"
		) {
			(record as Record<string, unknown>).generationId = `gen_${createHash("sha256")
				.update(`legacy:${address}:${String((record as Record<string, unknown>).createdAt)}`)
				.digest("hex").slice(0, 32)}`;
		}
		if (!validateRecord(address, record)) throw new Error(`Invalid agent record "${address}" in ${file}`);
	}
	return parsed as unknown as Registry;
}

/** Write registry.json atomically (tmp + rename; creates parent dirs). */
export function writeRegistry(file: string, registry: Registry): void {
	withFileLockSync(file, () => atomicWriteJson(file, registry));
}

/** Read → mutate → atomic write in one serialized step. */
export function updateRegistry<T>(file: string, mutate: (registry: Registry) => T): T {
	return withFileLockSync(file, () => {
		const registry = readRegistry(file);
		const result = mutate(registry);
		atomicWriteJson(file, registry);
		return result;
	});
}

/** Shared atomic-JSON helper (also used by teams.ts). */
export function atomicWriteJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Roster CRUD
// ---------------------------------------------------------------------------

export interface NewAgentOptions {
	type: string;
	id: string;
	lifetime: Lifetime;
	purview: string;
	typeFileHash: string;
	/** Test/migration override; normally generated with 128 random bits. */
	generationId?: string;
	/** Initial state; spawns start queued until the scheduler grants a slot (D13). */
	state?: AgentState;
	now?: Date;
}

/**
 * Get-or-create on address (D4/D5): if the agent exists it is returned
 * untouched (memory intact — spawn wakes it); otherwise a fresh record is
 * added. `created` tells the spawn tool which happened.
 */
export function upsertAgent(
	registry: Registry,
	options: NewAgentOptions,
): { record: AgentRecord; created: boolean } {
	const address = formatAgentAddress(options.type, options.id);
	const existing = registry.agents[address];
	if (existing) return { record: existing, created: false };
	const now = (options.now ?? new Date()).toISOString();
	const record: AgentRecord = {
		type: options.type,
		id: options.id,
		state: options.state ?? "queued",
		lifetime: options.lifetime,
		purview: options.purview,
		vitals: emptyVitals(),
		typeFileHash: options.typeFileHash,
		generationId: options.generationId ?? `gen_${randomBytes(16).toString("hex")}`,
		createdAt: now,
		updatedAt: now,
	};
	registry.agents[address] = record;
	return { record, created: true };
}

export function getAgent(registry: Registry, address: string): AgentRecord | undefined {
	return registry.agents[address];
}

export function listAgents(registry: Registry): AgentRecord[] {
	return Object.values(registry.agents);
}

/** Deregister (retire step 1 — the dir move is store/archive.ts). */
export function removeAgent(registry: Registry, address: string): AgentRecord | undefined {
	const record = registry.agents[address];
	if (record) delete registry.agents[address];
	return record;
}

/** Patch a record's mutable fields; bumps updatedAt. Returns false if unknown. */
export function patchAgent(
	registry: Registry,
	address: string,
	patch: Partial<Pick<AgentRecord, "state" | "purview" | "typeFileHash">> & { vitals?: Partial<AgentVitals> },
	now: Date = new Date(),
): boolean {
	const record = registry.agents[address];
	if (!record) return false;
	if (patch.state !== undefined) record.state = patch.state;
	if (patch.purview !== undefined) record.purview = patch.purview;
	if (patch.typeFileHash !== undefined) record.typeFileHash = patch.typeFileHash;
	if (patch.vitals) record.vitals = { ...record.vitals, ...patch.vitals };
	record.updatedAt = now.toISOString();
	return true;
}
