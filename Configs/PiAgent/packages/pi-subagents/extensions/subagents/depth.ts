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
 * The effective max is resolved (top level) as: env → config file → hard default (1).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const MAXDEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
/** Carries the resolved default ask-limit down to descendants (see the ask_parent section below). */
export const ASK_LIMIT_ENV = "PI_SUBAGENT_ASK_LIMIT";
/**
 * The call-list THIS process may delegate to, carried from the parent at spawn so a
 * nested caller knows its own privilege: "*" = any, a comma list = only those,
 * "" = none. Absent at the top level (unrestricted).
 */
export const CANCALL_ENV = "PI_SUBAGENT_CANCALL";
/**
 * Set to "1" on a spawned child when its agent opted into ask_parent (frontmatter
 * `askLimit` ≥ 1) and still has ask budget this request. ask-parent/index.ts registers
 * the tool only when this is present, so the capability is opt-in per agent and per
 * spawn — the top-level agent (never spawned with it) never sees the tool.
 */
export const ASK_PARENT_ENV = "PI_ASK_PARENT";
/** The persisted cap, editable without launching Pi; written by `/subagent depth`. */
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

/** Read the config file; falls back to HARD_DEFAULT if absent/invalid. */
export function loadGlobalDefault(): number {
	try {
		const raw = JSON.parse(readFileSync(GLOBAL_CONFIG, "utf-8"));
		return toDepth(raw?.maxDepth) ?? HARD_DEFAULT;
	} catch {
		return HARD_DEFAULT;
	}
}

/** Persist the cap; best-effort (throws are the caller's to surface). */
export function saveGlobalDefault(maxDepth: number): void {
	mkdirSync(dirname(GLOBAL_CONFIG), { recursive: true });
	writeFileSync(GLOBAL_CONFIG, JSON.stringify({ maxDepth }, null, 2), "utf-8");
}

/**
 * Effective max depth for THIS process. In a nested child the env value wins (the
 * top level already resolved it); at the top level, the config file wins, then the
 * hard default.
 */
export function resolveMaxDepth(): number {
	const fromEnv = toDepth(process.env[MAXDEPTH_ENV]);
	if (fromEnv !== undefined) return fromEnv;
	return loadGlobalDefault();
}

/**
 * Environment for a spawned child: bump the depth, carry the cap and the default
 * ask-limit down unchanged, and record the child's call-list so it knows who it may
 * delegate to.
 */
export function childEnv(maxDepth: number, childCanCall: string, askLimitDefault: number): NodeJS.ProcessEnv {
	return {
		...process.env,
		[DEPTH_ENV]: String(currentDepth() + 1),
		[MAXDEPTH_ENV]: String(maxDepth),
		[CANCALL_ENV]: childCanCall,
		[ASK_LIMIT_ENV]: String(askLimitDefault),
	};
}

// ---- ask_parent budget default --------------------------------------------
//
// Each agent's ask_parent allowance is its frontmatter `askLimit`, or — when it sets
// none — this user-configurable default. Resolved exactly like maxDepth (env → config
// file → hard default) and carried to descendants via ASK_LIMIT_ENV so a nested parent
// applies the same default to agents it spawns.

/** The persisted default, editable without launching Pi; written by `/subagent asklimit`. */
export const ASK_LIMIT_CONFIG = join(getAgentDir(), "subagent-asklimit.json");
/** Shipped default: an agent may ask its parent once per request unless it says otherwise. */
export const ASK_LIMIT_HARD_DEFAULT = 1;
/** Presets offered by the `/subagent asklimit` picker (0 = ask_parent off by default). */
export const ASK_LIMIT_CHOICES = [0, 1, 2, 3, 5];

/** A non-negative integer (0 = off is allowed), or undefined if not a usable limit. */
function toAskLimit(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Read the config file; falls back to the hard default if absent/invalid. */
export function loadGlobalAskLimit(): number {
	try {
		const raw = JSON.parse(readFileSync(ASK_LIMIT_CONFIG, "utf-8"));
		return toAskLimit(raw?.askLimit) ?? ASK_LIMIT_HARD_DEFAULT;
	} catch {
		return ASK_LIMIT_HARD_DEFAULT;
	}
}

/** Persist the default; best-effort (throws are the caller's to surface). */
export function saveGlobalAskLimit(askLimit: number): void {
	mkdirSync(dirname(ASK_LIMIT_CONFIG), { recursive: true });
	writeFileSync(ASK_LIMIT_CONFIG, JSON.stringify({ askLimit }, null, 2), "utf-8");
}

/**
 * Effective default ask-limit for THIS process: env (already resolved at the top) wins,
 * then the config file, then the hard default.
 */
export function resolveAskLimit(): number {
	const fromEnv = toAskLimit(process.env[ASK_LIMIT_ENV]);
	if (fromEnv !== undefined) return fromEnv;
	return loadGlobalAskLimit();
}

// ---- call-list escalation for nested calls ---------------------------------
//
// Each agent declares which agents it may delegate to (frontmatter `canDelegateTo:`).
// A NESTED caller may only spawn agents on its own list — "*" = any, a name list =
// only those, unset = none — so a subagent can't reach an agent it wasn't granted.
// The top-level session has no CANCALL_ENV and is unrestricted.

/** The wire form of an agent's delegate-list, for CANCALL_ENV: "*", a comma list, or "". */
export function canCallSpec(agent: AgentConfig): string {
	if (agent.canDelegateTo === "*") return "*";
	return agent.canDelegateTo ? agent.canDelegateTo.join(",") : "";
}

/**
 * Whether the CURRENT process may delegate to `name`: "*" (or top level, no env)
 * allows any; a name list allows only those; "" allows none.
 */
export function targetAllowedByCall(name: string): boolean {
	const raw = process.env[CANCALL_ENV];
	if (raw === undefined || raw === "*") return true;
	const allowed = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
	return allowed.has(name);
}
