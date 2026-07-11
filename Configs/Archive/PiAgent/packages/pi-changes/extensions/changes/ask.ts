/**
 * The two "ask about this file" routes.
 *
 *  - Main agent: a message injected into the current session via sendUserMessage
 *    (keeps full context; the agent answers in the normal chat).
 *  - Fresh subagent: an isolated child `pi` process, restricted to read-only tools,
 *    whose answer streams into an AnswerState the panel renders live.
 *
 * The subagent spawn/parse/kill loop is adapted from the pi-subagents package
 * (delegate.ts + runner.ts) — trimmed to a single anonymous read-only agent, with
 * no agent discovery, depth policy, or ask_parent machinery.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type FileChange, fileDiffText } from "./tracker.ts";

const DIFF_CAP = 24 * 1024;

/** Re-invoke the current `pi` binary/script (handles bun single-file builds). */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function capDiff(diff: string): string {
	if (diff.length <= DIFF_CAP) return diff;
	return `${diff.slice(0, DIFF_CAP)}\n… [diff truncated: ${diff.length - DIFF_CAP} more bytes]`;
}

/** Message routed to the main agent (keeps session context). */
export function buildMainAgentMessage(fc: FileChange, question: string): string {
	return [
		`[changes] Question about \`${fc.rel}\` — a file you changed this session:`,
		"",
		question.trim(),
		"",
		"Answer the question about this file only. Do not modify any files.",
	].join("\n");
}

/** Task text for the isolated subagent (it sees nothing else). */
function buildSubagentTask(fc: FileChange, question: string): string {
	const diff = capDiff(fileDiffText(fc).trim());
	const parts = [
		"You are reviewing a single file that another agent changed this session.",
		"",
		`File: ${fc.rel}`,
		`Status: ${fc.status}`,
	];
	if (diff) {
		parts.push("", "--- Unified diff of the changes to this file ---", diff, "--- end diff ---");
	}
	parts.push(
		"",
		`Question: ${question.trim()}`,
		"",
		"Answer concisely. You may read files in the working directory (read/grep/find/ls) to inform your answer. Do not attempt to modify anything.",
	);
	return parts.join("\n");
}

export interface AnswerState {
	status: "running" | "done" | "error";
	text: string;
	usageLine: string;
	error?: string;
	rel: string;
	/** Panel wires this to tui.requestRender(); called on every stream update. */
	onRender?: () => void;
	kill(): void;
}

function formatUsage(u: { input: number; output: number; cost: number }): string {
	const parts: string[] = [];
	if (u.input) parts.push(`↑${u.input}`);
	if (u.output) parts.push(`↓${u.output}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	return parts.join(" ");
}

/** Spawn an isolated read-only subagent and stream its answer into an AnswerState. */
export function spawnSubagentAnswer(cwd: string, fc: FileChange, question: string): AnswerState {
	const state: AnswerState = {
		status: "running",
		text: "",
		usageLine: "",
		rel: fc.rel,
		kill() {},
	};

	const task = buildSubagentTask(fc, question);
	const inv = getPiInvocation([
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--tools",
		"read,grep,find,ls",
		`Task: ${task}`,
	]);

	let proc: ChildProcess;
	try {
		proc = spawn(inv.command, inv.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe", "ignore"],
		});
	} catch (e) {
		state.status = "error";
		state.error = String(e);
		return state;
	}

	let killed = false;
	state.kill = () => {
		if (killed) return;
		killed = true;
		try {
			proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				if (!proc.killed) proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 3000);
	};

	const usage = { input: 0, output: 0, cost: 0 };
	let stderr = "";
	let buffer = "";

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let ev: { type?: string; message?: Record<string, unknown> };
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		if (ev.type !== "message_end" || !ev.message) return;
		const msg = ev.message as {
			role?: string;
			content?: Array<{ type: string; text?: string }>;
			usage?: { input?: number; output?: number; cost?: { total?: number } };
		};
		if (msg.role !== "assistant") return;
		for (const part of msg.content ?? []) {
			if (part.type === "text" && part.text) {
				state.text += (state.text ? "\n" : "") + part.text;
			}
		}
		const u = msg.usage;
		if (u) {
			usage.input += u.input ?? 0;
			usage.output += u.output ?? 0;
			usage.cost += u.cost?.total ?? 0;
		}
		state.usageLine = formatUsage(usage);
		state.onRender?.();
	};

	proc.stdout?.on("data", (d: Buffer) => {
		buffer += d.toString();
		const ls = buffer.split("\n");
		buffer = ls.pop() ?? "";
		for (const l of ls) processLine(l);
	});
	proc.stderr?.on("data", (d: Buffer) => {
		stderr += d.toString();
	});
	proc.on("close", (code) => {
		if (buffer.trim()) processLine(buffer);
		if (!killed && code && code !== 0 && !state.text) {
			state.status = "error";
			state.error = stderr.trim() || `subagent exited with code ${code}`;
		} else {
			state.status = "done";
			if (!state.text && !killed) state.text = "(no answer)";
		}
		state.usageLine = formatUsage(usage);
		state.onRender?.();
	});
	proc.on("error", (e) => {
		state.status = "error";
		state.error = String(e);
		state.onRender?.();
	});

	return state;
}
