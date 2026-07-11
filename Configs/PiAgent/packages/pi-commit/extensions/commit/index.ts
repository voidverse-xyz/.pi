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
 * User-level: ~/.pi/agent/extensions/commit/
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { runGroupChat } from "./chat.ts";
import { classifyPaths, type ReviewGroup } from "./classify.ts";
import { loadCommitConfig } from "./config.ts";
import { generateCommitDescription } from "./describe.ts";
import { createGit } from "./git.ts";
import { createReviewPanel, type ReviewAction } from "./review-panel.ts";

interface SessionCommit {
	sha: string;
	message: string;
	paths: string[];
}

/** A commit that dry-run mode would have made. */
interface PlannedCommit {
	group: string;
	message: string;
	paths: string[];
}

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

	const parsedArgs = args.trim() ? args.trim().split(/\s+/) : [];
	if (parsedArgs.some((arg) => arg !== "--dry-run") || parsedArgs.filter((arg) => arg === "--dry-run").length > 1) {
		ctx.ui.notify("Usage: /commit [--dry-run]", "error");
		return;
	}
	const dryRun = parsedArgs.includes("--dry-run");
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

	let { groups, excluded } = classifyPaths(paths, config);
	if (groups.length === 0) {
		ctx.ui.notify("No reviewable changes (config exclusions only?)", "info");
		return;
	}

	const sessionCommits: SessionCommit[] = [];
	const plannedCommits: PlannedCommit[] = [];
	const descriptionCache = new Map<string, string>();
	let stopped = false;

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]!;
		const action = await showGroup(ctx, git, group, i, groups.length, dryRun, descriptionCache);

		switch (action) {
			case "accept": {
				if (dryRun) {
					plannedCommits.push({ group: group.title, message: group.commitMessage, paths: group.paths });
					ctx.ui.notify(
						`[dry-run] Would commit "${group.commitMessage}" — ${group.paths.join(", ")}`,
						"info",
					);
					break;
				}
				let sha: string | null;
				try {
					sha = await git.stageAndCommit(group.paths, group.commitMessage);
				} catch (error) {
					ctx.ui.notify(`Commit failed while restoring the Git index: ${error instanceof Error ? error.message : String(error)}. Inspect git status before continuing.`, "error");
					stopped = true;
					break;
				}
				if (!sha) {
					ctx.ui.notify(`Commit failed for: ${group.title}. Review the Git state and retry or stop.`, "error");
					i--;
					break;
				}
				sessionCommits.push({ sha, message: group.commitMessage, paths: group.paths });
				ctx.ui.notify(`Committed ${sha.slice(0, 8)} — ${group.commitMessage}`, "info");
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
				i--; // re-review this same group after the chat closes
				break;
			}
			case "edit": {
				const instruction = await ctx.ui.input(`Edit: ${group.title}`, "What should change?");
				if (!instruction?.trim()) break;

				pi.sendUserMessage(
					`[commit] Edit request for review group "${group.title}" (${group.paths.join(", ")}):\n\n${instruction.trim()}\n\nApply the edits only for these files. Do not commit.`,
					{ deliverAs: "followUp" },
				);
				await ctx.waitForIdle();

				let freshPaths: string[];
				try {
					freshPaths = await git.changedPaths();
				} catch (error) {
					ctx.ui.notify(`Could not refresh Git changes: ${error instanceof Error ? error.message : String(error)}`, "error");
					stopped = true;
					break;
				}
				({ groups, excluded } = classifyPaths(freshPaths, config));
				descriptionCache.clear();
				const updatedIndex = groups.findIndex((g) => g.id === group.id);
				if (updatedIndex >= 0) {
					i = updatedIndex - 1;
				} else {
					const byPath = groups.findIndex((g) => g.paths.some((p) => group.paths.includes(p)));
					if (byPath >= 0) i = byPath - 1;
					else i--;
				}
				ctx.ui.notify("Edits applied — re-reviewing group", "info");
				break;
			}
			case "skip":
				ctx.ui.notify(`Skipped: ${group.title}`, "info");
				break;
			case "stop":
				stopped = true;
				break;
		}

		if (stopped) break;
	}

	await showSummary(ctx, sessionCommits, plannedCommits, excluded, stopped, dryRun);

	if (!dryRun && sessionCommits.length > 1) {
		await offerSquash(ctx, git, sessionCommits);
	}
}

async function showGroup(
	ctx: ExtensionCommandContext,
	git: ReturnType<typeof createGit>,
	group: ReviewGroup,
	index: number,
	total: number,
	dryRun: boolean,
	descriptionCache: Map<string, string>,
): Promise<ReviewAction> {
	const action = await ctx.ui.custom<ReviewAction>(
		(tui, theme, kb, done) =>
			createReviewPanel({
				group,
				index,
				total,
				dryRun,
				tui,
				theme,
				keybindings: kb,
				loadDiff: (scope, path, full) =>
					git.diffForPaths(scope === "group" ? group.paths : path ? [path] : [], { full }),
				loadDescription: async (signal) => {
					const key = `${group.id}\0${group.commitMessage}\0${group.paths.join("\0")}`;
					const cached = descriptionCache.get(key);
					if (cached) return cached;
					const diff = await git.diffForPaths(group.paths);
					const value = await generateCommitDescription(ctx, group, diff, signal);
					if (!signal.aborted) descriptionCache.set(key, value);
					return value;
				},
				onDone: done,
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);

	return action ?? "stop";
}

async function showSummary(
	ctx: ExtensionCommandContext,
	commits: SessionCommit[],
	planned: PlannedCommit[],
	excluded: string[],
	stopped: boolean,
	dryRun: boolean,
): Promise<void> {
	const lines: string[] = [];

	if (dryRun) {
		lines.push(stopped ? "DRY RUN — review stopped." : "DRY RUN — review complete.");
		lines.push("No git state was changed.");
		if (planned.length > 0) {
			lines.push("");
			lines.push(`Would have committed (${planned.length}):`);
			for (const [i, p] of planned.entries()) {
				lines.push(`  ${i + 1}. [${p.group}] ${p.message}`);
				lines.push(`     ${p.paths.join(", ")}`);
			}
		} else {
			lines.push("");
			lines.push("No groups accepted.");
		}
	} else {
		lines.push(stopped ? "Review stopped." : "Review complete.");
		if (commits.length > 0) {
			lines.push("");
			lines.push(`Session commits (${commits.length}):`);
			for (const [i, c] of commits.entries()) {
				lines.push(`  ${i + 1}. ${c.sha.slice(0, 8)} ${c.message}`);
			}
		} else {
			lines.push("");
			lines.push("No commits this session.");
		}
	}

	if (excluded.length > 0) {
		lines.push("");
		lines.push(`Left unstaged (excluded by config): ${excluded.join(", ")}`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

async function offerSquash(
	ctx: ExtensionCommandContext,
	git: ReturnType<typeof createGit>,
	commits: SessionCommit[],
): Promise<void> {
	const list = commits.map((c, i) => `${i + 1}. ${c.sha.slice(0, 8)} ${c.message}`).join("\n");
	const suggested = commits.length === 1 ? commits[0]!.message : "add feature";

	const choice = await ctx.ui.select(`Squash ${commits.length} session commits?\n\n${list}`, [
		`Yes — squash into one commit`,
		"No — keep separate",
	]);

	if (!choice?.startsWith("Yes")) return;

	const message = await ctx.ui.input("Squash commit message", suggested);
	if (!message?.trim()) {
		ctx.ui.notify("Squash cancelled — no message", "warning");
		return;
	}

	const sessionPaths = [...new Set(commits.flatMap((c) => c.paths))];
	if (await git.pathsHaveChanges(sessionPaths)) {
		ctx.ui.notify("Squash skipped: session paths have new staged or unstaged changes", "warning");
		return;
	}
	const shas = commits.map((commit) => commit.sha);
	if (!(await git.canSquash(shas))) {
		ctx.ui.notify("Squash skipped: session commits are no longer the contiguous tip of this branch", "warning");
		return;
	}
	const base = await git.parentOf(commits[0]!.sha);
	if (!base) {
		ctx.ui.notify("Squash skipped: cannot safely squash a root commit", "warning");
		return;
	}
	const originalHead = commits[commits.length - 1]!.sha;
	if (!(await git.softResetTo(base))) {
		ctx.ui.notify("Squash failed at reset", "error");
		return;
	}

	// Only re-commit the session's own paths, so files the user had staged before
	// running /commit aren't swept into the squash commit.
	let sha: string | null;
	try {
		sha = await git.stageAndCommit(sessionPaths, message.trim());
	} catch (error) {
		const restored = await git.softResetTo(originalHead);
		ctx.ui.notify(
			`Squash failed while restoring the Git index: ${error instanceof Error ? error.message : String(error)}. ${restored ? "Original HEAD restored; inspect git status." : "HEAD restoration also failed; inspect git status and reflog."}`,
			"error",
		);
		return;
	}
	if (!sha) {
		const restored = await git.softResetTo(originalHead);
		ctx.ui.notify(
			restored
				? "Squash commit failed; original commits were restored"
				: "Squash commit failed and automatic HEAD restoration also failed; inspect git status and reflog",
			"error",
		);
		return;
	}

	ctx.ui.notify(`Squashed into ${sha.slice(0, 8)} — ${message.trim()}`, "info");
}
