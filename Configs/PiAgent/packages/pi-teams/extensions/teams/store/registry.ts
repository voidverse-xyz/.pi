/**
 * store/registry.ts — the roster: who exists, their state, and live vitals (D15).
 *
 * v2 has NO cross-process locking. The single host-scope lease (D7,
 * store/host-lease.ts) guarantees exactly one owning process per session scope,
 * and the JS event loop serializes mutations within it. So registry writes need
 * only be CRASH-atomic — a tmp-file + rename — not concurrency-safe. This
 * deletes v1's ~265-line hard-link/ABA-tombstone/reclaim-lease machinery.
 *
 * Pure roster math (emptyRegistry/upsert/get/list/remove/patch) is separated
 * from IO (read/write) so it unit-tests without a filesystem.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatAgentAddress } from "../mail/envelope.ts";

export type AgentState = "queued" | "running" | "dormant" | "waiting";
export type Lifetime = "persistent" | "oneshot";

export interface AgentVitals {
	state: AgentState;
	/** Context fill 0–100, or null before the first turn. */
	ctxPercent: number | null;
	tokens: number;
	cost: number;
	turns: number;
}

export interface AgentRecord {
	type: string;
	id: string;
	lifetime: Lifetime;
	/** Incarnation fence `gen_<32hex>` — bumped when the session handle is rebuilt. */
	generationId: string;
	/** sha256 of the resolved type `.md` at last wake (live-resolve fence, D6). */
	typeFileHash: string;
	createdAt: string;
	lastActiveAt: string;
	vitals: AgentVitals;
}

export interface Registry {
	version: 1;
	/** Keyed by `<type>/<id>`. */
	agents: Record<string, AgentRecord>;
}

const GENERATION_ID_RE = /^gen_[0-9a-f]{32}$/;

export function newGenerationId(): string {
	return `gen_${randomBytes(16).toString("hex")}`;
}

export function emptyRegistry(): Registry {
	return { version: 1, agents: Object.create(null) as Record<string, AgentRecord> };
}

export function defaultVitals(state: AgentState = "dormant"): AgentVitals {
	return { state, ctxPercent: null, tokens: 0, cost: 0, turns: 0 };
}

// ---------------------------------------------------------------------------
// Pure roster operations
// ---------------------------------------------------------------------------

export interface UpsertInput {
	type: string;
	id: string;
	lifetime: Lifetime;
	typeFileHash: string;
	now: string;
}

/** Get-or-create (D4): existing address is returned as-is (created:false). */
export function upsertAgent(registry: Registry, input: UpsertInput): { record: AgentRecord; created: boolean } {
	const address = formatAgentAddress(input.type, input.id);
	const existing = registry.agents[address];
	if (existing) {
		existing.typeFileHash = input.typeFileHash;
		existing.lastActiveAt = input.now;
		return { record: existing, created: false };
	}
	const record: AgentRecord = {
		type: input.type,
		id: input.id,
		lifetime: input.lifetime,
		generationId: newGenerationId(),
		typeFileHash: input.typeFileHash,
		createdAt: input.now,
		lastActiveAt: input.now,
		vitals: defaultVitals("dormant"),
	};
	registry.agents[address] = record;
	return { record, created: true };
}

export function getAgent(registry: Registry, address: string): AgentRecord | undefined {
	return registry.agents[address];
}

export function listAgents(registry: Registry): AgentRecord[] {
	return Object.values(registry.agents).sort((a, b) =>
		formatAgentAddress(a.type, a.id).localeCompare(formatAgentAddress(b.type, b.id)),
	);
}

export function removeAgent(registry: Registry, address: string): boolean {
	if (!(address in registry.agents)) return false;
	delete registry.agents[address];
	return true;
}

export interface AgentPatch {
	lifetime?: Lifetime;
	generationId?: string;
	typeFileHash?: string;
	lastActiveAt?: string;
	vitals?: Partial<AgentVitals>;
}

export function patchAgent(registry: Registry, address: string, patch: AgentPatch): AgentRecord | undefined {
	const record = registry.agents[address];
	if (!record) return undefined;
	const { vitals, ...rest } = patch;
	Object.assign(record, rest);
	if (vitals) record.vitals = { ...record.vitals, ...vitals };
	return record;
}

// ---------------------------------------------------------------------------
// IO (crash-atomic; single-writer per host lease)
// ---------------------------------------------------------------------------

const STATES = new Set<AgentState>(["queued", "running", "dormant", "waiting"]);

function vitalsAreValid(v: unknown): v is AgentVitals {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	if (typeof r.state !== "string" || !STATES.has(r.state as AgentState)) return false;
	if (r.ctxPercent !== null && typeof r.ctxPercent !== "number") return false;
	if (typeof r.tokens !== "number" || typeof r.cost !== "number" || typeof r.turns !== "number") return false;
	return true;
}

/** The record's IDENTITY fields (which key/anchor its on-disk dir) must be intact. */
function hasValidIdentity(value: unknown): value is AgentRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	if (typeof r.type !== "string" || typeof r.id !== "string") return false;
	if (r.lifetime !== "persistent" && r.lifetime !== "oneshot") return false;
	if (typeof r.generationId !== "string" || !GENERATION_ID_RE.test(r.generationId)) return false;
	if (typeof r.typeFileHash !== "string") return false;
	if (typeof r.createdAt !== "string" || typeof r.lastActiveAt !== "string") return false;
	return true;
}

/**
 * Read the registry; missing file → empty. A record whose IDENTITY is intact but
 * whose vitals are corrupt is REPAIRED (vitals reset to dormant defaults) rather
 * than dropped — dropping would orphan a live agent's instance dir/mailbox with no
 * roster entry to reference or GC it (finding: silent live-state loss). Only a
 * record whose identity itself is unusable (can't be keyed) is discarded.
 */
export function readRegistry(path: string): Registry {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return emptyRegistry();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return emptyRegistry();
	}
	const registry = emptyRegistry();
	if (typeof parsed === "object" && parsed !== null) {
		const agents = (parsed as Record<string, unknown>).agents;
		if (typeof agents === "object" && agents !== null) {
			for (const [address, record] of Object.entries(agents)) {
				if (!hasValidIdentity(record) || formatAgentAddress(record.type, record.id) !== address) continue;
				if (!vitalsAreValid((record as AgentRecord).vitals)) {
					(record as AgentRecord).vitals = defaultVitals("dormant");
				}
				registry.agents[address] = record as AgentRecord;
			}
		}
	}
	return registry;
}

/**
 * Atomic + crash-durable write: write a tmp file in the same dir, fsync its data,
 * rename over the target, then fsync the directory so the rename itself survives a
 * crash (ext4 data=writeback / xfs can otherwise resurrect a zero-length file). The
 * tmp file is cleaned up if the write fails (no `.<hex>.tmp` litter on ENOSPC).
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
	// Durably record the rename in the directory entry (best-effort — some
	// platforms/filesystems reject O_RDONLY fsync on a directory).
	try {
		const dfd = openSync(dir, "r");
		try {
			fsyncSync(dfd);
		} finally {
			closeSync(dfd);
		}
	} catch {
		/* ignore */
	}
}

export function writeRegistry(path: string, registry: Registry): void {
	atomicWriteJson(path, registry);
}
