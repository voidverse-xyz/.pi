/**
 * Directory + Git + Model widget, above the input editor.
 *
 * Renders one row directly above the main input:
 *   <cwd>  <branch-icon> repo (branch) …git state…        <model> · <thinking>
 *
 * The directory (home-relative) and git segment are pinned left; the model id
 * (+ thinking level, if not off) is pinned to the right edge, width-aware (dir +
 * git truncate first on a narrow terminal). This owns the whole row because
 * widgets can't share a line, and the model is drawn here instead of the footer
 * (status-line no longer renders it). All dim.
 *
 * Git segment is compact by default — just `<branch-icon> repo (branch)`. Every
 * other indicator appears only when it applies:
 *   - linked worktree name                         <fork> name
 *   - in-progress operation (rebase/merge/…)       ⇋ rebase
 *   - merge conflicts (unmerged paths)             <warn> (N)
 *   - uncommitted changes (working tree dirty)     <pencil> (N)
 *   - unpushed local commits (ahead of upstream)   ↑ (N)
 *   - incoming commits (behind upstream)           ↓ (N)
 *   - stash entries                                ⊟ (N)
 *
 * Ahead/behind are computed from the local tracking ref, so "behind" reflects
 * the last `git fetch`, not a live remote check — this extension never fetches
 * on its own (no surprise network/side effects).
 *
 * Rendered via `ctx.ui.setWidget(..., { placement: "aboveEditor" })`, so it sits
 * on its own row just above where you type — not in the footer. The status-line
 * footer intentionally no longer draws cwd or git.
 *
 * Requires a Nerd Font for the branch/worktree/dirty/conflict glyphs.
 *
 * Install: ~/.pi/agent/extensions/dir-git/index.ts
 * Reload: /reload
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WIDGET_KEY = "dir-git";
const ICON_GIT_BRANCH = ""; // nf-oct-git_branch (U+F418)
const ICON_WORKTREE = ""; // nf-fa-code_fork (U+F126)
const ICON_DIRTY = ""; // nf-fa-pencil (U+F040)
const ICON_CONFLICT = ""; // nf-fa-exclamation_triangle (U+F071)
const ICON_OP = "⇋";
const ICON_AHEAD = "↑";
const ICON_BEHIND = "↓";
const ICON_STASH = "⊟";
const POLL_MS = 15 * 1000;
const GIT_TIMEOUT_MS = 5_000;

// Porcelain v1 XY codes that mark an unmerged (conflicted) path.
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

interface Layout {
	gitDir: string; // worktree-specific git dir (where in-progress op state lives)
	repoName: string | null;
	worktree: string | null; // linked-worktree name, null on the main worktree
}

interface GitState {
	repoName: string | null;
	branch: string;
	worktree: string | null;
	operation: string | null;
	conflicts: number;
	dirty: number;
	ahead: number;
	behind: number;
	stashes: number;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
	return stdout;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

// Repo layout (paths, name, worktree) is stable for a given cwd, so cache it
// instead of resolving it on every poll.
let layoutCache: { cwd: string; layout: Layout | null } | undefined;

async function resolveLayout(cwd: string): Promise<Layout | null> {
	if (layoutCache?.cwd === cwd) return layoutCache.layout;

	let layout: Layout | null = null;
	try {
		// Output order matches the flag order: toplevel, common dir, git dir.
		const out = await git(cwd, [
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-common-dir",
			"--absolute-git-dir",
		]);
		const [toplevel, commonDir, gitDir] = out.trim().split("\n");
		if (toplevel && commonDir && gitDir) {
			const isLinked = gitDir !== commonDir;
			// commonDir is `<root>/.git`; its parent basename is the real repo name,
			// stable across the repo's linked worktrees.
			const mainRoot = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
			layout = {
				gitDir,
				repoName: isLinked ? basename(mainRoot) : basename(toplevel),
				worktree: isLinked ? basename(toplevel) : null,
			};
		}
	} catch {
		layout = null;
	}

	layoutCache = { cwd, layout };
	return layout;
}

// Detect an in-progress operation from marker files git writes into the git dir
// (the same signals shell git prompts use). Rebase also yields the branch being
// rebased, which is friendlier than the detached-HEAD that status reports.
function detectOperation(gitDir: string): { operation: string | null; branch: string | null } {
	if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
		let branch: string | null = null;
		for (const rel of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
			const path = join(gitDir, rel);
			if (existsSync(path)) {
				try {
					branch = basename(readFileSync(path, "utf8").trim());
				} catch {
					// unreadable head-name — fall back to status's branch
				}
				break;
			}
		}
		return { operation: "rebase", branch };
	}
	if (existsSync(join(gitDir, "MERGE_HEAD"))) return { operation: "merge", branch: null };
	if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return { operation: "cherry-pick", branch: null };
	if (existsSync(join(gitDir, "REVERT_HEAD"))) return { operation: "revert", branch: null };
	if (existsSync(join(gitDir, "BISECT_LOG"))) return { operation: "bisect", branch: null };
	return { operation: null, branch: null };
}

function parseBranch(header: string): string {
	// header is the porcelain `## ...` line with the leading "## " stripped.
	if (header.startsWith("No commits yet on ")) {
		return header.slice("No commits yet on ".length).trim();
	}
	if (header.startsWith("HEAD (no branch)")) return "detached";
	// Branch name runs until the upstream marker `...` or the ` [ahead/behind]` block.
	const end = header.search(/\.\.\.|\s\[/);
	return (end === -1 ? header : header.slice(0, end)).trim();
}

async function countStashes(cwd: string): Promise<number> {
	try {
		const out = await git(cwd, ["stash", "list"]);
		return out.split("\n").filter((line) => line.length > 0).length;
	} catch {
		return 0;
	}
}

async function readGitState(cwd: string): Promise<GitState | null> {
	const layout = await resolveLayout(cwd);
	if (!layout) return null;

	let status: string;
	try {
		// One call yields branch, upstream ahead/behind, and every changed path.
		status = await git(cwd, ["status", "--porcelain", "--branch"]);
	} catch {
		return null; // not a repo, or git unavailable
	}

	const lines = status.split("\n");
	const headerLine = lines[0] ?? "";
	if (!headerLine.startsWith("## ")) return null;
	const header = headerLine.slice(3);

	const aheadMatch = header.match(/ahead (\d+)/);
	const behindMatch = header.match(/behind (\d+)/);

	// Split changed paths into conflicts (unmerged) vs everything else (dirty).
	let conflicts = 0;
	let dirty = 0;
	for (const line of lines.slice(1)) {
		if (line.length < 2) continue;
		if (CONFLICT_CODES.has(line.slice(0, 2))) conflicts++;
		else dirty++;
	}

	const { operation, branch: opBranch } = detectOperation(layout.gitDir);

	return {
		repoName: layout.repoName,
		branch: opBranch ?? parseBranch(header),
		worktree: layout.worktree,
		operation,
		conflicts,
		dirty,
		ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
		behind: behindMatch ? Number(behindMatch[1]) : 0,
		stashes: await countStashes(cwd),
	};
}

function renderGit(state: GitState, theme: ExtensionContext["ui"]["theme"]): string {
	const base = state.repoName
		? `${ICON_GIT_BRANCH} ${state.repoName} (${state.branch})`
		: `${ICON_GIT_BRANCH} ${state.branch}`;

	const parts = [base];
	if (state.worktree) parts.push(`${ICON_WORKTREE} ${state.worktree}`);
	if (state.operation) parts.push(`${ICON_OP} ${state.operation}`);
	if (state.conflicts > 0) parts.push(`${ICON_CONFLICT} (${state.conflicts})`);
	if (state.dirty > 0) parts.push(`${ICON_DIRTY} (${state.dirty})`);
	if (state.ahead > 0) parts.push(`${ICON_AHEAD} (${state.ahead})`);
	if (state.behind > 0) parts.push(`${ICON_BEHIND} (${state.behind})`);
	if (state.stashes > 0) parts.push(`${ICON_STASH} (${state.stashes})`);

	// Everything dim — icons carry the meaning.
	return theme.fg("dim", parts.join(" "));
}

function formatModel(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const modelId = ctx.model?.id ?? "no-model";
	const thinking = pi.getThinkingLevel();
	const text = thinking === "off" ? modelId : `${modelId} · ${thinking}`;
	return ctx.ui.theme.fg("dim", text);
}

// Left side of the row: directory, then (if in a repo) the git segment.
function renderLeft(ctx: ExtensionContext, state: GitState | null): string {
	const theme = ctx.ui.theme;
	const dir = theme.fg("dim", formatCwd(ctx.sessionManager.getCwd()));
	const gitSegment = state ? renderGit(state, theme) : "";
	return gitSegment ? `${dir}  ${gitSegment}` : dir;
}

// Renders `left ...gap... right` across the full width, ANSI-aware. Truncates the
// left (dir + git) first when both don't fit, so the model on the right stays put.
function renderSplitLine(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width);
	if (!left) return `${" ".repeat(width - rightWidth)}${right}`;
	const gap = width - visibleWidth(left) - rightWidth;
	if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;
	const truncatedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
	return `${truncatedLeft} ${right}`;
}

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let refresh: (() => void) | undefined;
	let rerender: (() => void) | undefined;
	let resink: (() => void) | undefined;

	// Registered once at module scope (not inside session_start) so repeated
	// session_start firings — e.g. session switch/resume within one process —
	// never accumulate duplicate listeners. Model/thinking sit on the right of
	// this row, so changing them only needs a re-render (no git re-read).
	pi.on("turn_end", () => refresh?.());
	pi.on("model_select", () => rerender?.());
	pi.on("thinking_level_select", () => rerender?.());
	// Re-register our above-editor widget when a run starts. Above-editor widgets
	// render in map-insertion order and re-setting a key moves it to the bottom;
	// re-asserting here (before the agent can be steered) keeps this status row
	// *below* any other extension's set-once widget — e.g. steer-queue's pending
	// message — so that sits directly above it rather than under it.
	pi.on("agent_start", () => resink?.());

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (pollTimer) clearInterval(pollTimer);

		let state: GitState | null = null;
		let tui: TUI | undefined;

		// Component (not static string[]) so the model can be pinned to the right,
		// width-aware: dir + git on the left, model + thinking on the right.
		const widgetFactory = (t: TUI) => {
			tui = t;
			return {
				invalidate() {},
				dispose() {
					if (tui === t) tui = undefined;
				},
				render(width: number): string[] {
					return [renderSplitLine(renderLeft(ctx, state), formatModel(pi, ctx), width)];
				},
			};
		};
		ctx.ui.setWidget(WIDGET_KEY, widgetFactory, { placement: "aboveEditor" });

		rerender = () => tui?.requestRender();
		// Re-setting the same key re-inserts it at the bottom of the above-editor
		// stack (content is unchanged, so no visible flicker) — see agent_start above.
		resink = () => {
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, widgetFactory, { placement: "aboveEditor" });
		};

		refresh = () => {
			readGitState(ctx.sessionManager.getCwd())
				.then((s) => {
					state = s;
					rerender?.();
				})
				.catch(() => {
					state = null; // still show the directory + model even if git errors
					rerender?.();
				});
		};

		refresh();
		pollTimer = setInterval(refresh, POLL_MS);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		refresh = undefined;
		rerender = undefined;
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
	});
}
