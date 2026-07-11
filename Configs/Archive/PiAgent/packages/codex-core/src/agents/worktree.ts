/**
 * Optional git-worktree isolation for subagents (Claude Code's
 * `isolation: worktree`). A worktree gives the agent its own checkout so
 * parallel edits never collide with the user's working tree.
 *
 * Safety: on close we remove the worktree ONLY if it has no changes. A dirty
 * worktree is kept and its path reported — we never discard an agent's work,
 * and we never touch the parent working tree.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";

export interface Worktree {
	dir: string;
	remove: () => Promise<{ removed: boolean; keptReason?: string }>;
}

/**
 * Create a detached worktree at a temp path branched from HEAD.
 * Returns null (with a reason) if cwd is not a git repo or creation fails —
 * the caller falls back to running in cwd.
 */
export async function createWorktree(pi: ExtensionAPI, cwd: string, nickname: string): Promise<{ wt?: Worktree; reason?: string }> {
	const inRepo = await pi.exec("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
	if (inRepo.code !== 0) return { reason: "not inside a git repository" };

	// Unique temp dir; keep the nickname for readability.
	const base = path.join(os.tmpdir(), "pi-agents");
	const dir = path.join(base, `agent-${nickname}-${process.pid}-${counter()}`);
	const add = await pi.exec("git", ["-C", cwd, "worktree", "add", "--detach", dir, "HEAD"]);
	if (add.code !== 0) return { reason: `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}` };

	const remove = async () => {
		const status = await pi.exec("git", ["-C", dir, "status", "--porcelain"]);
		if (status.stdout.trim().length > 0) {
			return { removed: false, keptReason: "worktree has uncommitted changes; kept for review" };
		}
		// --force is safe here: we just confirmed the tree is clean.
		const rm = await pi.exec("git", ["-C", cwd, "worktree", "remove", "--force", dir]);
		return { removed: rm.code === 0, keptReason: rm.code === 0 ? undefined : rm.stderr.trim() };
	};

	return { wt: { dir, remove } };
}

let _n = 0;
function counter(): number {
	return _n++;
}

/**
 * Startup sweep: remove stale `agent-*` worktrees from previous crashed runs
 * that have no changes. Never removes a dirty one. Best-effort.
 */
export async function sweepStaleWorktrees(pi: ExtensionAPI, cwd: string): Promise<number> {
	const list = await pi.exec("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
	if (list.code !== 0) return 0;
	let removed = 0;
	const dirs = list.stdout
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length).trim())
		.filter((d) => path.basename(d).startsWith("agent-"));
	for (const dir of dirs) {
		const status = await pi.exec("git", ["-C", dir, "status", "--porcelain"]);
		if (status.code === 0 && status.stdout.trim().length === 0) {
			const rm = await pi.exec("git", ["-C", cwd, "worktree", "remove", "--force", dir]);
			if (rm.code === 0) removed++;
		}
	}
	return removed;
}
