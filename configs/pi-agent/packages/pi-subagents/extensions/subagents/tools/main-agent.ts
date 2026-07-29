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
		Type.String({ description: "Type name (a <type>.md in ~/.pi/agent/subagents or <project>/.pi/subagents). Mutually exclusive with prompt." }),
	),
	prompt: Type.Optional(
		Type.String({ description: "Ad-hoc role prose — spawns a one-off agent with no def file (address adhoc/<id>). Mutually exclusive with type." }),
	),
	id: Type.Optional(
		Type.String({ description: "Instance id (e.g. 'auth'). Typed persistent defaults to 'main'; REQUIRED for persistent ad-hoc; omit for oneshots." }),
	),
	label: Type.String({
		minLength: 1,
		maxLength: MAX_LABEL_CHARS,
		description: "Short task-specific display name shown in the subagent widget instead of its internal address (for example: 'auth review').",
	}),
	lifetime: Type.Optional(
		Type.Union([Type.Literal("persistent"), Type.Literal("oneshot")], {
			description:
				"persistent: named, durable memory, accepts follow-ups, survives resume. oneshot: disposable, auto-named, auto-retires after its final report (transcript kept). Defaults: typed→persistent, ad-hoc→oneshot. Prefer persistent for long or underspecified tasks — an early return with questions then costs one follow-up send, not a restart.",
		}),
	),
	task: Type.Optional(Type.String({ description: "Optional first task — spawn and assign in one call. Runs in the background; the returned taskEnvelopeId is the subagent_await anchor." })),
	model: Type.Optional(Type.String({ description: "Ad-hoc only: model override (provider/modelId). Typed agents set model in frontmatter." })),
	thinking: Type.Optional(
		Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), { description: "Ad-hoc only: thinking level override." }),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: "Ad-hoc only: coding-tool allowlist from read/bash/edit/write/grep/find/ls (default: all)." }),
	),
});
type SpawnInput = Static<typeof SpawnParams>;

export function createSpawnTool(getCore: GetCore): ToolDefinition<typeof SpawnParams> {
	return {
		name: "subagent_spawn",
		label: "Spawn subagent",
		description:
			"Spawn a background subagent — from a type def (type) or an inline role prompt (prompt). Non-blocking: it works " +
			"while you continue; join results with subagent_await, or end your turn and finished agents wake you with their " +
			"reports. Always provide a short task-specific label for the user-facing widget. Get-or-create for persistent " +
			"addresses: an existing <type>/<id> wakes with memory intact (created:false). Subagents cannot spawn other agents " +
			"or message each other — you are the sole coordinator.",
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
	to: Type.String({ description: "Recipient subagent address <type>/<id>." }),
	text: Type.String({ description: "The task or follow-up. Its envelopeId in the result is the await anchor." }),
});

export function createSendTool(getCore: GetCore): ToolDefinition<typeof SendParams> {
	return {
		name: "subagent_send",
		label: "Message a subagent",
		description:
			"Send a task or follow-up to a subagent. Never interrupts a running turn — delivered at the recipient's turn " +
			"boundary, or it wakes a dormant agent. The returned envelopeId is the subagent_await anchor for this assignment.",
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
	to: Type.String({ description: "The running subagent to steer." }),
	text: Type.String({ description: "Guidance injected mid-turn to redirect current work." }),
});

export function createSteerTool(getCore: GetCore): ToolDefinition<typeof SteerParams> {
	return {
		name: "subagent_steer",
		label: "Steer subagent",
		description: "Inject guidance into a subagent's CURRENT turn. No-op if it isn't running; use subagent_send otherwise.",
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
				to: Type.String({ description: "Subagent address <type>/<id>." }),
				anchorId: Type.String({ description: "The taskEnvelopeId from subagent_spawn / envelopeId from subagent_send." }),
			}),
			{ description: "Specific assignments to wait for. OMIT to wait on every open task." },
		),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("all"), Type.Literal("any")], {
			description: "all (default): wait for every target. any: return as soon as one target resolves.",
		}),
	),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900, description: "Max seconds to wait (default 300). On timeout you get whatever finished plus the still-pending list." })),
});

export function createAwaitTool(getCore: GetCore): ToolDefinition<typeof AwaitParams> {
	return {
		name: "subagent_await",
		label: "Await subagent results",
		description:
			"Block until subagents deliver their final reports — one, several, or (with no targets) every open task. " +
			"mode:any returns on the first result; mode:all waits for everything. Terminal outcomes per target: completed " +
			"(final report), error (the agent's turn failed), or retired. On timeout, partial results are returned and the " +
			"rest stay pending. Alternative to awaiting: just end your turn — finished agents wake you with their reports.",
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

const CancelParams = Type.Object({ to: Type.String({ description: "The running subagent to cancel." }) });

export function createCancelTool(getCore: GetCore): ToolDefinition<typeof CancelParams> {
	return {
		name: "subagent_cancel",
		label: "Cancel subagent turn",
		description:
			"Abort a subagent's current turn. Non-destructive: it stays alive with memory intact and goes dormant; its " +
			"triggering mail stays pending, so a later subagent_send resumes it. Retire a oneshot you cancelled and won't resume.",
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

const RetireParams = Type.Object({ to: Type.String({ description: "The subagent to retire (<type>/<id>)." }) });

export function createRetireTool(getCore: GetCore): ToolDefinition<typeof RetireParams> {
	return {
		name: "subagent_retire",
		label: "Retire subagent",
		description:
			"Permanently retire a subagent: deregister it and archive its transcript. The ONLY destructive action — the address " +
			"bounces afterward. Use for finished persistent agents; oneshots retire themselves after their final report.",
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
	address: Type.Optional(Type.String({ description: "A <type>/<id> to inspect in detail. Omit for the full roster + open tasks." })),
	tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "With address: number of trailing transcript entries (default 20)." })),
});

export function createStatusTool(getCore: GetCore): ToolDefinition<typeof StatusParams> {
	return {
		name: "subagent_status",
		label: "Subagent status",
		description:
			"Inspect subagents. With no address: the owning-session scope fingerprint, full roster (address, state, vitals), " +
			"and open task anchors. With an address: detail plus the last transcript entries (read-only; never perturbs the agent).",
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
