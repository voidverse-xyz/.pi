/**
 * Config for the /commit review flow.
 *
 * Discovery (first file found wins):
 *   1. <cwd>/.pi/commit.json          (project)
 *   2. ~/.pi/agent/commit.json        (user; resolved via getAgentDir())
 *   3. built-in defaults (DEFAULT_CONFIG below)
 *
 * Merge semantic: keys present in the chosen file REPLACE the built-in default
 * for that key wholesale (e.g. a `groups` array replaces ALL default groups —
 * there is no extend/append). Omitted keys keep their defaults. Invalid keys
 * are dropped with a warning and fall back to their defaults.
 *
 * Shape:
 *   {
 *     "groups": [{ "name": string, "patterns": [glob, ...] }, ...],
 *     "exclude": [glob, ...],
 *     "noVerify": boolean,
 *     "commitTemplate": string
 *   }
 *
 * Globs support ** / * / ? (see glob.ts). `exclude` globs are unconditional:
 * matching paths never appear in review groups (they are listed on the summary
 * screen instead). `commitTemplate` supports exactly three placeholders:
 *   {group}    the group's name/title
 *   {files}    the group's paths, comma-separated
 *   {summary}  the heuristic verb phrase (e.g. "update auth controller")
 * Anything else in the template is literal.
 *
 * Discovery/IO lives in loadCommitConfig; DEFAULT_CONFIG, sanitizing and
 * template rendering are pure so a node harness can exercise them directly.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_GROUPS = 100;
const MAX_PATTERNS_PER_GROUP = 200;
const MAX_EXCLUDES = 500;
const MAX_GLOB_LENGTH = 512;
const MAX_NAME_LENGTH = 200;
const MAX_TEMPLATE_LENGTH = 4096;

export interface GroupRule {
	name: string;
	patterns: string[];
}

export interface CommitConfig {
	groups: GroupRule[];
	exclude: string[];
	noVerify: boolean;
	commitTemplate: string;
}

/**
 * Built-in defaults — the classifier's former hardcoded project-specific rules
 * (metaForPath) and local-dev exclusions (isLocalDevOnly's path list),
 * re-expressed in the config shape. Rule order = review order; the first rule
 * whose patterns match a path claims it.
 */
export const DEFAULT_CONFIG: CommitConfig = {
	// Unmatched paths are grouped by their containing directory. Defaults stay
	// project-agnostic and never silently exclude files.
	groups: [],
	exclude: [],
	// Hooks run by default; skipping verification must be an explicit choice.
	noVerify: false,
	commitTemplate: "{summary}",
};

export interface LoadedConfig {
	config: CommitConfig;
	/** Which file was used, or "defaults" when none was found. */
	source: string;
	/** Human-readable problems with the file (bad JSON, wrong key types). */
	warnings: string[];
}

/** Discover and load config. Project config is honored only for trusted projects. */
export async function loadCommitConfig(
	cwd: string,
	agentDir: string,
	allowProjectConfig: boolean,
	configDirName: string,
): Promise<LoadedConfig> {
	const candidates = [
		...(allowProjectConfig ? [join(cwd, configDirName, "commit.json")] : []),
		join(agentDir, "commit.json"),
	];

	for (const path of candidates) {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue; // missing/unreadable — try the next candidate
		}

		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (e) {
			return {
				config: { ...DEFAULT_CONFIG },
				source: path,
				warnings: [`invalid JSON (${String(e)}) — using built-in defaults`],
			};
		}

		const { config, warnings } = sanitizeConfig(raw);
		return { config, source: path, warnings };
	}

	return { config: { ...DEFAULT_CONFIG }, source: "defaults", warnings: [] };
}

/** Merge a parsed config file onto DEFAULT_CONFIG, dropping invalid keys with warnings. */
export function sanitizeConfig(raw: unknown): { config: CommitConfig; warnings: string[] } {
	const config: CommitConfig = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { config, warnings: ["config root must be an object — using built-in defaults"] };
	}
	const obj = raw as Record<string, unknown>;
	const knownKeys = new Set(["groups", "exclude", "noVerify", "commitTemplate"]);
	for (const key of Object.keys(obj)) {
		if (!knownKeys.has(key)) warnings.push(`unknown key "${key}" — ignored`);
	}

	if ("groups" in obj) {
		const groups = sanitizeGroups(obj.groups, warnings);
		if (groups) config.groups = groups;
	}
	if ("exclude" in obj) {
		if (isNonEmptyStringArray(obj.exclude) && obj.exclude.length <= MAX_EXCLUDES && obj.exclude.every(validGlob)) {
			config.exclude = obj.exclude.map((value) => value.trim());
		} else {
			warnings.push(`"exclude" must contain at most ${MAX_EXCLUDES} non-empty glob strings of at most ${MAX_GLOB_LENGTH} characters — keeping default`);
		}
	}
	if ("noVerify" in obj) {
		if (typeof obj.noVerify === "boolean") config.noVerify = obj.noVerify;
		else warnings.push('"noVerify" must be a boolean — keeping default (false)');
	}
	if ("commitTemplate" in obj) {
		if (typeof obj.commitTemplate === "string" && obj.commitTemplate.trim() && obj.commitTemplate.length <= MAX_TEMPLATE_LENGTH) {
			config.commitTemplate = obj.commitTemplate;
		} else {
			warnings.push(`"commitTemplate" must be a non-empty string of at most ${MAX_TEMPLATE_LENGTH} characters — keeping default`);
		}
	}

	return { config, warnings };
}

function sanitizeGroups(value: unknown, warnings: string[]): GroupRule[] | null {
	if (!Array.isArray(value)) {
		warnings.push('"groups" must be an array — keeping defaults');
		return null;
	}
	if (value.length > MAX_GROUPS) {
		warnings.push(`"groups" may contain at most ${MAX_GROUPS} entries — keeping defaults`);
		return null;
	}
	const rules: GroupRule[] = [];
	for (const [i, entry] of value.entries()) {
		const rule = entry as { name?: unknown; patterns?: unknown };
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof rule.name !== "string" ||
			!rule.name.trim() ||
			rule.name.length > MAX_NAME_LENGTH ||
			!isNonEmptyStringArray(rule.patterns) ||
			rule.patterns.length === 0 ||
			rule.patterns.length > MAX_PATTERNS_PER_GROUP ||
			!rule.patterns.every(validGlob)
		) {
			warnings.push(`"groups[${i}]" has an invalid/oversized name or pattern list — dropped`);
			continue;
		}
		rules.push({ name: rule.name.trim(), patterns: rule.patterns.map((pattern) => pattern.trim()) });
	}
	return rules;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim().length > 0);
}

function validGlob(value: string): boolean {
	return value.trim().length <= MAX_GLOB_LENGTH;
}

/**
 * Render a commit message from the template. Placeholders: {group}, {files},
 * {summary}. An all-placeholder template that renders to nothing falls back to
 * the summary so a commit never gets an empty message.
 */
export function renderCommitMessage(
	template: string,
	vars: { group: string; files: string[]; summary: string },
): string {
	const rendered = template
		.replaceAll("{group}", vars.group)
		.replaceAll("{files}", vars.files.join(", "))
		.replaceAll("{summary}", vars.summary)
		.trim();
	return rendered || vars.summary;
}
