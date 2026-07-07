/**
 * Delegation tool — the LLM-callable `subagent` tool.
 *
 * Spawns a separate `pi` process for each subagent invocation, giving it an
 * isolated context window. The *parent* agent passes everything the child needs
 * through the `task` string (and optional `cwd`), so a delegating agent can hand
 * off full context — the child starts fresh with only the agent's system prompt
 * plus that task.
 *
 * Modes:
 *   - Single:   { agent, task }
 *   - Parallel: { tasks: [{ agent, task }, ...] }   (max 8, 4 concurrent)
 *   - Chain:    { chain: [{ agent, task }, ...] }    (sequential, {previous} placeholder)
 *
 * Adapted from Pi's bundled `subagent` example (MIT), refactored to a named
 * export so index.ts can register it alongside the foreground switcher.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, discoverContextFiles, discoverSkillPaths } from "./agents.ts";
import { ASK_PARENT_ENV, canCallSpec, childEnv, currentDepth, resolveAskLimit, resolveMaxDepth, targetAllowedByCall } from "./depth.ts";
import { type HubSession, hubFromCtx, isPersistenceEnabled, resolvePersistentSessionFile, withAgentLock } from "./persistence.ts";
import { getPiInvocation, writePromptToTempFile } from "./runner.ts";

// The fd the child reaches its parent on for headless confirm / ask_user. The actual
// transport lives in the standalone `ipc` extension; here we only spawn with the pipe and
// hand it off over `pi.events` (channel "ipc:attach"), so delegate has no ipc import — and
// no import of command-safety / user-inputs either. If `ipc` isn't installed the child
// still runs; it just can't reach the parent (safety blocks, ask_user errors).
const PI_IPC_FD_ENV = "PI_IPC_FD";
function hasParentChannel(): boolean {
	return Boolean(process.env[PI_IPC_FD_ENV]);
}

// ask_parent budget: how many times each agent (by name) has paused to ask its parent
// this user request. delegate.ts grants ask_parent to a spawned child only while its
// count is below the agent's frontmatter `askLimit`; a re-run past the cap spawns
// without the tool. Reset each turn (see registerSubagentTool). Module scope so it spans
// every subagent call within the process; a headless parent's map dies with its one run.
const askCounts = new Map<string, number>();

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
// When a task's output overflows the cap, keep the head AND the tail rather than
// head-only: agents put their summary/conclusion (## Summary, ## Start Here, ## Completed)
// at the end, so a head-only cut drops exactly the part the parent most needs.
const TRUNCATED_TAIL_BYTES = 15 * 1024;
const TRUNCATED_HEAD_BYTES = PER_TASK_OUTPUT_CAP - TRUNCATED_TAIL_BYTES;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/**
	 * Set when the agent called ask_parent to pause and ask its parent a question
	 * (see ask-parent.ts). Captured from the tool call in the child's output
	 * stream; the run is stopped and this — not the agent's final text — is surfaced.
	 */
	paused?: { summary: string; question: string };
	/**
	 * Absolute paths of the context files (AGENTS.md / CLAUDE.md) the child actually loaded,
	 * discovered from its effective cwd. Recorded so a per-task `cwd` that pulls in different
	 * project instructions than the parent is visible rather than silent.
	 */
	contextFiles?: string[];
	/**
	 * True when this run used a per-task `cwd` whose context-file set differs from the parent's
	 * — i.e. the subagent ran under different project instructions. Surfaced with a ⚠ note.
	 */
	contextDiverged?: boolean;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	// A paused agent stopped on purpose (it called ask_parent) — not a failure, even
	// though stopping it mid-turn leaves a non-zero exit / aborted stop reason.
	if (result.paused) return false;
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/** Formats a paused agent's question + progress for the parent LLM to read and act on. */
function formatPausedResult(r: SingleResult): string {
	const p = r.paused!;
	// Tailor the escalation hint to who reads this. A top-level parent owns the TUI and
	// ask_user but has no parent of its own; a nested parent (itself a subagent) can
	// escalate further with ask_parent. Never name a tool the reader doesn't have.
	const escalation = hasParentChannel()
		? " — or, if you're also unsure, escalate with ask_parent to your own parent (or ask_user, if you have it) before answering"
		: " — or, if you're also unsure, ask the human with ask_user before answering";
	return [
		`⏸ Subagent "${r.agent}" paused and is asking you a question before it continues.`,
		"",
		"QUESTION:",
		p.question || "(none given)",
		"",
		`PROGRESS SO FAR (from ${r.agent}):`,
		p.summary || "(none given)",
		"",
		`Answer the question using the broader context you have${escalation}. Then continue the work: delegate a ` +
			`continuation (to "${r.agent}", another agent, or by doing it yourself), passing along the original ` +
			"goal, the progress summary above, the question, and your answer. The continuation starts fresh, so " +
			"include everything it needs.",
	].join("\n");
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

// Clamp a string to at most maxBytes UTF-8 bytes, taken from the start or the end.
// The coarse char-slice first bounds the trim loop; the loop then removes whole chars
// (never splitting a multi-byte sequence) until under the byte budget.
function clampBytes(s: string, maxBytes: number, from: "start" | "end"): string {
	if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
	let out = from === "start" ? s.slice(0, maxBytes) : s.slice(-maxBytes);
	while (Buffer.byteLength(out, "utf8") > maxBytes) {
		out = from === "start" ? out.slice(0, -1) : out.slice(1);
	}
	return out;
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	const head = clampBytes(output, TRUNCATED_HEAD_BYTES, "start");
	const tail = clampBytes(output, TRUNCATED_TAIL_BYTES, "end");
	const omitted = byteLength - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
	return `${head}\n\n[... ${omitted} bytes omitted from the middle; head + tail shown. Full output preserved in tool details. ...]\n\n${tail}`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Abbreviate an absolute path under $HOME to a leading ~ for display. */
function homeRelative(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Equal as sets; both inputs are sorted absolute-path lists from discoverContextFiles. */
function sameStringSet(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A short, home-relative one-line summary of a context-file divergence, for the ⚠ note. */
function describeContextDivergence(agent: string, childFiles: string[], parentFiles: string[]): string {
	const fmt = (files: string[]) => (files.length ? files.map(homeRelative).join(", ") : "(none)");
	return (
		`⚠ subagent "${agent}" ran under a different project context (per-task cwd): ` +
		`loaded ${fmt(childFiles)}; parent uses ${fmt(parentFiles)}.`
	);
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	maxDepth: number,
	defaultAskLimit: number,
	pi: ExtensionAPI,
	parentContextFiles: string[],
	// Non-null ⇒ run this agent in its persistent, reusable session (single mode only).
	// Null ⇒ ephemeral `--no-session` (the default, and always for parallel/chain).
	hub: HubSession | null,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// ask_parent budget: the agent's own frontmatter `askLimit` wins; otherwise the
	// user-configurable default (/agents asklimit). Allowed only while this agent's ask
	// count is under that limit (see ask-parent.ts). Limit 0 ⇒ never granted.
	const askLimit = agent.askLimit ?? defaultAskLimit;
	const askAllowed = askLimit > 0 && (askCounts.get(agentName) ?? 0) < askLimit;

	// Persistence: with a hub, resolve this agent's own reusable session and resume it
	// (`--session <file>`), so the agent keeps its prior context across calls. Without a
	// hub, run ephemeral (`--no-session`). Falls back to ephemeral if resolution fails.
	let persistentSessionFile: string | undefined;
	if (hub) {
		try {
			persistentSessionFile = (await resolvePersistentSessionFile(hub, agentName)).file;
		} catch {
			persistentSessionFile = undefined;
		}
	}

	const args: string[] = ["--mode", "json", "-p", ...(persistentSessionFile ? ["--session", persistentSessionFile] : ["--no-session"])];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) {
		// A restrictive `tools:` allowlist would hide ask_parent; add it back only when the
		// agent may ask this run. Full-tools agents (no list) rely on the env gate below to
		// (de)register it, so they need no list surgery.
		const tools = askAllowed && !agent.tools.includes("ask_parent") ? [...agent.tools, "ask_parent"] : agent.tools;
		args.push("--tools", tools.join(","));
	}
	// `skills:` (frontmatter) scopes the child's skill catalog. "none" ⇒ --no-skills (skip
	// the whole auto-discovered catalog). A name list ⇒ --no-skills plus --skill for each
	// named skill's resolved path, so the child loads only those. Omitting inherits the catalog.
	if (agent.skills === "none") {
		args.push("--no-skills");
	} else if (Array.isArray(agent.skills)) {
		args.push("--no-skills");
		if (agent.skills.length > 0) {
			const skillPaths = discoverSkillPaths(cwd ?? defaultCwd);
			for (const name of agent.skills) {
				const resolved = skillPaths.get(name);
				if (resolved) args.push("--skill", resolved);
			}
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	// Which AGENTS.md/CLAUDE.md the child will load. When no per-task cwd is given it runs in
	// the parent's cwd, so its set == parentContextFiles (reuse, don't re-walk). A per-task cwd
	// can pull in a different set — flag that so it's visible rather than silent (see #3).
	const contextFiles = cwd === undefined ? parentContextFiles : discoverContextFiles(cwd);
	const contextDiverged = cwd !== undefined && !sameStringSet(contextFiles, parentContextFiles);

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
		contextFiles,
		contextDiverged,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				// fd 3 is a dedicated bidirectional pipe for the parent↔subagent IPC channel
				// (served by the `ipc` extension) — kept off stdout so control traffic never
				// mixes with pi's JSON.
				stdio: ["ignore", "pipe", "pipe", "pipe"],
				// Carry the nesting depth (+1), the cap, and this child's call-list down
				// so it can enforce the same limits — it runs --no-session and can't
				// read entries. PI_IPC_FD tells the child which fd to reach the parent on when
				// a headless capability (safety confirm, ask_user) needs the TUI.
				env: {
					...childEnv(maxDepth, canCallSpec(agent), defaultAskLimit),
					[PI_IPC_FD_ENV]: "3",
					// Register ask_parent in the child only when the agent opted in and has budget.
					...(askAllowed ? { [ASK_PARENT_ENV]: "1" } : {}),
				},
			});

			// Hand the child's control pipe to the `ipc` extension (if installed) over
			// pi.events; it serves the child's confirm / ask_user requests on the parent's
			// TUI, or forwards them further up. childName = agentName labels the asker chain.
			// No listener (ipc not installed) ⇒ the child simply can't reach us.
			const control = proc.stdio[3] as Duplex | null | undefined;
			if (control) pi.events.emit("ipc:attach", { stream: control, childName: agentName });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);
					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;

						// Detect a pause: the agent called ask_parent to ask its parent a question
						// (see ask-parent.ts). Capture {summary, question} from the tool-call
						// arguments and stop the child now — we surface the pause instead of its final
						// text and let the parent LLM answer when this tool call returns.
						if (!currentResult.paused) {
							for (const part of msg.content) {
								if (part.type === "toolCall" && part.name === "ask_parent") {
									const a = (part.arguments ?? {}) as { summary?: unknown; question?: unknown };
									currentResult.paused = {
										summary: typeof a.summary === "string" ? a.summary : "",
										question: typeof a.question === "string" ? a.question : "",
									};
									// Spend one unit of this agent's ask budget so its next re-run this
									// request is spawned without ask_parent once the limit is reached.
									askCounts.set(agentName, (askCounts.get(agentName) ?? 0) + 1);
									proc.kill("SIGTERM");
									setTimeout(() => {
										if (!proc.killed) proc.kill("SIGKILL");
									}, 3000);
									break;
								}
							}
						}
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent (include all context it needs)" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior step output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode); include all context it needs" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export function registerSubagentTool(pi: ExtensionAPI): void {
	// ask_parent budgets refill each user request: a fresh request lets subagents ask again.
	pi.on("turn_start", () => askCounts.clear());

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate a task to a specialized subagent that runs in its own isolated context window.",
			"The subagent starts fresh and only sees the `task` string you give it, so include ALL context it needs.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To include project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptSnippet: "delegate — hand a self-contained task to a specialized agent with an isolated context window",
		promptGuidelines: [
			"Use delegate to offload a self-contained task (recon, planning, review, a focused implementation) so it does not consume the main context window.",
			"The child cannot see this conversation — put every file path, requirement, and constraint it needs into `task`.",
			"Use `chain` when a later step needs an earlier step's output ({previous}); use `tasks` for independent work to run in parallel.",
			"When session subagent-persistence is enabled (the user sets it via /agents), delegating to the SAME agent again resumes its earlier session — it remembers its prior work, so give follow-ups to that same agent instead of re-explaining. Persistence applies to single-agent delegation; parallel/chain always start fresh.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			// Nesting-depth policy. depth 0 = the top-level interactive session.
			const depth = currentDepth();
			const maxDepth = resolveMaxDepth();
			// Default ask_parent allowance for agents that don't set their own askLimit.
			const defaultAskLimit = resolveAskLimit();
			// The context files this (parent) process runs under — computed once and compared
			// against each child's set to flag a per-task cwd that diverges (see #3 / runSingleAgent).
			const parentContextFiles = discoverContextFiles(ctx.cwd);
			// A ⚠ prefix for a result whose child loaded different context files than the parent,
			// so the divergence rides along in the text the parent LLM reads (not just the UI).
			const contextNote = (r: SingleResult): string =>
				r.contextDiverged ? `${describeContextDivergence(r.agent, r.contextFiles ?? [], parentContextFiles)}\n\n` : "";

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` },
					],
					details: makeDetails("single")([]),
				};
			}

			const currentMode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			// Depth cap: a process at depth d may spawn a subagent only if d < maxDepth.
			if (depth >= maxDepth) {
				return {
					content: [
						{
							type: "text",
							text: `Subagent depth limit (${maxDepth}) reached — this agent can't spawn further subagents.`,
						},
					],
					details: makeDetails(currentMode)([]),
					isError: true,
				};
			}

			// Privilege: a nested caller may only delegate to agents on its canDelegateTo list.
			// The top-level session is exempt (unrestricted).
			if (depth > 0) {
				const requested = new Set<string>();
				if (params.chain) for (const s of params.chain) requested.add(s.agent);
				if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
				if (params.agent) requested.add(params.agent);
				for (const name of requested) {
					if (!targetAllowedByCall(name)) {
						return {
							content: [
								{
									type: "text",
									text: `Nested subagent may not delegate to "${name}" — not in its canDelegateTo list.`,
								},
							],
							details: makeDetails(currentMode)([]),
							isError: true,
						};
					}
				}
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									onUpdate({ content: partial.content, details: makeDetails("chain")([...results, currentResult]) });
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						maxDepth,
						defaultAskLimit,
						pi,
						parentContextFiles,
						null, // chain steps run ephemeral (fan-through pipeline, not a durable collaborator)
					);
					results.push(result);

					if (result.paused) {
						// The step paused to ask a question — the chain can't mechanically continue.
						// Hand the question to the parent; it answers and drives the rest itself.
						return {
							content: [
								{ type: "text", text: `Chain paused at step ${i + 1} (${step.agent}).\n\n${formatPausedResult(result)}` },
							],
							details: makeDetails("chain")(results),
						};
					}
					if (isFailedResult(result)) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				// Any step that ran under a diverging per-task cwd gets its ⚠ note surfaced up front.
				const chainNotes = results.map((r) => contextNote(r)).join("");
				return {
					content: [
						{ type: "text", text: chainNotes + (getFinalOutput(results[results.length - 1].messages) || "(no output)") },
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						maxDepth,
						defaultAskLimit,
						pi,
						parentContextFiles,
						null, // parallel tasks run ephemeral (independent fan-out, and avoids same-agent write races)
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const pausedCount = results.filter((r) => r.paused).length;
				const successCount = results.filter((r) => !r.paused && !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					if (r.paused) return `### [${r.agent}] paused (asking a question)\n\n${formatPausedResult(r)}`;
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${contextNote(r)}${output}`;
				});
				const divergedCount = results.filter((r) => r.contextDiverged).length;
				const header =
					`Parallel: ${successCount}/${results.length} succeeded` +
					(pausedCount ? `, ${pausedCount} paused (awaiting your answer)` : "") +
					(divergedCount ? `, ${divergedCount} under a different project context (⚠)` : "");
				return {
					content: [{ type: "text", text: `${header}\n\n${summaries.join("\n\n---\n\n")}` }],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				// Single-mode delegation honors session persistence: with it on, run this agent in
				// its own reusable session (resumes prior context), serialized per agent so two
				// concurrent same-agent calls can't race on the file.
				const hub = isPersistenceEnabled() ? hubFromCtx(ctx) : null;
				const runSingle = (h: HubSession | null) =>
					runSingleAgent(
						ctx.cwd,
						agents,
						params.agent!,
						params.task!,
						params.cwd,
						undefined,
						signal,
						onUpdate,
						makeDetails("single"),
						maxDepth,
						defaultAskLimit,
						pi,
						parentContextFiles,
						h,
					);
				const result = hub ? await withAgentLock(hub, params.agent!, () => runSingle(hub)) : await runSingle(null);
				if (result.paused) {
					return {
						content: [{ type: "text", text: formatPausedResult(result) }],
						details: makeDetails("single")([result]),
					};
				}
				if (isFailedResult(result)) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: contextNote(result) + (getFinalOutput(result.messages) || "(no output)") }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("delegate ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = r.paused
					? theme.fg("warning", "⏸")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (r.contextDiverged) header += ` ${theme.fg("warning", "⚠ different project context")}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					if (r.contextFiles && r.contextFiles.length > 0) {
						const shown = r.contextFiles.map(homeRelative).join(", ");
						const color = r.contextDiverged ? "warning" : "dim";
						container.addChild(new Text(theme.fg(color, `context: ${shown}`), 0, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (r.contextDiverged) text += ` ${theme.fg("warning", "⚠ different project context")}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
				let text =
					`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}` +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.paused
						? theme.fg("warning", "⏸")
						: r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}${r.contextDiverged ? ` ${theme.fg("warning", "⚠")}` : ""}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, expanded ? undefined : 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.paused
								? theme.fg("warning", "⏸")
								: isFailedResult(r)
									? theme.fg("error", "✗")
									: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}${r.contextDiverged ? ` ${theme.fg("warning", "⚠")}` : ""}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, expanded ? undefined : 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
