import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const STATUS_KEY = "git-status";
const ICON_GIT_BRANCH = "";
const ICON_WORKTREE = "";
const ICON_DIRTY = "";
const ICON_CONFLICT = "";
const ICON_OP = ""; // nf-oct-git_merge — an in-progress history operation
const ICON_AHEAD = ""; // nf-fa-upload — local commits available to push
const ICON_BEHIND = ""; // nf-fa-download — remote commits available to pull
const ICON_STASH = ""; // nf-fa-archive
const POLL_MS = 15_000;
const GIT_TIMEOUT_MS = 5_000;
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

interface Layout {
	gitDir: string;
	repoName: string | null;
	worktree: string | null;
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

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const { stdout, code } = await pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
	if (code !== 0) throw new Error(`git ${args[0] ?? ""} exited with code ${code}`);
	return stdout;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

const resolveLayout = (() => {
	// Cache successful layouts only. A negative cache would hide a repository created
	// after Pi starts until the session is reloaded.
	let layoutCache: { cwd: string; layout: Layout } | undefined;

	return async function resolveLayout(pi: ExtensionAPI, cwd: string): Promise<Layout | null> {
		if (layoutCache?.cwd === cwd) return layoutCache.layout;
		try {
			const out = await git(pi, cwd, [
				"rev-parse",
				"--path-format=absolute",
				"--show-toplevel",
				"--git-common-dir",
				"--absolute-git-dir",
			]);
			const [toplevel, commonDir, gitDir] = out.trim().split("\n");
			if (!toplevel || !commonDir || !gitDir) return null;
			const isLinked = gitDir !== commonDir;
			const mainRoot = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
			const layout: Layout = {
				gitDir,
				repoName: isLinked ? basename(mainRoot) : basename(toplevel),
				worktree: isLinked ? basename(toplevel) : null,
			};
			layoutCache = { cwd, layout };
			return layout;
		} catch {
			return null;
		}
	};
})();

function detectOperation(gitDir: string): { operation: string | null; branch: string | null } {
	if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
		let branch: string | null = null;
		for (const rel of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
			const path = join(gitDir, rel);
			if (!existsSync(path)) continue;
			try {
				branch = basename(readFileSync(path, "utf8").trim());
			} catch {
				// Fall back to the branch reported by status.
			}
			break;
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
	if (header.startsWith("No commits yet on ")) return header.slice("No commits yet on ".length).trim();
	if (header.startsWith("HEAD (no branch)")) return "detached";
	const end = header.search(/\.\.\.|\s\[/);
	return (end === -1 ? header : header.slice(0, end)).trim();
}

async function countStashes(pi: ExtensionAPI, cwd: string): Promise<number> {
	try {
		const out = await git(pi, cwd, ["stash", "list"]);
		return out.split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

async function readGitState(pi: ExtensionAPI, cwd: string): Promise<GitState | null> {
	const layout = await resolveLayout(pi, cwd);
	if (!layout) return null;

	let status: string;
	try {
		status = await git(pi, cwd, ["status", "--porcelain", "--branch"]);
	} catch {
		return null;
	}

	const lines = status.split("\n");
	const headerLine = lines[0] ?? "";
	if (!headerLine.startsWith("## ")) return null;
	const header = headerLine.slice(3);
	const aheadMatch = header.match(/ahead (\d+)/);
	const behindMatch = header.match(/behind (\d+)/);

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
		stashes: await countStashes(pi, cwd),
	};
}

function renderGit(state: GitState): string {
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
	return parts.join(" ");
}

function renderStatus(ctx: ExtensionContext, state: GitState | null): string {
	const dir = formatCwd(ctx.sessionManager.getCwd());
	return state ? `${dir} | ${renderGit(state)}` : dir;
}

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let refresh: (() => void) | undefined;
	let generation = 0;

	pi.on("turn_end", () => refresh?.());

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (pollTimer) clearInterval(pollTimer);
		const cwd = ctx.sessionManager.getCwd();
		let state: GitState | null = null;
		ctx.ui.setStatus(STATUS_KEY, renderStatus(ctx, state));

		refresh = () => {
			const request = ++generation;
			void readGitState(pi, cwd).then((next) => {
				if (request !== generation) return;
				state = next;
				ctx.ui.setStatus(STATUS_KEY, renderStatus(ctx, state));
			});
		};
		refresh();
		pollTimer = setInterval(refresh, POLL_MS);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		generation++;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		refresh = undefined;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
