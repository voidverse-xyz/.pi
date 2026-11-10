/**
 * store/settings.ts — extension settings, layered and fail-closed.
 *
 *   maxConcurrent  — running-agent cap; over-cap spawns queue.
 *   archiveGcDays  — N-day retention for retired dirs + processed mail.
 *
 * Precedence: defaults → global (`~/.pi/agent/subagents.json`) → project
 * (`<cwd>/.pi/subagents.json`). Each layer overrides field-by-field. A layer
 * that fails to read/parse contributes nothing and surfaces a warning — never
 * a silent fallback. Settings load once per session_start.
 */

import { readFileSync } from "node:fs";

export interface SubagentsSettings {
	maxConcurrent: number;
	archiveGcDays: number;
}

export const DEFAULT_SETTINGS: SubagentsSettings = {
	maxConcurrent: 4,
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
	/** True when the file existed but could not be read/parsed (layer contributes nothing). */
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
	const archiveGcDays = readIntField(raw, "archiveGcDays", 0, 3650, warnings);
	if (archiveGcDays !== undefined) patch.archiveGcDays = archiveGcDays;
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
