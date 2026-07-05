/**
 * Plan Commit — layered git review with native Pi TUI
 *
 * /plan-commit — review uncommitted changes group by group,
 * commit on accept, optional squash at the end.
 *
 * User-level: ~/.pi/agent/extensions/plan-commit/
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { classifyPaths, isLocalDevOnly, type ReviewGroup } from "./classify.ts";
import { createGit } from "./git.ts";
import { createReviewPanel, type ReviewAction } from "./review-panel.ts";

interface SessionCommit {
	sha: string;
	message: string;
}

export default function planCommitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("plan-commit", {
		description: "Layered review and commit with native TUI",
		handler: async (_args, ctx) => runPlanCommit(pi, ctx),
	});
}

async function runPlanCommit(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("plan-commit requires interactive TUI mode", "error");
		return;
	}

	const git = createGit(pi, ctx.cwd);

	if (!(await git.isRepo())) {
		ctx.ui.notify("Not a git repository", "error");
		return;
	}

	const paths = await git.changedPaths();
	if (paths.length === 0) {
		ctx.ui.notify("No uncommitted changes", "info");
		return;
	}

	const excluded: string[] = [];
	for (const path of paths) {
		const diff = await git.diffForPaths([path]);
		if (isLocalDevOnly(path, diff)) excluded.push(path);
	}

	let { groups } = classifyPaths(paths, excluded);
	if (groups.length === 0) {
		ctx.ui.notify("No reviewable changes (local dev exclusions only?)", "info");
		return;
	}

	const sessionCommits: SessionCommit[] = [];
	let stopped = false;

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]!;
		const action = await showGroup(ctx, git, group, i, groups.length);

		switch (action) {
			case "accept": {
				const sha = await git.stageAndCommit(group.paths, group.commitMessage);
				if (!sha) {
					ctx.ui.notify(`Commit failed for: ${group.title}`, "error");
					break;
				}
				sessionCommits.push({ sha, message: group.commitMessage });
				ctx.ui.notify(`Committed ${sha} — ${group.commitMessage}`, "success");
				break;
			}
			case "ask": {
				const question = await ctx.ui.input(`Ask about: ${group.title}`, "Your question…");
				if (!question?.trim()) break;

				pi.sendUserMessage(
					`[plan-commit] Question about review group "${group.title}" (${group.paths.join(", ")}):\n\n${question.trim()}\n\nAnswer only about this group's changes. Do not commit.`,
					{ deliverAs: "followUp" },
				);
				await ctx.waitForIdle();
				ctx.ui.notify("Agent answered — check chat, then continue review", "info");
				i--;
				break;
			}
			case "edit": {
				const instruction = await ctx.ui.input(`Edit: ${group.title}`, "What should change?");
				if (!instruction?.trim()) break;

				pi.sendUserMessage(
					`[plan-commit] Edit request for review group "${group.title}" (${group.paths.join(", ")}):\n\n${instruction.trim()}\n\nApply the edits only for these files. Do not commit.`,
					{ deliverAs: "followUp" },
				);
				await ctx.waitForIdle();

				const freshPaths = await git.changedPaths();
				groups = classifyPaths(freshPaths, excluded).groups;
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

	await showSummary(ctx, sessionCommits, excluded, stopped);

	if (sessionCommits.length > 1) {
		await offerSquash(ctx, git, sessionCommits);
	}
}

async function showGroup(
	ctx: ExtensionCommandContext,
	git: ReturnType<typeof createGit>,
	group: ReviewGroup,
	index: number,
	total: number,
): Promise<ReviewAction> {
	const diff = await git.diffForPaths(group.paths);

	const action = await ctx.ui.custom<ReviewAction>(
		(tui, theme, kb, done) =>
			createReviewPanel({
				group,
				index,
				total,
				diff,
				tui,
				theme,
				keybindings: kb,
				diffForPath: (path) => git.diffForPaths([path]),
				readFile: (path) => git.readWorkingFile(path),
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
	excluded: string[],
	stopped: boolean,
): Promise<void> {
	const lines: string[] = [];

	if (stopped) {
		lines.push("Review stopped.");
	} else {
		lines.push("Review complete.");
	}

	if (commits.length > 0) {
		lines.push("");
		lines.push(`Session commits (${commits.length}):`);
		for (const [i, c] of commits.entries()) {
			lines.push(`  ${i + 1}. ${c.sha} ${c.message}`);
		}
	} else {
		lines.push("");
		lines.push("No commits this session.");
	}

	if (excluded.length > 0) {
		lines.push("");
		lines.push(`Left unstaged (local dev): ${excluded.join(", ")}`);
	}

	ctx.ui.notify(lines.join("\n"), commits.length > 0 ? "success" : "info");
}

async function offerSquash(
	ctx: ExtensionCommandContext,
	git: ReturnType<typeof createGit>,
	commits: SessionCommit[],
): Promise<void> {
	const list = commits.map((c, i) => `${i + 1}. ${c.sha} ${c.message}`).join("\n");
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

	const ok = await git.softReset(commits.length);
	if (!ok) {
		ctx.ui.notify("Squash failed at reset", "error");
		return;
	}

	const sha = await git.commitAll(message.trim());
	if (!sha) {
		ctx.ui.notify("Squash failed at commit", "error");
		return;
	}

	ctx.ui.notify(`Squashed into ${sha} — ${message.trim()}`, "success");
}
