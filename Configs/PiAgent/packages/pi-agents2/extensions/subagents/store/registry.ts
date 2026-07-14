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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function patchAgent(registry: Registry, address: string, patch: Partial<Omit<AgentRecord, "type" | "id">>): AgentRecord | undefined {
	const record = registry.agents[address];
	if (!record) return undefined;
	Object.assign(record, patch);
	if (patch.vitals) record.vitals = { ...record.vitals, ...patch.vitals };
	return record;
}

// ---------------------------------------------------------------------------
// IO (crash-atomic; single-writer per host lease)
// ---------------------------------------------------------------------------

const STATES = new Set<AgentState>(["queued", "running", "dormant", "waiting"]);

function isValidRecord(value: unknown): value is AgentRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	if (typeof r.type !== "string" || typeof r.id !== "string") return false;
	if (r.lifetime !== "persistent" && r.lifetime !== "oneshot") return false;
	if (typeof r.generationId !== "string" || !GENERATION_ID_RE.test(r.generationId)) return false;
	if (typeof r.typeFileHash !== "string") return false;
	if (typeof r.createdAt !== "string" || typeof r.lastActiveAt !== "string") return false;
	const v = r.vitals as Record<string, unknown> | undefined;
	if (!v || typeof v !== "object") return false;
	if (typeof v.state !== "string" || !STATES.has(v.state as AgentState)) return false;
	if (v.ctxPercent !== null && typeof v.ctxPercent !== "number") return false;
	if (typeof v.tokens !== "number" || typeof v.cost !== "number" || typeof v.turns !== "number") return false;
	return true;
}

/** Read the registry; malformed records are dropped (defensive), missing file → empty. */
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
				if (isValidRecord(record) && formatAgentAddress(record.type, record.id) === address) {
					registry.agents[address] = record;
				}
			}
		}
	}
	return registry;
}

/** Atomic write: tmp file in the same dir, then rename over the target. */
export function atomicWriteJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
	writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
	renameSync(tmp, path);
}

export function writeRegistry(path: string, registry: Registry): void {
	atomicWriteJson(path, registry);
}
