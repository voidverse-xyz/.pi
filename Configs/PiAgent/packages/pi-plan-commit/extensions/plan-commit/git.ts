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

		const status = await exec(["status", "--porcelain"]);
		for (const line of status.stdout.split("\n")) {
			if (!line.trim()) continue;
			const path = line.slice(3).trim();
			if (path) paths.add(normalizePath(path));
		}

		const cached = await exec(["diff", "--cached", "--name-only"]);
		for (const line of cached.stdout.split("\n")) {
			if (line.trim()) paths.add(normalizePath(line.trim()));
		}

		const untracked = await exec(["ls-files", "--others", "--exclude-standard"]);
		for (const line of untracked.stdout.split("\n")) {
			if (line.trim()) paths.add(normalizePath(line.trim()));
		}

		return [...paths];
	}

	async function diffForPaths(paths: string[]): Promise<string> {
		if (paths.length === 0) return "";

		const chunks: string[] = [];
		// Default hunk context (3 lines) — changes only, not whole files

		// All changes vs HEAD (staged + unstaged)
		const hasHead = (await exec(["rev-parse", "--verify", "HEAD"])).code === 0;
		if (hasHead) {
			const vsHead = await exec(["diff", "HEAD", "--", ...paths]);
			if (vsHead.stdout.trim()) chunks.push(vsHead.stdout.trimEnd());
		}

		// Untracked files
		for (const path of paths) {
			const { code } = await exec(["ls-files", "--error-unmatch", path]);
			if (code !== 0) {
				const isWindows = process.platform === "win32";
				const nullPath = isWindows ? "NUL" : "/dev/null";
				const newFile = await exec(["diff", "--no-index", nullPath, path]);
				if (newFile.stdout.trim()) {
					chunks.push(newFile.stdout.trimEnd());
				}
			}
		}

		// No commits yet — fall back to index + working tree
		if (chunks.length === 0) {
			const modified = await exec(["diff", "--", ...paths]);
			if (modified.stdout.trim()) chunks.push(modified.stdout.trimEnd());

			const staged = await exec(["diff", "--cached", "--", ...paths]);
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

	async function commitAll(message: string): Promise<string | null> {
		const commit = await exec(["commit", "--no-verify", "-m", message]);
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
