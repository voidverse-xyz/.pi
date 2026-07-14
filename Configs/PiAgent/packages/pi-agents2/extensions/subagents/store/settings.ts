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
 * Precedence: defaults → global (`~/.pi/agent/subagents.json`) → project
 * (`<cwd>/.pi/subagents.json`). Each layer overrides field-by-field. A layer
 * that fails to parse is NOT treated as empty (that would silently drop
 * restrictive values, v1 finding #12) — the last-known-good value for that
 * absolute path is retained and a warning surfaced.
 */

import { readFileSync } from "node:fs";

export interface SubagentsSettings {
	maxConcurrent: number;
	maxHops: number;
	archiveGcDays: number;
}

export const DEFAULT_SETTINGS: SubagentsSettings = {
	maxConcurrent: 5,
	maxHops: 8,
	archiveGcDays: 7,
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
	/** True when the file existed but could not be read/parsed (retain last-known-good). */
	degraded: boolean;
	warnings: string[];
}

/** Read one settings file into a validated patch. Missing file → empty patch (intentional). */
export function readSettingsFile(path: string): LayerReadResult {
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
		return { patch: {}, degraded: true, warnings: [`${path}: invalid JSON — retaining last-known-good`] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { patch: {}, degraded: true, warnings: [`${path}: not a JSON object — retaining last-known-good`] };
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
	for (const key of Object.keys(raw)) {
		if (!(key in DEFAULT_SETTINGS)) warnings.push(`${path}: unknown key ${JSON.stringify(key)} — ignored`);
	}
	return { patch, degraded: false, warnings };
}

/**
 * A live-reloadable settings loader. Holds last-known-good patches per absolute
 * path so a transiently-broken file never reverts to defaults (finding #12).
 */
export class SettingsLoader {
	private lastGood = new Map<string, Patch>();

	constructor(
		private readonly globalPath: string,
		private readonly projectPath: string,
	) {}

	/** Read both layers now and merge over defaults. Returns settings + warnings. */
	load(): { settings: SubagentsSettings; warnings: string[] } {
		const warnings: string[] = [];
		const layers: Patch[] = [];
		for (const path of [this.globalPath, this.projectPath]) {
			const result = readSettingsFile(path);
			warnings.push(...result.warnings);
			if (result.degraded) {
				layers.push(this.lastGood.get(path) ?? {});
			} else {
				this.lastGood.set(path, result.patch);
				layers.push(result.patch);
			}
		}
		const settings: SubagentsSettings = { ...DEFAULT_SETTINGS };
		for (const layer of layers) Object.assign(settings, layer);
		return { settings, warnings };
	}
}
