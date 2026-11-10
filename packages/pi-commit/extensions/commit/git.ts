import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface GitOptions {
	/** Pass --no-verify to git commit (skips hooks). Defaults to false. */
	noVerify?: boolean;
}

export function createGit(pi: ExtensionAPI, cwd: string, opts?: GitOptions) {
	const noVerify = opts?.noVerify ?? false;

	async function exec(args: string[]): Promise<ExecResult> {
		return pi.exec("git", args, { cwd, timeout: 60_000 });
	}

	function commitArgs(message: string): string[] {
		return ["commit", ...(noVerify ? ["--no-verify"] : []), "-m", message];
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
		if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
		for (const entry of status.stdout.split("\0")) {
			if (!entry) continue;
			const path = entry.slice(3); // 2-char status + separator, then the exact path
			if (path) paths.add(normalizePath(path));
		}

		const cached = await exec(["diff", "--cached", "--name-only", "-z"]);
		if (cached.code !== 0) throw new Error(cached.stderr.trim() || "git diff --cached failed");
		for (const entry of cached.stdout.split("\0")) {
			if (entry) paths.add(normalizePath(entry));
		}

		const untracked = await exec(["ls-files", "--others", "--exclude-standard", "-z"]);
		if (untracked.code !== 0) throw new Error(untracked.stderr.trim() || "git ls-files failed");
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
		let used = 0;
		const runDiff = (args: string[]) => execGitCapped(cwd, args, Math.max(1, MAX_DIFF_CHARS - used));
		const append = (text: string): boolean => {
			if (!text.trim() || used >= MAX_DIFF_CHARS) return used < MAX_DIFF_CHARS;
			const value = text.trimEnd().slice(0, MAX_DIFF_CHARS - used);
			chunks.push(value);
			used += value.length;
			return used < MAX_DIFF_CHARS;
		};

		// All changes vs HEAD (staged + unstaged)
		const hasHead = (await exec(["rev-parse", "--verify", "HEAD"])).code === 0;
		if (hasHead) {
			const vsHead = await runDiff(["diff", ...ctxArgs, "HEAD", "--", ...literalPaths(paths)]);
			append(vsHead.stdout);
		}

		// Untracked files (--no-index already emits the whole file as additions)
		for (const path of paths) {
			if (used >= MAX_DIFF_CHARS) break;
			const { code } = await exec(["ls-files", "--error-unmatch", "--", ...literalPaths([path])]);
			if (code !== 0) {
				const nullPath = process.platform === "win32" ? "NUL" : "/dev/null";
				const newFile = await runDiff(["diff", ...ctxArgs, "--no-index", "--", nullPath, path]);
				append(newFile.stdout);
			}
		}

		// No commits yet — fall back to index + working tree
		if (chunks.length === 0) {
			const modified = await runDiff(["diff", ...ctxArgs, "--", ...literalPaths(paths)]);
			append(modified.stdout);
			if (used < MAX_DIFF_CHARS) {
				const staged = await runDiff(["diff", ...ctxArgs, "--cached", "--", ...literalPaths(paths)]);
				append(staged.stdout);
			}
		}

		return used >= MAX_DIFF_CHARS
			? `${chunks.join("\n\n")}\n\n[diff truncated at ${MAX_DIFF_CHARS} characters]`
			: chunks.join("\n\n");
	}

	async function stageAndCommit(paths: string[], message: string): Promise<string | null> {
		const indexResult = await exec(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
		const indexPath = indexResult.code === 0 ? indexResult.stdout.trim() : "";
		let indexBefore: Buffer | null = null;
		if (indexPath) {
			try {
				indexBefore = await readFile(indexPath);
			} catch {
				// An unborn repository may not have an index yet.
			}
		}
		const restoreIndex = async () => {
			if (!indexPath) return;
			if (indexBefore) await writeFile(indexPath, indexBefore);
			else await unlink(indexPath).catch(() => undefined);
		};

		const pathspecInput = `${paths.join("\0")}\0`;
		const add = await execGitCapped(
			cwd,
			["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"],
			1024 * 1024,
			pathspecInput,
			10 * 60_000,
		);
		if (add.code !== 0) {
			await restoreIndex();
			return null;
		}
		const commit = await execGitCapped(
			cwd,
			["--literal-pathspecs", ...commitArgs(message), "--pathspec-from-file=-", "--pathspec-file-nul"],
			1024 * 1024,
			pathspecInput,
			10 * 60_000,
		);
		if (commit.code !== 0) {
			await restoreIndex();
			return null;
		}

		const sha = await exec(["rev-parse", "HEAD"]);
		return sha.stdout.trim() || null;
	}

	async function pathsHaveChanges(paths: string[]): Promise<boolean> {
		if (paths.length === 0) return false;
		const result = await exec(["status", "--porcelain", "--", ...literalPaths(paths)]);
		return result.code !== 0 || result.stdout.trim().length > 0;
	}

	async function canSquash(shas: string[]): Promise<boolean> {
		if (shas.length === 0) return false;
		const history = await exec(["rev-list", "--first-parent", `--max-count=${shas.length}`, "HEAD"]);
		if (history.code !== 0) return false;
		const actual = history.stdout.trim().split("\n").filter(Boolean);
		return actual.join("\n") === [...shas].reverse().join("\n");
	}

	async function parentOf(sha: string): Promise<string | null> {
		const result = await exec(["rev-parse", `${sha}^`]);
		return result.code === 0 ? result.stdout.trim() || null : null;
	}

	async function softResetTo(ref: string): Promise<boolean> {
		const { code } = await exec(["reset", "--soft", ref]);
		return code === 0;
	}

	return {
		exec,
		isRepo,
		changedPaths,
		diffForPaths,
		stageAndCommit,
		pathsHaveChanges,
		canSquash,
		parentOf,
		softResetTo,
	};
}

const MAX_DIFF_CHARS = 2 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

function execGitCapped(
	cwd: string,
	args: string[],
	maxChars: number,
	stdin?: string,
	timeoutMs = 60_000,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
		let stdout = "";
		let stderr = "";
		let capped = false;
		let closed = false;
		const timer = setTimeout(() => {
			if (!closed) child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref?.();
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdin.on("error", () => undefined);
		child.stdin.end(stdin);
		child.stdout.on("data", (chunk: string) => {
			if (capped) return;
			const remaining = maxChars - stdout.length;
			stdout += chunk.slice(0, Math.max(0, remaining));
			if (chunk.length > remaining || stdout.length >= maxChars) {
				capped = true;
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
		});
		child.on("error", (error) => {
			closed = true;
			clearTimeout(timer);
			resolve({ stdout, stderr: stderr || error.message, code: 1 });
		});
		child.on("close", (code) => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, code: capped ? 0 : (code ?? 1) });
		});
	});
}

function literalPaths(paths: string[]): string[] {
	return paths.map((path) => `:(literal)${path}`);
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}
