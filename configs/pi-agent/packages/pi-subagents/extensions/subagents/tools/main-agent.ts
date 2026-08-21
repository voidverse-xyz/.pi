/**
 * tools/main-agent.ts — the subagent_* tools the MAIN agent's LLM sees:
 * spawn, send, steer, await, cancel, retire, status.
 *
 * Tools talk ONLY to the core facade.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { SubagentsCore } from "../core.ts";
import { parseAddress } from "../mail/envelope.ts";
import type { Lifetime } from "../store/registry.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../typedefs/parse.ts";
import type { AwaitTarget } from "../runtime/types.ts";
import { labelFromSource, MAX_LABEL_CHARS } from "../text.ts";
import { errorResult, jsonResult } from "./results.ts";

type GetCore = () => SubagentsCore;

/** Compatibility for resumed tool calls stored before `label` became required. */
function fallbackSpawnLabel(raw: Record<string, unknown>): string {
	const source =
		typeof raw.task === "string" ? raw.task :
		typeof raw.prompt === "string" ? raw.prompt.replace(/^You are\s+/i, "") :
		typeof raw.id === "string" ? raw.id :
		typeof raw.type === "string" ? raw.type : "subagent";
	return labelFromSource(source) || "subagent";
}

/** These tools target a subagent instance — `main`/`user`/garbage are rejected up front. */
function agentTargetError(address: string): ReturnType<typeof errorResult> | null {
	if (parseAddress(address)?.kind === "agent") return null;
	return errorResult(new Error(`\`${address}\` is not a subagent address — expected \`<type>/<id>\` (not "main" or "user").`));
}

const SpawnParams = Type.Object({
	type: Type.Optional(
		Type.String({ description: "Type definition name from global or project subagents; exclusive with prompt." }),
	),
	prompt: Type.Optional(
		Type.String({ description: "Ad-hoc role prompt; exclusive with type." }),
	),
	id: Type.Optional(
		Type.String({ description: "Instance id. Required for persistent ad-hoc agents; omit for oneshots. Typed persistent agents default to main." }),
	),
	label: Type.String({
		minLength: 1,
		maxLength: MAX_LABEL_CHARS,
		description: "Required task-specific display label, for example 'auth review'.",
	}),
	lifetime: Type.Optional(
		Type.Union([Type.Literal("persistent"), Type.Literal("oneshot")], {
			description:
				"persistent keeps named memory across follow-ups and resume; oneshot auto-retires after its report. Defaults: typed→persistent, ad-hoc→oneshot.",
		}),
	),
	task: Type.Optional(Type.String({ description: "Initial background task; taskEnvelopeId is its await anchor." })),
	model: Type.Optional(Type.String({ description: "Ad-hoc only: provider/model override." })),
	thinking: Type.Optional(
		Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), { description: "Ad-hoc only: thinking override." }),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: "Ad-hoc only: allowlist of read/bash/edit/write/grep/find/ls; defaults to all." }),
	),
});
type SpawnInput = Static<typeof SpawnParams>;

export function createSpawnTool(getCore: GetCore): ToolDefinition<typeof SpawnParams> {
	return {
		name: "subagent_spawn",
		label: "Spawn subagent",
		description:
			"Spawn a typed or ad-hoc background subagent. Persistent addresses are get-or-create and keep memory; oneshots " +
			"auto-retire. Results arrive asynchronously; await them or keep working. Subagents cannot coordinate with peers.",
		promptGuidelines: [
			"Always give subagent_spawn a concise, task-specific label so the user sees a meaningful name in the subagent widget.",
		],
		parameters: SpawnParams,
		prepareArguments(args): SpawnInput {
			if (!args || typeof args !== "object") return args as SpawnInput;
			const input = args as Record<string, unknown>;
			if (typeof input.label === "string") return args as SpawnInput;
			return { ...input, label: fallbackSpawnLabel(input) } as SpawnInput;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore();
			try {
				const result = await core.spawn({
					...(params.type !== undefined ? { type: params.type } : {}),
					...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
					...(params.id !== undefined ? { id: params.id } : {}),
					label: params.label,
					...(params.lifetime !== undefined ? { lifetime: params.lifetime as Lifetime } : {}),
					...(params.task !== undefined ? { task: params.task } : {}),
					...(params.model !== undefined ? { model: params.model } : {}),
					...(params.thinking !== undefined ? { thinking: params.thinking as ThinkingLevel } : {}),
					...(params.tools !== undefined ? { tools: params.tools } : {}),
					inherit: { ...(ctx.model ? { modelRef: `${ctx.model.provider}/${ctx.model.id}` } : {}) },
				});
				return jsonResult(result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.startsWith("Unknown subagent type")) return errorResult(error);
				const types = core.availableTypes();
				const hint =
					types.length > 0
						? `\nAvailable types:\n${types.map((t) => `- ${t.name} (${t.source}): ${t.invalid ?? t.description}`).join("\n")}`
						: "\nNo subagent types found — author one as <project>/.pi/subagents/<type>.md or ~/.pi/agent/subagents/<type>.md, or spawn ad-hoc with `prompt`.";
				return errorResult(new Error(`${message}${hint}`));
			}
		},
	};
}

const SendParams = Type.Object({
	to: Type.String({ description: "Recipient <type>/<id>." }),
	text: Type.String({ description: "Task or follow-up." }),
});

export function createSendTool(getCore: GetCore): ToolDefinition<typeof SendParams> {
	return {
		name: "subagent_send",
		label: "Message a subagent",
		description:
			"Queue a task or follow-up. It wakes dormant agents but never interrupts a running turn. The returned envelopeId " +
			"is the await anchor.",
		parameters: SendParams,
		async execute(_toolCallId, params) {
			const badTarget = agentTargetError(params.to);
			if (badTarget) return badTarget;
			const core = getCore();
			try {
				const result = await core.send({ to: params.to, text: params.text });
				// A bounce is a failure to deliver — surface it as an error so the LLM
				// doesn't mistake it for successful delivery.
				if (result.disposition === "bounced" || result.disposition === "dropped") {
					return errorResult(new Error(`Message not delivered (${result.disposition}): ${result.bounceReason ?? "unknown reason"}`));
				}
				return jsonResult(result);
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const SteerParams = Type.Object({
	to: Type.String({ description: "Running subagent address." }),
	text: Type.String({ description: "Mid-turn guidance." }),
});

export function createSteerTool(getCore: GetCore): ToolDefinition<typeof SteerParams> {
	return {
		name: "subagent_steer",
		label: "Steer subagent",
		description: "Guide a running turn immediately; no-op if idle. Use subagent_send otherwise.",
		parameters: SteerParams,
		async execute(_toolCallId, params) {
			const badTarget = agentTargetError(params.to);
			if (badTarget) return badTarget;
			try {
				return jsonResult(await getCore().steer(params.to, params.text));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const AwaitParams = Type.Object({
	targets: Type.Optional(
		Type.Array(
			Type.Object({
				to: Type.String({ description: "Subagent <type>/<id>." }),
				anchorId: Type.String({ description: "taskEnvelopeId from spawn or envelopeId from send." }),
			}),
			{ description: "Assignments to wait for; omit to wait on all open tasks." },
		),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("all"), Type.Literal("any")], {
			description: "all (default) waits for every target; any returns the first result.",
		}),
	),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900, description: "Wait limit in seconds (default 300)." })),
});

export function createAwaitTool(getCore: GetCore): ToolDefinition<typeof AwaitParams> {
	return {
		name: "subagent_await",
		label: "Await subagent results",
		description:
			"Wait for selected assignments or, without targets, all open tasks. Outcomes are completed, error, or retired. " +
			"Timeouts return finished outcomes and leave the rest pending.",
		parameters: AwaitParams,
		async execute(_toolCallId, params, signal) {
			const core = getCore();
			try {
				let targets: AwaitTarget[];
				if (params.targets !== undefined && params.targets.length > 0) {
					for (const target of params.targets) {
						const badTarget = agentTargetError(target.to);
						if (badTarget) return badTarget;
					}
					targets = params.targets;
				} else {
					targets = core.openTasks().map((task) => ({ to: task.to, anchorId: task.anchorId }));
					if (targets.length === 0) {
						return jsonResult({ status: "empty", outcomes: [], pending: [], note: "No open tasks — nothing to await." });
					}
				}
				const result = await core.awaitResults({
					targets,
					mode: params.mode ?? "all",
					...(params.timeoutSeconds !== undefined ? { timeoutSeconds: params.timeoutSeconds } : {}),
					...(signal ? { signal } : {}),
				});
				return jsonResult(result);
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const CancelParams = Type.Object({ to: Type.String({ description: "Running subagent address." }) });

export function createCancelTool(getCore: GetCore): ToolDefinition<typeof CancelParams> {
	return {
		name: "subagent_cancel",
		label: "Cancel subagent turn",
		description:
			"Stop the current turn without retiring the agent; pending mail can resume later. Retire a cancelled oneshot " +
			"you will not reuse.",
		parameters: CancelParams,
		async execute(_toolCallId, params) {
			const badTarget = agentTargetError(params.to);
			if (badTarget) return badTarget;
			try {
				return jsonResult(await getCore().cancel(params.to));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const RetireParams = Type.Object({ to: Type.String({ description: "Subagent <type>/<id>." }) });

export function createRetireTool(getCore: GetCore): ToolDefinition<typeof RetireParams> {
	return {
		name: "subagent_retire",
		label: "Retire subagent",
		description:
			"Permanently remove an address and archive its transcript. Use only for finished persistent agents; oneshots " +
			"retire automatically.",
		parameters: RetireParams,
		async execute(_toolCallId, params) {
			const badTarget = agentTargetError(params.to);
			if (badTarget) return badTarget;
			try {
				return jsonResult(await getCore().retire(params.to));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const StatusParams = Type.Object({
	address: Type.Optional(Type.String({ description: "Agent to inspect; omit for the roster and open tasks." })),
	tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "Transcript entries to include (default 20)." })),
});

export function createStatusTool(getCore: GetCore): ToolDefinition<typeof StatusParams> {
	return {
		name: "subagent_status",
		label: "Subagent status",
		description:
			"Inspect the owning-session roster and open tasks, or one agent with a read-only transcript tail.",
		parameters: StatusParams,
		async execute(_toolCallId, params) {
			const core = getCore();
			try {
				if (params.address !== undefined) {
					const detail = await core.peek(params.address, params.tail ?? 20);
					if (!detail) return errorResult(new Error(`No such subagent ${JSON.stringify(params.address)}.`));
					return jsonResult(detail);
				}
				const roster = await core.status();
				return jsonResult({ ownerScopeId: core.ownerScopeId, agents: roster, count: roster.length, openTasks: core.openTasks() });
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}
