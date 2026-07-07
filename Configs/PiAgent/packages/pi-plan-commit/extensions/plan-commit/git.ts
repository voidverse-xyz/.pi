import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export function createGit(pi: ExtensionAPI, cwd: string) {
	async function exec(args: string[]): Promise<ExecResult> {
		return pi.exec("git", args, { cwd, timeout: 60_000 });
	}

	async function isRepo(): Promise<boolean> {
		const { code } = await exec(["rev-parse", "--is-inside-work-tree"]);
		return code === 0;
	}

	async function changedPaths(): Promise<string[]> {
		const paths = new Set<string>();

		// -z gives NUL-delimited, exact paths: no core.quotepath escaping of
		// non-ASCII names and no leading/trailing whitespace mangling. --no-renames
		// avoids the "old -> new" arrow form that would otherwise be parsed as a
		// single bogus path and break `git add`/`git commit -- <path>`.
		const status = await exec(["status", "--porcelain", "--no-renames", "-z"]);
		for (const entry of status.stdout.split("\0")) {
			if (!entry) continue;
			const path = entry.slice(3); // 2-char status + separator, then the exact path
			if (path) paths.add(normalizePath(path));
		}

		const cached = await exec(["diff", "--cached", "--name-only", "-z"]);
		for (const entry of cached.stdout.split("\0")) {
			if (entry) paths.add(normalizePath(entry));
		}

		const untracked = await exec(["ls-files", "--others", "--exclude-standard", "-z"]);
		for (const entry of untracked.stdout.split("\0")) {
			if (entry) paths.add(normalizePath(entry));
		}

		return [...paths];
	}

	// `full` renders the entire file with the changes highlighted (git's full-context
	// diff, `-U<huge>`) instead of just the changed hunks with 3 lines of context.
	async function diffForPaths(paths: string[], opts?: { full?: boolean }): Promise<string> {
		if (paths.length === 0) return "";

		// A context window large enough to swallow any real source file, so every
		// line of the file appears in the unified diff around the changes.
		const ctxArgs = opts?.full ? ["--unified=1000000"] : [];

		const chunks: string[] = [];

		// All changes vs HEAD (staged + unstaged)
		const hasHead = (await exec(["rev-parse", "--verify", "HEAD"])).code === 0;
		if (hasHead) {
			const vsHead = await exec(["diff", ...ctxArgs, "HEAD", "--", ...paths]);
			if (vsHead.stdout.trim()) chunks.push(vsHead.stdout.trimEnd());
		}

		// Untracked files (--no-index already emits the whole file as additions)
		for (const path of paths) {
			const { code } = await exec(["ls-files", "--error-unmatch", path]);
			if (code !== 0) {
				const isWindows = process.platform === "win32";
				const nullPath = isWindows ? "NUL" : "/dev/null";
				const newFile = await exec(["diff", ...ctxArgs, "--no-index", nullPath, path]);
				if (newFile.stdout.trim()) {
					chunks.push(newFile.stdout.trimEnd());
				}
			}
		}

		// No commits yet — fall back to index + working tree
		if (chunks.length === 0) {
			const modified = await exec(["diff", ...ctxArgs, "--", ...paths]);
			if (modified.stdout.trim()) chunks.push(modified.stdout.trimEnd());

			const staged = await exec(["diff", ...ctxArgs, "--cached", "--", ...paths]);
			if (staged.stdout.trim()) chunks.push(staged.stdout.trimEnd());
		}

		return chunks.join("\n\n");
	}

	async function stageAndCommit(paths: string[], message: string): Promise<string | null> {
		const add = await exec(["add", "--", ...paths]);
		if (add.code !== 0) return null;

		const commit = await exec(["commit", "--no-verify", "-m", message, "--", ...paths]);
		if (commit.code !== 0) return null;

		const sha = await exec(["rev-parse", "--short", "HEAD"]);
		return sha.stdout.trim() || null;
	}

	async function softReset(count: number): Promise<boolean> {
		const { code } = await exec(["reset", "--soft", `HEAD~${count}`]);
		return code === 0;
	}

	async function readWorkingFile(path: string): Promise<string | null> {
		try {
			return await readFile(join(cwd, path), "utf8");
		} catch {
			return null;
		}
	}

	// Commit only the given paths from the index. Used after a soft reset to squash
	// the session's own commits — scoping to `paths` avoids sweeping in any files the
	// user had staged before /git-commit ran (a plain `git commit` would grab those).
	async function commitAll(message: string, paths: string[]): Promise<string | null> {
		const args = ["commit", "--no-verify", "-m", message];
		if (paths.length > 0) args.push("--", ...paths);
		const commit = await exec(args);
		if (commit.code !== 0) return null;
		const sha = await exec(["rev-parse", "--short", "HEAD"]);
		return sha.stdout.trim() || null;
	}

	return {
		exec,
		isRepo,
		changedPaths,
		diffForPaths,
		readWorkingFile,
		stageAndCommit,
		softReset,
		commitAll,
	};
}

export type Git = ReturnType<typeof createGit>;

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}
