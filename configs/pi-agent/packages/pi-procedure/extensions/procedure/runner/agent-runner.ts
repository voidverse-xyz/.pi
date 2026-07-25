/**
 * runner/agent-runner.ts — one agent() call = one in-process AgentSession.
 *
 * Lean call/return lifecycle (no mailboxes, registry, or persistence beyond
 * the per-call JSONL transcript under the run dir):
 *
 *   validate (tools/schema/model — BEFORE taking a slot, so typos fail fast)
 *   → scheduler slot → SessionManager.create + DefaultResourceLoader
 *   → createAgentSession (sandboxed coding tools ± structured_output)
 *   → prompt once, waitForIdle (a 40 ms watcher aborts the session on stop)
 *   → output = captured structured object, or the final assistant text
 *   → dispose, release, clear activity.
 *
 * Session idioms follow pi-subagents runtime/in-process.ts buildHandle/mailTurn.
 * Note pi 0.80.10: createAgentSession ignores modelRegistry/authStorage — the
 * caller resolves Model objects (ctx.modelRegistry) and we pass `model:`.
 */

import { mkdirSync } from "node:fs";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AgentFailure, ProcedureStopped } from "../script/semantics.ts";
import { schemaShapeErrors } from "../schema/validate.ts";
import type { ConfirmFn } from "../sandbox/safety-bridge.ts";
import { buildSandboxedTools, selectToolNames, type SandboxPorts } from "../sandbox/tools-filter.ts";
import { liveThinkingSummary, retainLatestThought, truncateFlat } from "../text.ts";
import { createOutputSlot, createStructuredOutputTool, STRUCTURED_OUTPUT_TOOL } from "./structured-output.ts";
import type { Scheduler } from "./scheduler.ts";

const STOP_POLL_MS = 40;
const MAX_SCHEMA_REPROMPTS = 2;

export interface AgentCall {
	seq: number;
	prompt: string;
	label: string;
	phase: string;
	schema?: unknown;
	model?: string;
	thinking?: string;
	tools?: string[];
}

export interface AgentActivity {
	/** The current tool name, or an empty string while thinking. */
	tool: string;
	/** Current tool detail or the latest provider-visible thinking summary. */
	summary: string;
	/** Tool calls made by this one-shot agent. */
	toolUses: number;
	/** Cumulative input/output/cache tokens at the latest finalized message. */
	tokens: number;
	/** Current context fill from the live session, 0–100; null when unknown. */
	ctxPercent: number | null;
}

export type AgentRunState = "queued" | "running" | "waiting" | "done" | "error" | "cached";

export interface RunnerPorts {
	cwd: string;
	agentDir: string;
	/** The procedure name, for agent addressing in confirmations. */
	procedureName: string;
	/** Session dir for this call's transcript (created if missing). */
	sessionDirFor(seq: number): string;
	scheduler: Scheduler;
	systemDeny: SandboxPorts["systemDeny"];
	systemDenyCommand: SandboxPorts["systemDenyCommand"];
	confirm: ConfirmFn;
	/** The host session's model (inherit default); undefined lets pi pick. */
	defaultModel: CreateAgentSessionOptions["model"];
	/** Model/auth runtime override (tests); default: pi builds one from agentDir. */
	modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
	/** Resolve "provider/id" (or bare id) to a Model; throws on unknown. */
	resolveModel(ref: string): NonNullable<CreateAgentSessionOptions["model"]>;
	onActivity(seq: number, activity: AgentActivity | null): void;
	onState(seq: number, state: AgentRunState): void;
	isStopped(): boolean;
}

export interface AgentRunResult {
	output: unknown;
	elapsedMs: number;
}

function agentAddress(ports: RunnerPorts, call: AgentCall): string {
	return `${ports.procedureName}/${call.label}#${call.seq}`;
}

function composeIdentity(ports: RunnerPorts, call: AgentCall): string[] {
	const lines = [
		`You are "${call.label}", a one-shot worker agent (phase "${call.phase}") spawned by the deterministic procedure "${ports.procedureName}".`,
		"Complete the task in the user prompt in this single turn. Work autonomously — nobody will answer questions.",
	];
	if (call.schema !== undefined) {
		lines.push(
			`You MUST finish by calling the ${STRUCTURED_OUTPUT_TOOL} tool with an \`output\` value matching this JSON schema:`,
			JSON.stringify(call.schema, null, 2),
			"Plain text is NOT accepted as your result.",
		);
	} else {
		lines.push(
			"Your final assistant message IS your entire output — it is returned verbatim to the orchestration script, so return the requested data directly, with no preamble and no questions.",
		);
	}
	return [lines.join("\n")];
}

/** Extract the final assistant text from an agent_end event's messages. */
function finalAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = m.content
			.filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text")
			.map((part) => part.text)
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

/** Validate call options that can fail fast — BEFORE a scheduler slot is taken. */
export function validateAgentCall(call: AgentCall): void {
	if (typeof call.prompt !== "string" || call.prompt.trim() === "") {
		throw new AgentFailure(`agent() call #${call.seq}: prompt must be a non-empty string.`);
	}
	try {
		selectToolNames({ name: call.label, tools: call.tools });
	} catch (error) {
		throw new AgentFailure(error instanceof Error ? error.message : String(error));
	}
	if (call.schema !== undefined) {
		const errors = schemaShapeErrors(call.schema);
		if (errors.length > 0) throw new AgentFailure(`agent() call #${call.seq}: invalid schema — ${errors.join("; ")}`);
	}
}

export async function runAgent(call: AgentCall, ports: RunnerPorts): Promise<AgentRunResult> {
	validateAgentCall(call);
	// resolve the model eagerly too — an unknown model must not burn a slot
	const model = call.model !== undefined ? ports.resolveModel(call.model) : ports.defaultModel;

	ports.onState(call.seq, "queued");
	const release = await ports.scheduler.acquire();
	const started = Date.now();
	let disposeSession: (() => Promise<void> | void) | undefined;
	let stopWatcher: ReturnType<typeof setInterval> | undefined;
	try {
		if (ports.isStopped()) throw new ProcedureStopped();

		const sessionDir = ports.sessionDirFor(call.seq);
		mkdirSync(sessionDir, { recursive: true });
		const sessionManager = SessionManager.create(ports.cwd, sessionDir);

		const loader = new DefaultResourceLoader({
			cwd: ports.cwd,
			agentDir: ports.agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			appendSystemPrompt: composeIdentity(ports, call),
		});
		await loader.reload();

		const slot = createOutputSlot();
		const address = agentAddress(ports, call);
		const customTools: ToolDefinition[] = [
			...buildSandboxedTools({ name: call.label, tools: call.tools }, ports.cwd, {
				systemDeny: ports.systemDeny,
				systemDenyCommand: ports.systemDenyCommand,
				// surface the human-confirmation pause as `waiting` for the widget
				confirm: async (request) => {
					ports.onState(call.seq, "waiting");
					try {
						return await ports.confirm({ agent: address, ...request });
					} finally {
						ports.onState(call.seq, "running");
					}
				},
			}),
			...(call.schema !== undefined ? [createStructuredOutputTool(call.schema, slot)] : []),
		];

		const sessionOptions: CreateAgentSessionOptions = {
			cwd: ports.cwd,
			agentDir: ports.agentDir,
			sessionManager,
			resourceLoader: loader,
			noTools: "builtin",
			customTools,
		};
		if (model) sessionOptions.model = model;
		if (ports.modelRuntime) sessionOptions.modelRuntime = ports.modelRuntime;
		if (call.thinking !== undefined) sessionOptions.thinkingLevel = call.thinking as NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

		const { session } = await createAgentSession(sessionOptions);
		disposeSession = () => session.dispose();

		let failure: { stopReason: string; message: string } | null = null;
		let finalMessages: unknown[] = [];
		let thinkingText = "";
		let latestThought = "";
		let lastThinkingPublish = 0;
		const activeTools = new Map<string, { tool: string; summary: string }>();
		const initialStats = session.getSessionStats();
		let activity: AgentActivity = {
			tool: "",
			summary: "thinking…",
			toolUses: 0,
			tokens: initialStats.tokens.total,
			ctxPercent: initialStats.contextUsage?.percent ?? null,
		};

		const publishActivity = (update: Partial<AgentActivity>): void => {
			activity = { ...activity, ...update };
			ports.onActivity(call.seq, activity);
		};
		ports.onActivity(call.seq, activity);

		const publishThinking = (force = false): void => {
			latestThought = retainLatestThought(latestThought, thinkingText);
			if (activeTools.size > 0) return;
			const now = Date.now();
			if (!force && now - lastThinkingPublish < 120) return;
			lastThinkingPublish = now;
			publishActivity({ tool: "", summary: liveThinkingSummary(latestThought) });
		};

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update") {
				const streamEvent = event.assistantMessageEvent;
				if (streamEvent.type === "thinking_start") {
					thinkingText = "";
					return;
				}
				if (streamEvent.type === "thinking_delta") {
					thinkingText = `${thinkingText}${streamEvent.delta}`.slice(-4096);
					publishThinking();
					return;
				}
				if (streamEvent.type === "thinking_end") {
					thinkingText = streamEvent.content.slice(-4096);
					publishThinking(true);
				}
				return;
			}
			if (event.type === "tool_execution_start") {
				const tool = event.toolName;
				const current = { tool, summary: toolSummary(tool, event.args) };
				activeTools.set(event.toolCallId, current);
				publishActivity({ ...current, toolUses: activity.toolUses + 1 });
				return;
			}
			if (event.type === "tool_execution_end") {
				activeTools.delete(event.toolCallId);
				const current = [...activeTools.values()].at(-1);
				publishActivity(current ?? { tool: "", summary: liveThinkingSummary(latestThought) });
				return;
			}
			// Match the teams/subagents widget: finalized messages are the point where
			// session token totals and context fill become authoritative. Defer one
			// microtask so SessionManager persistence has included the message.
			if (event.type === "message_end") {
				queueMicrotask(() => {
					const stats = session.getSessionStats();
					publishActivity({
						tokens: stats.tokens.total,
						ctxPercent: stats.contextUsage?.percent ?? null,
					});
				});
				return;
			}
			if (event.type !== "agent_end") return;
			const messages = event.messages ?? [];
			finalMessages = messages;
			for (const message of messages) {
				const m = message as { role?: string; stopReason?: string; errorMessage?: string };
				if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
					failure = { stopReason: m.stopReason, message: m.errorMessage ?? "(no error message)" };
				}
			}
		});

		stopWatcher = setInterval(() => {
			if (ports.isStopped()) void session.abort().catch(() => {});
		}, STOP_POLL_MS);
		(stopWatcher as { unref?: () => void }).unref?.();

		try {
			ports.onState(call.seq, "running");
			await session.prompt(call.prompt);
			await session.waitForIdle();

			// schema forcing fallback: the turn ended without a valid structured_output
			let reprompts = 0;
			while (call.schema !== undefined && !slot.set && !failure && !ports.isStopped() && reprompts < MAX_SCHEMA_REPROMPTS) {
				reprompts += 1;
				await session.prompt(
					`You have not delivered your result yet. You MUST call the ${STRUCTURED_OUTPUT_TOOL} tool with an \`output\` value matching the required schema. Plain text is not accepted.`,
				);
				await session.waitForIdle();
			}
		} finally {
			unsubscribe();
		}

		if (ports.isStopped()) throw new ProcedureStopped();
		if (failure) {
			const f = failure as { stopReason: string; message: string };
			if (f.stopReason === "aborted") throw new ProcedureStopped();
			throw new AgentFailure(`agent "${call.label}" (#${call.seq}) failed: ${f.message}`);
		}

		let output: unknown;
		if (call.schema !== undefined) {
			if (!slot.set) throw new AgentFailure(`agent "${call.label}" (#${call.seq}) never produced a valid structured_output matching the schema.`);
			output = slot.value;
		} else {
			output = finalAssistantText(finalMessages);
		}

		ports.onState(call.seq, "done");
		return { output, elapsedMs: Date.now() - started };
	} catch (error) {
		if (!(error instanceof ProcedureStopped)) ports.onState(call.seq, "error");
		throw error;
	} finally {
		if (stopWatcher) clearInterval(stopWatcher);
		ports.onActivity(call.seq, null);
		if (disposeSession) {
			try {
				await disposeSession();
			} catch {
				// disposal is best-effort
			}
		}
		release();
	}
}

/** A short one-line summary of a tool call for the tree widget. */
function toolSummary(tool: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const label = tool.charAt(0).toUpperCase() + tool.slice(1);
	const detail =
		typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : typeof a.pattern === "string" ? a.pattern : "";
	const flat = truncateFlat(detail, 48);
	return flat ? `${label}: ${flat}` : label;
}
