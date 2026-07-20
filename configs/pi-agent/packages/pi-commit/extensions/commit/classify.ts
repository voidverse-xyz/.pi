/**
 * Config-driven grouping of changed paths for the /commit review flow.
 *
 * Each changed path is tested against config.exclude first (excluded paths
 * never appear in review groups), then against config.groups in order — the
 * first rule whose patterns match claims the path. Paths matching no rule fall
 * into per-directory fallback groups appended after the configured ones.
 *
 * Pure module (glob + template rendering only) — harness-testable with
 * `node --experimental-strip-types`.
 */

import { type CommitConfig, renderCommitMessage } from "./config.ts";
import { matchesAnyGlob } from "./glob.ts";

export interface ReviewGroup {
	id: string;
	title: string;
	layer: string;
	paths: string[];
	commitMessage: string;
	order: number;
}

export function classifyPaths(
	paths: string[],
	config: CommitConfig,
): { groups: ReviewGroup[]; excluded: string[] } {
	const excluded: string[] = [];
	const byRule = new Map<number, string[]>();
	const fallback = new Map<string, string[]>();

	for (const raw of paths) {
		const path = raw.replace(/\\/g, "/");

		if (matchesAnyGlob(path, config.exclude)) {
			excluded.push(path);
			continue;
		}

		const ruleIndex = config.groups.findIndex((rule) => matchesAnyGlob(path, rule.patterns));
		if (ruleIndex >= 0) {
			const bucket = byRule.get(ruleIndex);
			if (bucket) bucket.push(path);
			else byRule.set(ruleIndex, [path]);
			continue;
		}

		const parts = path.split("/");
		const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "root";
		const bucket = fallback.get(dir);
		if (bucket) bucket.push(path);
		else fallback.set(dir, [path]);
	}

	const groups: ReviewGroup[] = [];

	for (const [ruleIndex, rulePaths] of [...byRule.entries()].sort((a, b) => a[0] - b[0])) {
		const rule = config.groups[ruleIndex]!;
		const sorted = [...rulePaths].sort();
		groups.push({
			id: `rule:${ruleIndex}:${rule.name}`,
			title: rule.name,
			layer: "config",
			paths: sorted,
			commitMessage: messageFor(config, rule.name, sorted, summaryFor(rule.name, sorted)),
			order: ruleIndex,
		});
	}

	const fallbackGroups: ReviewGroup[] = [...fallback.entries()]
		.map(([dir, dirPaths]) => {
			const sorted = [...dirPaths].sort();
			const title = sorted.length === 1 ? (sorted[0]?.split("/").pop() ?? "changes") : dir;
			return {
				id: `dir:${dir}`,
				title,
				layer: "other",
				paths: sorted,
				commitMessage: messageFor(config, title, sorted, summaryFor(title, sorted)),
				order: config.groups.length,
			};
		})
		.sort((a, b) => a.title.localeCompare(b.title));

	return { groups: [...groups, ...fallbackGroups], excluded };
}

/**
 * Heuristic {summary} for a group: a single file names itself
 * ("update <basename sans extension>"), several files fall back to the
 * group name ("update <name lowercased>").
 */
function summaryFor(name: string, paths: string[]): string {
	if (paths.length === 1) {
		const base = paths[0]!.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "changes";
		return `update ${base}`;
	}
	return `update ${name.toLowerCase()}`;
}

function messageFor(config: CommitConfig, group: string, files: string[], summary: string): string {
	return renderCommitMessage(config.commitTemplate, { group, files, summary });
}
