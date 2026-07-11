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

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatAgentAddress, parseAddress } from "../mail/envelope.ts";

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
const LOCK_TIMEOUT_MS = 5_000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Serialize a complete read→mutate→write transaction across Pi processes.
 * Atomic rename prevents torn JSON; this lock prevents two valid snapshots
 * from overwriting each other's updates. A dead owner's lock is recoverable.
 */
export function withFileLockSync<T>(file: string, action: () => T): T {
	mkdirSync(dirname(file), { recursive: true });
	const lockFile = `${file}.lock`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let fd: number | undefined;
	for (;;) {
		try {
			fd = openSync(lockFile, "wx", 0o600);
			writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
			break;
		} catch (error) {
			const createdLock = fd !== undefined;
			if (fd !== undefined) {
				try { closeSync(fd); } catch {}
				fd = undefined;
			}
			if (createdLock) {
				// Exclusive create succeeded but owner-data write failed: do not
				// strand a lock that no reader can identify as stale.
				try { unlinkSync(lockFile); } catch {}
				throw error;
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: unknown };
				stale = typeof owner.pid !== "number" || !pidAlive(owner.pid);
			} catch {
				// A creator may be between exclusive-create and owner-data write.
				// Only reclaim malformed/empty locks old enough not to be that race.
				try { stale = Date.now() - statSync(lockFile).mtimeMs > 30_000; } catch {}
			}
			if (stale) {
				try { unlinkSync(lockFile); } catch {}
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for state lock ${lockFile}`);
			Atomics.wait(SLEEP_CELL, 0, 0, LOCK_WAIT_MS);
		}
	}
	try {
		return action();
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
		try { unlinkSync(lockFile); } catch {}
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
