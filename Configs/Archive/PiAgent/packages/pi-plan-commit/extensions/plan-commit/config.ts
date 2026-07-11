/**
 * Config for the /git-commit review flow.
 *
 * Discovery (first file found wins):
 *   1. <cwd>/.pi/plan-commit.json          (project)
 *   2. ~/.pi/agent/plan-commit.json        (user; resolved via getAgentDir())
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
 * Discovery/IO lives in loadPlanCommitConfig; DEFAULT_CONFIG, sanitizing and
 * template rendering are pure so a node harness can exercise them directly.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface GroupRule {
	name: string;
	patterns: string[];
}

export interface PlanCommitConfig {
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
export const DEFAULT_CONFIG: PlanCommitConfig = {
	groups: [
		{ name: "Schema + DB wiring", patterns: ["**/database/schemas/**", "**/database/database.js"] },
		{ name: "Controllers", patterns: ["**/controllers/*.js"] },
		{ name: "Routes", patterns: ["**/routes/*.js"] },
		{ name: "Service facades", patterns: ["**/services/backend/**"] },
		{ name: "Hooks & context", patterns: ["**/hooks/**", "**/context/**"] },
		{ name: "UI", patterns: ["**/app/**", "**/components/**"] },
		{ name: "i18n translations", patterns: ["**/languages/**", "**lang**.json"] },
		{ name: "Docs", patterns: ["plan/**", "plans/**", "docs/**"] },
	],
	exclude: ["backend/server.js", "backend/routes/routes.js", "backend/notify/socket/socket.js"],
	noVerify: true,
	commitTemplate: "{summary}",
};

export interface LoadedConfig {
	config: PlanCommitConfig;
	/** Which file was used, or "defaults" when none was found. */
	source: string;
	/** Human-readable problems with the file (bad JSON, wrong key types). */
	warnings: string[];
}

/** Discover and load the config. `agentDir` is ~/.pi/agent (pass getAgentDir()). */
export async function loadPlanCommitConfig(cwd: string, agentDir: string): Promise<LoadedConfig> {
	const candidates = [join(cwd, ".pi", "plan-commit.json"), join(agentDir, "plan-commit.json")];

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
export function sanitizeConfig(raw: unknown): { config: PlanCommitConfig; warnings: string[] } {
	const config: PlanCommitConfig = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { config, warnings: ["config root must be an object — using built-in defaults"] };
	}
	const obj = raw as Record<string, unknown>;

	if ("groups" in obj) {
		const groups = sanitizeGroups(obj.groups, warnings);
		if (groups) config.groups = groups;
	}
	if ("exclude" in obj) {
		if (isStringArray(obj.exclude)) config.exclude = obj.exclude;
		else warnings.push('"exclude" must be an array of glob strings — keeping default');
	}
	if ("noVerify" in obj) {
		if (typeof obj.noVerify === "boolean") config.noVerify = obj.noVerify;
		else warnings.push('"noVerify" must be a boolean — keeping default (true)');
	}
	if ("commitTemplate" in obj) {
		if (typeof obj.commitTemplate === "string" && obj.commitTemplate.trim()) {
			config.commitTemplate = obj.commitTemplate;
		} else {
			warnings.push('"commitTemplate" must be a non-empty string — keeping default');
		}
	}

	return { config, warnings };
}

function sanitizeGroups(value: unknown, warnings: string[]): GroupRule[] | null {
	if (!Array.isArray(value)) {
		warnings.push('"groups" must be an array — keeping defaults');
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
			!isStringArray(rule.patterns) ||
			rule.patterns.length === 0
		) {
			warnings.push(`"groups[${i}]" must be {name: string, patterns: [glob, ...]} — dropped`);
			continue;
		}
		rules.push({ name: rule.name, patterns: rule.patterns });
	}
	return rules;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
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
