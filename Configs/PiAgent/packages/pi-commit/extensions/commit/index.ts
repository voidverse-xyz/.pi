/**
 * Plan Commit — layered git review with native Pi TUI
 *
 * /commit — review uncommitted changes group by group,
 * commit on accept, optional squash at the end.
 * /commit --dry-run — same review flow, but accept only reports what
 * WOULD be committed; no git state changes.
 *
 * Grouping, exclusions, --no-verify and the commit-message template come from
 * .pi/commit.json (project) or ~/.pi/agent/commit.json (user) —
 * see config.ts for the shape and defaults.
 *
 * The per-group review-loop steps and the summary/squash live in review-flow.ts;
 * this file holds the command entry and the loop that drives them.
 *
 * User-level: ~/.pi/agent/extensions/commit/
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { runGroupChat } from "./chat.ts";
import { classifyPaths } from "./classify.ts";
import { loadCommitConfig } from "./config.ts";
import { createGit } from "./git.ts";
import {
	handleAccept,
	handleEdit,
	offerSquash,
	type PlannedCommit,
	type ReviewState,
	type SessionCommit,
	showGroup,
	showSummary,
} from "./review-flow.ts";

export default function commitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Layered review and commit with native TUI (--dry-run to preview)",
		handler: async (args, ctx) => runCommit(pi, ctx, args),
	});
}

async function runCommit(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/commit requires interactive TUI mode", "error");
		return;
	}

	const trimmedArgs = args.trim();
	if (trimmedArgs && trimmedArgs !== "--dry-run") {
		ctx.ui.notify("Usage: /commit [--dry-run]", "error");
		return;
	}
	const dryRun = trimmedArgs === "--dry-run";
	await ctx.waitForIdle();

	const { config, source, warnings } = await loadCommitConfig(
		ctx.cwd,
		getAgentDir(),
		ctx.isProjectTrusted(),
		CONFIG_DIR_NAME,
	);
	for (const w of warnings) {
		ctx.ui.notify(`commit config (${source}): ${w}`, "warning");
	}

	const git = createGit(pi, ctx.cwd, { noVerify: config.noVerify });

	if (!(await git.isRepo())) {
		ctx.ui.notify("Not a git repository", "error");
		return;
	}

	let paths: string[];
	try {
		paths = await git.changedPaths();
	} catch (error) {
		ctx.ui.notify(`Could not read Git changes: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	if (paths.length === 0) {
		ctx.ui.notify("No uncommitted changes", "info");
		return;
	}

	const state: ReviewState = classifyPaths(paths, config);
	if (state.groups.length === 0) {
		ctx.ui.notify("No reviewable changes (config exclusions only?)", "info");
		return;
	}

	const sessionCommits: SessionCommit[] = [];
	const plannedCommits: PlannedCommit[] = [];
	const descriptionCache = new Map<string, string>();
	let stopped = false;

	let i = 0;
	while (i < state.groups.length && !stopped) {
		const group = state.groups[i]!;
		const action = await showGroup(ctx, git, group, i, state.groups.length, dryRun, descriptionCache);
		let nextIndex = i + 1;

		switch (action) {
			case "accept": {
				const outcome = await handleAccept(ctx, git, group, i, dryRun, sessionCommits, plannedCommits);
				if ("stop" in outcome) stopped = true;
				else nextIndex = outcome.next;
				break;
			}
			case "ask": {
				// Pick who answers, then open a persistent chat panel that stays open
				// until the user closes it (multiple follow-up questions in a row).
				const choice = await ctx.ui.select(`Ask about: ${group.title}`, [
					"Subagent — isolated, answers here in a chat panel",
					"Main agent — full context, answers in the main chat",
				]);
				if (choice) {
					const target = choice.startsWith("Subagent") ? "sub" : "main";
					const diffText = await git.diffForPaths(group.paths);
					await runGroupChat(pi, ctx, group, diffText, target);
				}
				nextIndex = i; // re-review this same group after the chat closes
				break;
			}
			case "edit": {
				const outcome = await handleEdit(pi, ctx, git, config, group, i, state, descriptionCache);
				if ("stop" in outcome) stopped = true;
				else nextIndex = outcome.next;
				break;
			}
			case "skip":
				ctx.ui.notify(`Skipped: ${group.title}`, "info");
				break;
			case "stop":
				stopped = true;
				break;
		}

		i = nextIndex;
	}

	await showSummary(ctx, sessionCommits, plannedCommits, state.excluded, stopped, dryRun);

	if (!dryRun && sessionCommits.length > 1) {
		await offerSquash(ctx, git, sessionCommits);
	}
}
