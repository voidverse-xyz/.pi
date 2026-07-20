/**
 * review-flow.ts — the per-group review-loop steps and end-of-run summary/squash.
 *
 * runCommit (index.ts) drives the loop; each user action delegates here:
 *   accept → handleAccept   edit → handleEdit   (both return a LoopDirective)
 *   showGroup renders one group's review panel and resolves to a ReviewAction.
 * showSummary / offerSquash close out the run. Every function is fully
 * parameterized (git handle, ctx, group, …) — no shared closure state.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { classifyPaths, type ReviewGroup } from "./classify.ts";
import type { CommitConfig } from "./config.ts";
import { generateCommitDescription } from "./describe.ts";
import type { createGit } from "./git.ts";
import { createReviewPanel, type ReviewAction } from "./review-panel.ts";

type Git = ReturnType<typeof createGit>;

export interface SessionCommit {
	sha: string;
	message: string;
	paths: string[];
}

/** A commit that dry-run mode would have made. */
export interface PlannedCommit {
	group: string;
	message: string;
	paths: string[];
}

/** Current review groups/exclusions; handleEdit replaces both after re-classifying. */
export interface ReviewState {
	groups: ReviewGroup[];
	excluded: string[];
}

/** What the review loop should do next: review index `next`, or stop entirely. */
export type LoopDirective = { next: number } | { stop: true };

/**
 * "Accept" case of the review loop: commit the group (or record it in dry-run).
 * A commit that returns no sha re-reviews the same group; a thrown error stops.
 */
export async function handleAccept(
	ctx: ExtensionCommandContext,
	git: Git,
	group: ReviewGroup,
	index: number,
	dryRun: boolean,
	sessionCommits: SessionCommit[],
	plannedCommits: PlannedCommit[],
): Promise<LoopDirective> {
	if (dryRun) {
		plannedCommits.push({ group: group.title, message: group.commitMessage, paths: group.paths });
		ctx.ui.notify(
			`[dry-run] Would commit "${group.commitMessage}" — ${group.paths.join(", ")}`,
			"info",
		);
		return { next: index + 1 };
	}
	let sha: string | null;
	try {
		sha = await git.stageAndCommit(group.paths, group.commitMessage);
	} catch (error) {
		ctx.ui.notify(`Commit failed while restoring the Git index: ${error instanceof Error ? error.message : String(error)}. Inspect git status before continuing.`, "error");
		return { stop: true };
	}
	if (!sha) {
		ctx.ui.notify(`Commit failed for: ${group.title}. Review the Git state and retry or stop.`, "error");
		return { next: index }; // retry the same group
	}
	sessionCommits.push({ sha, message: group.commitMessage, paths: group.paths });
	ctx.ui.notify(`Committed ${sha.slice(0, 8)} — ${group.commitMessage}`, "info");
	return { next: index + 1 };
}

/**
 * "Edit" case of the review loop: send the instruction to the main agent, wait,
 * then re-classify the working tree (updating `state`) and re-review the edited
 * group at its new index (matched by id, then by overlapping path).
 */
export async function handleEdit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: Git,
	config: CommitConfig,
	group: ReviewGroup,
	index: number,
	state: ReviewState,
	descriptionCache: Map<string, string>,
): Promise<LoopDirective> {
	const instruction = await ctx.ui.input(`Edit: ${group.title}`, "What should change?");
	if (!instruction?.trim()) return { next: index + 1 };

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
		return { stop: true };
	}
	({ groups: state.groups, excluded: state.excluded } = classifyPaths(freshPaths, config));
	descriptionCache.clear();

	let next: number;
	const updatedIndex = state.groups.findIndex((g) => g.id === group.id);
	if (updatedIndex >= 0) {
		next = updatedIndex;
	} else {
		const byPath = state.groups.findIndex((g) => g.paths.some((p) => group.paths.includes(p)));
		next = byPath >= 0 ? byPath : index;
	}
	ctx.ui.notify("Edits applied — re-reviewing group", "info");
	return { next };
}

export async function showGroup(
	ctx: ExtensionCommandContext,
	git: Git,
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

export async function showSummary(
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

export async function offerSquash(
	ctx: ExtensionCommandContext,
	git: Git,
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
