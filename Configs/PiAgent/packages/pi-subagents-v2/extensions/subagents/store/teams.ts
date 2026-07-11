/**
 * store/teams.ts — team membership, the comm ACL for sub→sub mail (D12/D13).
 *
 * teams.json (path from store/layout.ts) is the SINGLE source of truth for
 * membership: `{ "billing-refactor": ["refactorer/auth", "refactorer/api"] }`.
 * Layout stays team-free — durable identity never encodes ephemeral grouping.
 *
 * Rules implemented here:
 *  - sub→sub send allowed iff sender and recipient share ≥1 team (sharedTeam);
 *    delivery-time enforcement lives in mail/deliver.ts (Phase 3+).
 *  - Naming an unknown team creates it (addTo); disband = the entry vanishes
 *    when its last member leaves.
 *  - Retire scrubs the address from ALL teams and deletes emptied teams
 *    (scrubAddress, D13).
 *
 * Pure membership math + thin atomic-file wrappers.
 */

import { readFileSync } from "node:fs";
import { parseAddress } from "../mail/envelope.ts";
import { atomicWriteJson } from "./registry.ts";

/** team name → member addresses (`<type>/<id>`), insertion-ordered, no dupes. */
export type Teams = Record<string, string[]>;

/**
 * Team-name grammar: a filesystem-safe slug (matching the address-segment
 * charset), NOT a reserved prototype-pollution key or empty. Enforced at the
 * spawn boundary (core.spawn) BEFORE any state mutation so a bad name can never
 * commit a partial registry record, and again here as defense-in-depth when
 * reading persisted teams.json.
 */
const TEAM_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const RESERVED_TEAM_NAMES = new Set(["__proto__", "prototype", "constructor"]);

/** True if `name` is a safe, non-reserved team slug. */
export function isValidTeamName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		!RESERVED_TEAM_NAMES.has(name) &&
		!name.startsWith(".") &&
		TEAM_NAME_RE.test(name)
	);
}

/**
 * Coerce a parsed teams.json value into a trustworthy Teams map (finding 11):
 * a NULL-PROTOTYPE object (so a persisted `__proto__`/`constructor` key can't
 * poison lookups), keeping only valid team names mapped to arrays of valid
 * `<type>/<id>` address strings. A member that is a bare STRING (not an array),
 * or an array element that isn't a valid address, is dropped — otherwise a
 * malformed value would let membership checks match by substring (`.includes`
 * on a raw string) and wrongly authorize peers. Emptied teams vanish.
 */
function normalizeTeams(parsed: Record<string, unknown>): Teams {
	const teams: Teams = Object.create(null) as Teams;
	for (const [name, members] of Object.entries(parsed)) {
		if (!isValidTeamName(name) || !Array.isArray(members)) continue;
		const clean: string[] = [];
		for (const member of members) {
			if (typeof member === "string" && parseAddress(member) !== null && !clean.includes(member)) {
				clean.push(member);
			}
		}
		if (clean.length > 0) teams[name] = clean;
	}
	return teams;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Read teams.json; a missing file means no teams. */
export function readTeams(file: string): Teams {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Unrecognized teams format in ${file}`);
	}
	return normalizeTeams(parsed);
}

/** Write teams.json atomically. */
export function writeTeams(file: string, teams: Teams): void {
	atomicWriteJson(file, teams);
}

/** Read → mutate → atomic write in one step. Returns the mutation's result. */
export function updateTeams<T>(file: string, mutate: (teams: Teams) => T): T {
	const teams = readTeams(file);
	const result = mutate(teams);
	writeTeams(file, teams);
	return result;
}

// ---------------------------------------------------------------------------
// Membership (pure)
// ---------------------------------------------------------------------------

/**
 * Add an address to a team, creating the team if new (D12). Idempotent.
 * Defense-in-depth: an invalid/reserved team name is a no-op here (the spawn
 * boundary already rejects it before any state mutation — finding 11), so a
 * `__proto__` name can neither crash nor poison the map.
 */
export function addTo(teams: Teams, team: string, address: string): void {
	if (!isValidTeamName(team)) return;
	const members = teams[team] ?? (teams[team] = []);
	if (!members.includes(address)) members.push(address);
}

/**
 * Remove an address from one team. An emptied team is deleted (a team exists
 * iff it has members). No-op if the address wasn't a member.
 */
export function removeFrom(teams: Teams, team: string, address: string): void {
	const members = teams[team];
	if (!members) return;
	const next = members.filter((m) => m !== address);
	if (next.length === 0) delete teams[team];
	else if (next.length !== members.length) teams[team] = next;
}

/** All teams an address belongs to. */
export function teamsOf(teams: Teams, address: string): string[] {
	return Object.keys(teams).filter((team) => teams[team]!.includes(address));
}

/**
 * The comm check (D12): the first team both addresses belong to, or null.
 * Null → a sub→sub envelope between them must bounce.
 */
export function sharedTeam(teams: Teams, a: string, b: string): string | null {
	for (const [team, members] of Object.entries(teams)) {
		if (members.includes(a) && members.includes(b)) return team;
	}
	return null;
}

/**
 * Retire-time scrub (D13): remove the address from every team; teams left
 * empty are deleted. Returns the teams the address was removed from.
 */
export function scrubAddress(teams: Teams, address: string): string[] {
	const scrubbed: string[] = [];
	for (const team of Object.keys(teams)) {
		if (teams[team]!.includes(address)) {
			scrubbed.push(team);
			removeFrom(teams, team, address);
		}
	}
	return scrubbed;
}

// ---------------------------------------------------------------------------
// Roster views + change lines (Phase 4, D18: "roster changes arrive as
// wake-digest lines"). Mechanism: diff the last-known roster at wake — each
// agent's mailbox keeps a `.roster.json` snapshot (path from store/layout.ts);
// the runtime diffs it against teams.json when composing a wake digest and
// feeds the lines to mail/digest.ts. Diff-at-wake was chosen over event-driven
// because it is stateless across processes and catches EVERY change source
// (spawn-into-team, retire scrub, future manual teams.json edits) for free.
// ---------------------------------------------------------------------------

/** One agent's view of its own teams: team → teammates (self excluded), sorted. */
export type RosterView = Record<string, string[]>;

/** Compute an agent's roster view from the full teams map (pure). */
export function rosterViewOf(teams: Teams, address: string): RosterView {
	const view: RosterView = {};
	for (const team of teamsOf(teams, address)) {
		view[team] = (teams[team] ?? []).filter((member) => member !== address).sort();
	}
	return view;
}

/**
 * Human-readable roster-change lines between two views (pure, deterministic:
 * teams then members in sorted order). Empty array = no changes.
 */
export function diffRosterViews(prev: RosterView, next: RosterView): string[] {
	const lines: string[] = [];
	const teams = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
	for (const team of teams) {
		const before = prev[team];
		const after = next[team];
		if (before === undefined && after !== undefined) {
			lines.push(
				`You joined team \`${team}\`${after.length > 0 ? ` — teammates: ${after.map((m) => `\`${m}\``).join(", ")}` : " (no other members yet)"}`,
			);
			continue;
		}
		if (before !== undefined && after === undefined) {
			lines.push(`You left team \`${team}\` (removed or disbanded) — its members are no longer reachable`);
			continue;
		}
		if (before === undefined || after === undefined) continue; // unreachable
		for (const member of after) {
			if (!before.includes(member)) lines.push(`\`${member}\` joined your team \`${team}\``);
		}
		for (const member of before) {
			if (!after.includes(member)) lines.push(`\`${member}\` left your team \`${team}\` (moved or retired)`);
		}
	}
	return lines;
}

/** Read a roster snapshot file; null = no snapshot yet (first wake). */
export function readRosterSnapshot(file: string): RosterView | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const parsed = JSON.parse(raw) as RosterView;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	return parsed;
}

/** Persist the roster view an agent has now been told about (atomic). */
export function writeRosterSnapshot(file: string, view: RosterView): void {
	atomicWriteJson(file, view);
}
