/**
 * store/settings.ts — extension settings (D13/D21), layered and fail-closed.
 *
 * Slim vs v1: only the three system knobs survive — the autonomy budget (D21),
 * warning ceilings (D15/D20), and per-agent budgets are all gone.
 *
 *   maxConcurrent  — running-agent cap; over-cap spawns queue (D13).
 *   maxHops        — causal-chain depth before a message bounces (D21).
 *   archiveGcDays  — N-day retention for retired dirs + processed mail (D13).
 *
 * Precedence: defaults → global (`~/.pi/agent/teams.json`) → project
 * (`<cwd>/.pi/teams.json`). Each layer overrides field-by-field. A layer
 * that fails to read/parse contributes nothing and surfaces a warning — never
 * a silent fallback (v1 finding #12). Settings load once per session_start.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_MAX_HOPS } from "../rails/hops.ts";

export type PeerControl = "on" | "off" | "llm";
const PEER_CONTROLS: PeerControl[] = ["on", "off", "llm"];

export interface SubagentsSettings {
	maxConcurrent: number;
	maxHops: number;
	archiveGcDays: number;
	/** User-level peer-messaging control (D12): "on"/"off" force it, "llm" lets the main agent decide. */
	peers: PeerControl;
}

export const DEFAULT_SETTINGS: SubagentsSettings = {
	maxConcurrent: 5,
	maxHops: DEFAULT_MAX_HOPS,
	archiveGcDays: 7,
	peers: "llm",
};

type Patch = Partial<SubagentsSettings>;

/** One validated field reader: positive integer within [min,max], else skip+warn. */
function readIntField(
	raw: Record<string, unknown>,
	key: keyof SubagentsSettings,
	min: number,
	max: number,
	warnings: string[],
): number | undefined {
	if (!(key in raw)) return undefined;
	const value = raw[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		warnings.push(`${key}: expected integer in [${min},${max}], got ${JSON.stringify(value)} — ignored`);
		return undefined;
	}
	return value;
}

export interface LayerReadResult {
	patch: Patch;
	/** True when the file existed but could not be read/parsed (layer contributes nothing). */
	degraded: boolean;
	warnings: string[];
}

/** Read one settings file into a validated patch. Missing file → empty patch (intentional). */
function readSettingsFile(path: string): LayerReadResult {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { patch: {}, degraded: false, warnings: [] };
		}
		return { patch: {}, degraded: true, warnings: [`${path}: unreadable (${(error as Error).message})`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { patch: {}, degraded: true, warnings: [`${path}: invalid JSON — layer ignored`] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { patch: {}, degraded: true, warnings: [`${path}: not a JSON object — layer ignored`] };
	}
	const raw = parsed as Record<string, unknown>;
	const warnings: string[] = [];
	const patch: Patch = {};
	const maxConcurrent = readIntField(raw, "maxConcurrent", 1, 64, warnings);
	if (maxConcurrent !== undefined) patch.maxConcurrent = maxConcurrent;
	const maxHops = readIntField(raw, "maxHops", 1, 64, warnings);
	if (maxHops !== undefined) patch.maxHops = maxHops;
	const archiveGcDays = readIntField(raw, "archiveGcDays", 0, 3650, warnings);
	if (archiveGcDays !== undefined) patch.archiveGcDays = archiveGcDays;
	if ("peers" in raw) {
		const value = raw.peers;
		if (typeof value === "string" && (PEER_CONTROLS as string[]).includes(value)) patch.peers = value as PeerControl;
		else warnings.push(`peers: expected one of ${PEER_CONTROLS.join("|")}, got ${JSON.stringify(value)} — ignored`);
	}
	for (const key of Object.keys(raw)) {
		if (!(key in DEFAULT_SETTINGS)) warnings.push(`${path}: unknown key ${JSON.stringify(key)} — ignored`);
	}
	return { patch, degraded: false, warnings };
}

/**
 * Load both layers now and merge over defaults. Stateless — settings are read
 * exactly once per session_start; a broken layer degrades to defaults for that
 * layer (with a warning), the other layer still applies.
 */
export function loadSettings(globalPath: string, projectPath: string): { settings: SubagentsSettings; warnings: string[] } {
	const warnings: string[] = [];
	const settings: SubagentsSettings = { ...DEFAULT_SETTINGS };
	for (const path of [globalPath, projectPath]) {
		const result = readSettingsFile(path);
		warnings.push(...result.warnings);
		Object.assign(settings, result.patch);
	}
	return { settings, warnings };
}
