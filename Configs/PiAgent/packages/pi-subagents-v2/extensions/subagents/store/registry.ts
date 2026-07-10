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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatAgentAddress } from "../mail/envelope.ts";

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
// File I/O (atomic)
// ---------------------------------------------------------------------------

/** Read registry.json; a missing file is an empty roster. */
export function readRegistry(file: string): Registry {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
		throw error;
	}
	const parsed = JSON.parse(raw) as Registry;
	if (parsed.version !== 1 || typeof parsed.agents !== "object" || parsed.agents === null) {
		throw new Error(`Unrecognized registry format in ${file}`);
	}
	return parsed;
}

/** Write registry.json atomically (tmp + rename; creates parent dirs). */
export function writeRegistry(file: string, registry: Registry): void {
	atomicWriteJson(file, registry);
}

/** Read → mutate → atomic write in one step. Returns the mutation's result. */
export function updateRegistry<T>(file: string, mutate: (registry: Registry) => T): T {
	const registry = readRegistry(file);
	const result = mutate(registry);
	writeRegistry(file, registry);
	return result;
}

/** Shared atomic-JSON helper (also used by teams.ts). */
export function atomicWriteJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
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
