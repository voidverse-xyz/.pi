import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capDisplayLines } from "./display.ts";
import { readTextSnapshot } from "./fs-util.ts";
import { appendCapped, signalProcessTree } from "./proc-util.ts";
import type { FileChange } from "./tracker.ts";

const MAX_STATUS_CHARS = 4 * 1024 * 1024;
const MAX_FILE_DIFF_CHARS = 2 * 1024 * 1024;
const MAX_TOTAL_DIFF_CHARS = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_CURRENT_CHARS = 32 * 1024 * 1024;
const MAX_CHANGED_FILES = 10_000;
const MAX_DISPLAY_LINES = 10_000;
const DIFF_CONCURRENCY = 8;

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	truncated: boolean;
}

export interface GitChangesResult {
	changes: FileChange[];
	warnings: string[];
}

function execGitCapped(cwd: string, args: string[], maxChars: number): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
			cwd,
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		});
		const killChild = () => signalProcessTree(child, "SIGKILL");
		let stdout = "";
		let stderr = "";
		let truncated = false;
		let closed = false;
		const timer = setTimeout(() => {
			if (!closed) killChild();
		}, 60_000);
		timer.unref?.();
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (truncated) return;
			const remaining = maxChars - stdout.length;
			stdout += chunk.slice(0, Math.max(0, remaining));
			if (chunk.length > remaining || stdout.length >= maxChars) {
				truncated = true;
				killChild();
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = appendCapped(stderr, chunk);
		});
		child.on("error", (error) => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			resolve({ stdout, stderr: stderr || error.message, code: 1, truncated });
		});
		child.on("close", (code) => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, code: truncated ? 0 : (code ?? 1), truncated });
		});
	});
}

function literalPath(file: string): string {
	return `:(literal)${file}`;
}

function stateLabel(index: string, worktree: string): string {
	if (index === "?" && worktree === "?") return "untracked";
	if (index === "!" && worktree === "!") return "ignored";
	const conflictPairs = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
	if (conflictPairs.has(`${index}${worktree}`)) return "conflict";
	const staged = index !== " " && index !== "?";
	const unstaged = worktree !== " " && worktree !== "?";
	if (staged && unstaged) return "staged + unstaged";
	if (staged) return "staged";
	if (unstaged) return "unstaged";
	return "changed";
}

function blankGitChange(root: string, rel: string, index: string, worktree: string, remainingChars: number): FileChange {
	const abs = path.join(root, ...rel.split("/"));
	const current = readTextSnapshot(abs, {
		maxBytes: Math.min(MAX_FILE_BYTES, remainingChars),
		capLines: { maxLines: MAX_DISPLAY_LINES, marker: "[File display truncated: line limit reached]" },
		noFollow: true,
		missingOn: "enoent",
	});
	const created = index === "?" || index === "A";
	return {
		abs,
		rel,
		status: !current.exists ? "missing" : created ? "created" : "modified",
		hasBaseline: false,
		editCalls: [],
		writeCalls: 0,
		recordedPatches: [],
		changeCount: 1,
		lastPostHash: null,
		undone: false,
		current: current.text,
		currentExists: current.exists,
		currentUnreadable: current.unreadable,
		source: "git",
		sourceLabel: stateLabel(index, worktree),
		diffOverride: "",
		reviewCwd: root,
	};
}

async function diffForFile(root: string, rel: string, state: string, cap: number): Promise<ExecResult> {
	const common = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
	if (state === "untracked") {
		return execGitCapped(root, [...common, "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", rel], cap);
	}
	if (state === "staged") {
		return execGitCapped(root, [...common, "--cached", "--", literalPath(rel)], cap);
	}
	if (state !== "staged + unstaged" && state !== "staged + untracked") {
		return execGitCapped(root, [...common, "--", literalPath(rel)], cap);
	}

	// Keep layers separate. A final HEAD→worktree diff can be empty when an
	// unstaged edit reverses a staged edit, hiding both.
	const staged = await execGitCapped(root, [...common, "--cached", "--", literalPath(rel)], cap);
	if (staged.truncated || staged.stdout.length >= cap) return staged;
	const second = state === "staged + untracked"
		? await execGitCapped(root, [...common, "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", rel], Math.max(1, cap - staged.stdout.length))
		: await execGitCapped(root, [...common, "--", literalPath(rel)], Math.max(1, cap - staged.stdout.length));
	const sections: string[] = [];
	if (staged.stdout.trim()) sections.push(`# staged (HEAD → index)\n${staged.stdout.trimEnd()}`);
	if (second.stdout.trim()) {
		const label = state === "staged + untracked" ? "untracked working file" : "unstaged (index → working tree)";
		sections.push(`# ${label}\n${second.stdout.trimEnd()}`);
	}
	return {
		stdout: sections.join("\n\n"),
		stderr: staged.stderr || second.stderr,
		code: staged.code !== 0 ? staged.code : second.code > 1 ? second.code : 0,
		truncated: staged.truncated || second.truncated,
	};
}

export async function collectGitChanges(pi: ExtensionAPI, cwd: string): Promise<GitChangesResult> {
	const rootResult = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, timeout: 30_000 });
	if (rootResult.code !== 0 || !rootResult.stdout) throw new Error("Not a Git repository");
	const root = rootResult.stdout.replace(/\r?\n$/, "");
	const status = await execGitCapped(root, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"], MAX_STATUS_CHARS);
	if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
	if (status.truncated) throw new Error("Git status is too large to browse safely");

	const changes: FileChange[] = [];
	const byPath = new Map<string, FileChange>();
	let totalCurrentChars = 0;
	for (const record of status.stdout.split("\0")) {
		if (!record) continue;
		if (record.length < 4 || record[2] !== " ") continue;
		const index = record[0]!;
		const worktree = record[1]!;
		const rawPath = record.slice(3);
		if (rawPath.includes("\uFFFD")) throw new Error("Git contains a path that cannot be decoded safely as UTF-8");
		const rel = process.platform === "win32" ? rawPath.replace(/\\/g, "/") : rawPath;
		if (!rel || index === "!") continue;
		const existing = byPath.get(rel);
		if (existing) {
			const incoming = stateLabel(index, worktree);
			if ((existing.sourceLabel === "staged" && incoming === "untracked") ||
				(existing.sourceLabel === "untracked" && incoming === "staged")) {
				existing.sourceLabel = "staged + untracked";
				existing.status = existing.currentExists ? "modified" : "missing";
			} else {
				existing.sourceLabel = "multiple states";
			}
			continue;
		}
		if (changes.length >= MAX_CHANGED_FILES) throw new Error(`More than ${MAX_CHANGED_FILES} changed files; refusing to build an unsafe snapshot`);
		const change = blankGitChange(root, rel, index, worktree, MAX_TOTAL_CURRENT_CHARS - totalCurrentChars);
		totalCurrentChars += change.current?.length ?? 0;
		byPath.set(rel, change);
		changes.push(change);
	}

	let totalDiffChars = 0;
	let next = 0;
	let diffsOmitted = false;
	const workers = Array.from({ length: Math.min(DIFF_CONCURRENCY, changes.length) }, async () => {
		while (true) {
			const index = next++;
			const change = changes[index];
			if (!change) return;
			const remaining = MAX_TOTAL_DIFF_CHARS - totalDiffChars;
			if (remaining <= 0) {
				change.diffOverride = "[Diff omitted: total Git diff display limit reached]";
				diffsOmitted = true;
				continue;
			}
			const result = await diffForFile(root, change.rel, change.sourceLabel ?? "changed", Math.min(MAX_FILE_DIFF_CHARS, remaining));
			let text = capDisplayLines(
				result.stdout.trimEnd(),
				MAX_DISPLAY_LINES,
				"[Diff truncated: line limit reached]",
			);
			if (!text && change.sourceLabel === "untracked" && result.code <= 1) text = "[Untracked empty file]";
			if (result.truncated) text += "\n\n[Diff truncated]";
			if (result.code !== 0 && !text) text = `[Could not load diff: ${result.stderr.trim() || `git exited ${result.code}`}]`;
			const available = MAX_TOTAL_DIFF_CHARS - totalDiffChars;
			if (available <= 0) {
				change.diffOverride = "[Diff omitted: total Git diff display limit reached]";
				diffsOmitted = true;
			} else if (text.length > available) {
				change.diffOverride = `${text.slice(0, available)}\n[Diff truncated: total display limit reached]`;
				totalDiffChars += change.diffOverride.length;
				diffsOmitted = true;
			} else {
				change.diffOverride = text;
				totalDiffChars += text.length;
			}
		}
	});
	await Promise.all(workers);
	const warnings: string[] = [];
	if (diffsOmitted) {
		warnings.push("Some diffs were omitted after reaching the 32 MiB display limit");
	}
	return { changes, warnings };
}
