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
 * reads per turn (session and per-agent warning thresholds). applySettingsInto()
 * re-reads the files into that same object — index.ts calls it at every real
 * user turn, so file edits apply without /reload. Exceptions (bound at core
 * creation, i.e. next session / /reload): maxConcurrent (the scheduler is
 * constructed with it). Everything else is live.
 *
 * Validation is lenient-but-honest: unknown keys and mistyped values are
 * skipped with a human-readable warning, never thrown — a typo in a config
 * file must not take the extension down. `null` on an optional warning-threshold field
 * explicitly clears it back to "unlimited".
 *
 * FAIL-CLOSED on a WHOLE-FILE read/parse failure (Finding 12): a temporarily
 * malformed file (mid-edit save, transient unreadable) must NOT collapse to an
 * empty layer — that would silently replace restrictive live values with the
 * doc defaults and drop optional warning thresholds. Instead the LAST-KNOWN-GOOD parse of
 * that exact file (cached per absolute path) is retained until the file becomes
 * readable/valid again; only an intentionally MISSING file (ENOENT) removes the
 * layer. The degraded read still returns a warning so the host can surface it.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_AUTONOMOUS_TOKENS, DEFAULT_AUTONOMOUS_TURNS } from "../rails/autonomy.ts";
import { DEFAULT_MAX_HOPS } from "../rails/hops.ts";
import { DEFAULT_GC_DAYS } from "./archive.ts";
import type { Layout } from "./layout.ts";

/** D13 running-turn slot cap default (mirrors runtime/scheduler.ts). */
const DEFAULT_MAX_CONCURRENT = 5;

export interface SubagentsSettings {
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
	 * D15/D27 global warning defaults — frontmatter overrides field by field;
	 * an unset field means no warning. Read live per subagent turn.
	 */
	maxTokensTotal?: number;
	maxTurnMinutes?: number;
	maxContextCompactions?: number;
}

/** Doc defaults (D13/D16/D21, archive GC per D13). */
export function defaultSettings(): SubagentsSettings {
	return {
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
	/**
	 * True when a WHOLE-FILE read/parse FAILED (unreadable / invalid JSON / not
	 * an object). `values` is then empty; the live-reload path (applySettingsInto)
	 * retains that file's last-known-good layer instead of failing open to
	 * defaults (Finding 12). A missing (ENOENT) file is NOT degraded — it is an
	 * intentional layer removal. Individual bad FIELDS only warn (not degraded).
	 */
	degraded?: boolean;
}

/**
 * Read + validate one settings file (PURE — no cross-call state). Missing file
 * = empty patch, no warning. A whole-file failure returns an empty patch with
 * `degraded: true` so callers can distinguish "temporarily broken" (retain the
 * last-known-good) from "intentionally empty/absent" (drop the layer).
 */
export function readSettingsFile(file: string): ReadSettingsResult {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { values: {}, warnings: [] };
		return { values: {}, warnings: [`${file}: unreadable (${String(error)})`], degraded: true };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			values: {},
			warnings: [`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`],
			degraded: true,
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { values: {}, warnings: [`${file}: expected a JSON object`], degraded: true };
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
		// Seed live reload's fallback from the initial successful load. Without
		// this, the first malformed save after startup had no last-known-good
		// layer and silently failed open until one valid reload had occurred.
		if (!read.degraded) lastKnownGoodByFile.set(file, read.values);
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
 * Last-known-good patch per absolute settings-file path (Finding 12), owned by
 * the LIVE-RELOAD path only. Keyed by path so distinct projects/homes never
 * share state. A successful read (including a valid empty file or an ENOENT
 * removal, both `{}`) overwrites the entry; a degraded read reuses it. Kept for
 * the process lifetime — exactly the "hold the last valid values while the file
 * is temporarily broken" window.
 */
const lastKnownGoodByFile = new Map<string, SettingsPatch>();

/**
 * Re-read both files INTO an existing live settings object (the one the
 * session/per-agent warning checks read per turn), preserving programmatic
 * overrides given at core creation. Returns warnings.
 *
 * Finding 12: a source whose whole-file read/parse FAILED (`degraded`) does NOT
 * collapse to an empty layer — its last-known-good patch is reused, so a
 * mid-edit malformed save cannot silently drop restrictive live values back to
 * the defaults. Only a successful read (a valid file, or an intentional ENOENT
 * removal) updates the retained layer. readSettingsFile stays pure; the
 * retention lives here, at the one place that reloads live.
 */
export function applySettingsInto(
	target: SubagentsSettings,
	layout: Pick<Layout, "globalSettingsFile" | "projectSettingsFile">,
	programmaticOverrides: SettingsPatch = {},
): string[] {
	const fresh = defaultSettings();
	const warnings: string[] = [];
	for (const file of [layout.globalSettingsFile, layout.projectSettingsFile]) {
		const read = readSettingsFile(file);
		warnings.push(...read.warnings);
		let patch: SettingsPatch;
		if (read.degraded) {
			patch = lastKnownGoodByFile.get(file) ?? {}; // retain last valid (or empty if none yet)
		} else {
			patch = read.values;
			lastKnownGoodByFile.set(file, read.values); // success / ENOENT updates (or clears) the layer
		}
		mergePatch(fresh, patch);
	}
	mergePatch(fresh, programmaticOverrides);
	// Mutate in place: replace every field, drop optionals absent in fresh.
	for (const key of Object.keys(FIELDS) as Array<keyof SubagentsSettings>) {
		if (key in fresh) (target as unknown as Record<string, unknown>)[key] = fresh[key];
		else delete target[key];
	}
	return warnings;
}
