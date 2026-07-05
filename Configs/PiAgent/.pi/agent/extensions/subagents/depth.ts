/**
 * Subagent nesting-depth control — shared by the delegation tool (delegate.ts) and
 * the foreground switcher (switcher.ts), the same way agents.ts is shared.
 *
 * Depth is enforced across the `pi` process boundary. Children run `--no-session`,
 * so they can't read the parent's session entries — two env vars carry the policy:
 *
 *   - PI_SUBAGENT_DEPTH      current nesting depth. Absent in the top-level
 *                            interactive session ⇒ 0. Each spawn sets the child's
 *                            to parent + 1.
 *   - PI_SUBAGENT_MAX_DEPTH  the effective cap, resolved once at the top level and
 *                            passed down unchanged to every descendant.
 *
 * Allow-to-spawn rule: a process at depth d may spawn only if d < maxDepth. So
 * maxDepth = 1 ⇒ the top-level session spawns subagents, but those subagents can't
 * spawn their own (exactly one level).
 *
 * The effective max is resolved (top level) as: env → per-session entry → global
 * default file → hard default (1).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const MAXDEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
/**
 * The tools THIS process was granted, carried from the parent at spawn so a nested
 * caller knows its own privilege. A comma list, or "*" for the unrestricted
 * (inherit-all) set. Absent at the top level (the user is unrestricted).
 */
export const TOOLS_ENV = "PI_SUBAGENT_TOOLS";
const ALL_TOOLS = "*";
/** Custom session-entry type carrying a per-session override `{ maxDepth }`. */
export const MAXDEPTH_ENTRY = "subagent-maxdepth";
/** Global cross-session default, editable without launching Pi. */
export const GLOBAL_CONFIG = join(getAgentDir(), "subagent-depth.json");
export const HARD_DEFAULT = 1;
/** Presets offered by the `/subagent depth` picker. */
export const DEPTH_CHOICES = [1, 2, 3, 5];

/** A positive integer ≥ 1, or undefined if the value isn't a usable depth. */
function toDepth(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Nesting depth of the CURRENT process (0 in the top-level interactive session). */
export function currentDepth(): number {
	const n = Number(process.env[DEPTH_ENV]);
	return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** True when this process is itself a spawned subagent. */
export function isNested(): boolean {
	return currentDepth() > 0;
}

/** Read the global default file; falls back to HARD_DEFAULT if absent/invalid. */
export function loadGlobalDefault(): number {
	try {
		const raw = JSON.parse(readFileSync(GLOBAL_CONFIG, "utf-8"));
		return toDepth(raw?.maxDepth) ?? HARD_DEFAULT;
	} catch {
		return HARD_DEFAULT;
	}
}

/** Persist the global default; best-effort (throws are the caller's to surface). */
export function saveGlobalDefault(maxDepth: number): void {
	mkdirSync(dirname(GLOBAL_CONFIG), { recursive: true });
	writeFileSync(GLOBAL_CONFIG, JSON.stringify({ maxDepth }, null, 2), "utf-8");
}

/** Minimal shape of the session manager we read (avoids importing heavy SDK types). */
interface EntryReader {
	getEntries(): Array<{ type: string; customType?: string; data?: { maxDepth?: number } }>;
}

/** The latest per-session override, or undefined if none was set this session. */
export function readSessionMaxDepth(sm: EntryReader): number | undefined {
	const last = sm
		.getEntries()
		.filter((e) => e.type === "custom" && e.customType === MAXDEPTH_ENTRY)
		.pop();
	return toDepth(last?.data?.maxDepth);
}

/**
 * Effective max depth for THIS process. In a nested child the env value wins (the
 * top level already resolved it); at the top level, a per-session override wins,
 * then the global default file, then the hard default.
 */
export function resolveMaxDepth(sm?: EntryReader): number {
	const fromEnv = toDepth(process.env[MAXDEPTH_ENV]);
	if (fromEnv !== undefined) return fromEnv;
	if (sm) {
		const fromSession = readSessionMaxDepth(sm);
		if (fromSession !== undefined) return fromSession;
	}
	return loadGlobalDefault();
}

/** The wire form of an agent's granted tools, for the TOOLS_ENV var. */
export function toolsSpec(agent: AgentConfig): string {
	return agent.tools && agent.tools.length > 0 ? agent.tools.join(",") : ALL_TOOLS;
}

/**
 * Environment for a spawned child: bump the depth, carry the cap down unchanged,
 * and record the tools the child is granted so it knows its own privilege.
 */
export function childEnv(maxDepth: number, childToolsSpec: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		[DEPTH_ENV]: String(currentDepth() + 1),
		[MAXDEPTH_ENV]: String(maxDepth),
		[TOOLS_ENV]: childToolsSpec,
	};
}

// ---- privilege (capability) checks for nested calls ------------------------
//
// Privilege is compared SYMBOLICALLY on the tool specs ("*" = unrestricted, or an
// explicit allowlist). We deliberately do NOT enumerate via pi.getAllTools() /
// getActiveTools(): under `-p`/`--tools` those report the current process's narrowed
// tool universe, which makes an unrestricted target look "lesser" than it really is.

type ToolSpec = "*" | Set<string>;

function parseSpec(raw: string | undefined): ToolSpec | null {
	if (raw === undefined) return null; // no context (top level)
	if (raw === ALL_TOOLS || raw.trim() === "") return "*";
	return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * A nested caller may only delegate to an equal-or-lesser persona:
 *   - an unrestricted caller ("*") may target anything;
 *   - a restricted caller may NOT target an unrestricted persona, and may target a
 *     restricted one only if its tools are a subset of the caller's.
 * The top-level session (no TOOLS_ENV) is unrestricted.
 */
export function targetAllowedByPrivilege(agent: AgentConfig): boolean {
	const caller = parseSpec(process.env[TOOLS_ENV]);
	if (caller === null || caller === "*") return true;
	const target = toolsSpec(agent);
	if (target === ALL_TOOLS) return false; // can't escalate to unrestricted
	for (const tool of target.split(",")) {
		if (tool && !caller.has(tool)) return false;
	}
	return true;
}
