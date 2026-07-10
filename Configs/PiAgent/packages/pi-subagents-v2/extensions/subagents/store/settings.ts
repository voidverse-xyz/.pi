/**
 * store/settings.ts — extension settings: the real source Phase 7 wires in
 * (D21 placement rule: "extension settings (global, per-project override) —
 * NOT type frontmatter").
 *
 * Mechanism (Pi-idiomatic — the same shape pi-plan-commit uses for its
 * config): two plain JSON files, both optional, merged field by field:
 *
 *   ~/.pi/agent/subagents.json    global defaults        (layout.globalSettingsFile)
 *   <project>/.pi/subagents.json  per-project overrides  (layout.projectSettingsFile)
 *
 * Pi's own settings.json schema is a CLOSED typed interface (SettingsManager)
 * with no extension section, so extensions keep their config in their own
 * sidecar file next to the surfaces they already own; both paths come from
 * store/layout.ts (single path authority). Precedence, lowest first:
 * doc defaults → global file → project file → programmatic overrides
 * (CreateCoreOptions.settings, used by harnesses).
 *
 * Live semantics: core keeps ONE mutable settings object that the runtime
 * reads per turn (autonomy limits, ceilings, autoWake). applySettingsInto()
 * re-reads the files into that same object — index.ts calls it at every real
 * user turn, so file edits apply without /reload. Exceptions (bound at core
 * creation, i.e. next session / /reload): maxConcurrent (the scheduler is
 * constructed with it). Everything else is live.
 *
 * Validation is lenient-but-honest: unknown keys and mistyped values are
 * skipped with a human-readable warning, never thrown — a typo in a config
 * file must not take the extension down. `null` on an optional ceiling field
 * explicitly clears it back to "unlimited".
 */

import { readFileSync } from "node:fs";
import { DEFAULT_AUTONOMOUS_TOKENS, DEFAULT_AUTONOMOUS_TURNS } from "../rails/autonomy.ts";
import { DEFAULT_MAX_HOPS } from "../rails/hops.ts";
import { DEFAULT_GC_DAYS } from "./archive.ts";
import type { Layout } from "./layout.ts";

/** D13 running-turn slot cap default (mirrors runtime/scheduler.ts). */
const DEFAULT_MAX_CONCURRENT = 5;

export interface SubagentsSettings {
	/**
	 * D16 selective auto-wake: question|escalation|error envelopes start a
	 * main-agent turn when it is idle. false = fully-manual queueing.
	 */
	autoWake: boolean;
	/** D13 running-turn slot cap. Default 5. Applied at core creation. */
	maxConcurrent: number;
	/** D21 causal-chain depth cap. Default 8. */
	maxHops: number;
	/** D21 autonomy pool: autonomous turns since the last user input. Default 40. */
	autonomousTurns: number;
	/** D21 autonomy pool: tokens consumed by autonomous turns. Default 500k. */
	autonomousTokens: number;
	/** N-day retention for .archive/, mailbox .done/, resolved escalations. Default 7. */
	archiveGcDays: number;
	/**
	 * D15 global ceiling defaults — frontmatter overrides field by field; an
	 * unset field means unlimited. Read live per subagent turn.
	 */
	maxTokensTotal?: number;
	maxTurnMinutes?: number;
	maxContextCompactions?: number;
}

/** Doc defaults (D13/D16/D21, archive GC per D13). */
export function defaultSettings(): SubagentsSettings {
	return {
		autoWake: true,
		maxConcurrent: DEFAULT_MAX_CONCURRENT,
		maxHops: DEFAULT_MAX_HOPS,
		autonomousTurns: DEFAULT_AUTONOMOUS_TURNS,
		autonomousTokens: DEFAULT_AUTONOMOUS_TOKENS,
		archiveGcDays: DEFAULT_GC_DAYS,
	};
}

// ---------------------------------------------------------------------------
// File parsing (lenient)
// ---------------------------------------------------------------------------

type FieldKind = "boolean" | "positive-int" | "positive-number" | "optional-positive-number";

const FIELDS: Record<keyof SubagentsSettings, FieldKind> = {
	autoWake: "boolean",
	maxConcurrent: "positive-int",
	maxHops: "positive-int",
	autonomousTurns: "positive-int",
	autonomousTokens: "positive-number",
	archiveGcDays: "positive-number",
	maxTokensTotal: "optional-positive-number",
	maxTurnMinutes: "optional-positive-number",
	maxContextCompactions: "optional-positive-number",
};

/**
 * A parsed settings file: values that passed validation. `null` survives only
 * on optional fields, meaning "explicitly unset (unlimited)".
 */
export type SettingsPatch = Partial<{
	[K in keyof SubagentsSettings]: SubagentsSettings[K] | null;
}>;

export interface ReadSettingsResult {
	values: SettingsPatch;
	/** Human-readable problems (unknown keys, wrong types, unparsable file). */
	warnings: string[];
}

/** Read + validate one settings file. Missing file = empty patch, no warning. */
export function readSettingsFile(file: string): ReadSettingsResult {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { values: {}, warnings: [] };
		return { values: {}, warnings: [`${file}: unreadable (${String(error)})`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { values: {}, warnings: [`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { values: {}, warnings: [`${file}: expected a JSON object`] };
	}

	const values: SettingsPatch = {};
	const warnings: string[] = [];
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		const kind = FIELDS[key as keyof SubagentsSettings];
		if (kind === undefined) {
			warnings.push(`${file}: unknown setting "${key}" ignored`);
			continue;
		}
		const field = key as keyof SubagentsSettings;
		if (value === null) {
			if (kind === "optional-positive-number") values[field] = null;
			else warnings.push(`${file}: "${key}" cannot be null — ignored`);
			continue;
		}
		switch (kind) {
			case "boolean":
				if (typeof value === "boolean") (values as Record<string, unknown>)[field] = value;
				else warnings.push(`${file}: "${key}" must be a boolean — ignored`);
				break;
			case "positive-int":
				if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
					(values as Record<string, unknown>)[field] = value;
				} else warnings.push(`${file}: "${key}" must be a positive integer — ignored`);
				break;
			case "positive-number":
			case "optional-positive-number":
				if (typeof value === "number" && Number.isFinite(value) && value > 0) {
					(values as Record<string, unknown>)[field] = value;
				} else warnings.push(`${file}: "${key}" must be a positive number — ignored`);
				break;
		}
	}
	return { values, warnings };
}

// ---------------------------------------------------------------------------
// Merge + live reload
// ---------------------------------------------------------------------------

export interface LoadSettingsResult {
	settings: SubagentsSettings;
	warnings: string[];
}

/** defaults ← global file ← project file (both paths from layout). */
export function loadSettings(layout: Pick<Layout, "globalSettingsFile" | "projectSettingsFile">): LoadSettingsResult {
	const settings = defaultSettings();
	const warnings: string[] = [];
	for (const file of [layout.globalSettingsFile, layout.projectSettingsFile]) {
		const read = readSettingsFile(file);
		warnings.push(...read.warnings);
		mergePatch(settings, read.values);
	}
	return { settings, warnings };
}

/** Apply one file's patch onto a settings object (null clears optionals). */
export function mergePatch(target: SubagentsSettings, patch: SettingsPatch): void {
	for (const [key, value] of Object.entries(patch)) {
		const field = key as keyof SubagentsSettings;
		if (value === null) {
			delete target[field];
		} else if (value !== undefined) {
			(target as unknown as Record<string, unknown>)[field] = value;
		}
	}
}

/**
 * Re-read both files INTO an existing live settings object (the one the
 * autonomy budget and ceiling checks read per turn), preserving programmatic
 * overrides given at core creation. Returns warnings.
 */
export function applySettingsInto(
	target: SubagentsSettings,
	layout: Pick<Layout, "globalSettingsFile" | "projectSettingsFile">,
	programmaticOverrides: SettingsPatch = {},
): string[] {
	const { settings: fresh, warnings } = loadSettings(layout);
	mergePatch(fresh, programmaticOverrides);
	// Mutate in place: replace every field, drop optionals absent in fresh.
	for (const key of Object.keys(FIELDS) as Array<keyof SubagentsSettings>) {
		if (key in fresh) (target as unknown as Record<string, unknown>)[key] = fresh[key];
		else delete target[key];
	}
	return warnings;
}
