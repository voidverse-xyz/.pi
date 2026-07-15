/**
 * tools/main-agent.ts — the subagent_* tools the MAIN agent's LLM sees
 * (intent-grouped, D16). Phase 2: subagent_spawn, subagent_status. Others
 * (send/steer/collect/interrupt/retire/await) are added in later phases.
 *
 * Tools talk ONLY to the core facade.
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentsCore } from "../core.ts";
import type { Lifetime } from "../store/registry.ts";

type GetCore = (ctx: ExtensionContext) => SubagentsCore;

function jsonResult(value: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: undefined };
}

function errorResult(error: unknown): { content: [{ type: "text"; text: string }]; details: undefined; isError: true } {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

const SpawnParams = Type.Object({
	type: Type.String({ description: "Type name (a <type>.md in ~/.pi/agent/subagents or <project>/.pi/subagents)." }),
	id: Type.Optional(
		Type.String({ description: "Instance id / purview slug (e.g. 'auth'). Defaults to 'main'. Persistent only — omit for oneshots." }),
	),
	lifetime: Type.Optional(
		Type.Union([Type.Literal("persistent"), Type.Literal("oneshot")], {
			description: "persistent (default): named, durable memory. oneshot: disposable, auto-named, auto-retires after its final report.",
		}),
	),
	task: Type.Optional(Type.String({ description: "Optional first task — spawn and assign in one call. Runs asynchronously." })),
	background: Type.Optional(Type.Boolean({ description: "Reserved for the completion barrier (Phase 7); currently all tasks are background." })),
});

export function createSpawnTool(getCore: GetCore): ToolDefinition<typeof SpawnParams> {
	return {
		name: "subagent_spawn",
		label: "Spawn subagent",
		description:
			"Spawn or wake a persistent subagent at address <type>/<id>. Get-or-create: if the address " +
			"already exists it wakes with memory intact (created:false). An optional task runs asynchronously; " +
			"observe progress with subagent_status.",
		parameters: SpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				const result = await core.spawn({
					type: params.type,
					...(params.id !== undefined ? { id: params.id } : {}),
					...(params.lifetime !== undefined ? { lifetime: params.lifetime as Lifetime } : {}),
					...(params.task !== undefined ? { task: params.task } : {}),
					...(params.background !== undefined ? { background: params.background } : {}),
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
						: "\nNo subagent types found — author one as <project>/.pi/subagents/<type>.md or ~/.pi/agent/subagents/<type>.md.";
				return errorResult(new Error(`${message}${hint}`));
			}
		},
	};
}

const SendParams = Type.Object({
	to: Type.String({ description: "Recipient subagent address <type>/<id>." }),
	text: Type.String(),
	correlationId: Type.Optional(Type.String({ description: "Set to answer a subagent's question (the question envelope's id)." })),
	background: Type.Optional(Type.Boolean({ description: "Reserved for the completion barrier (Phase 7)." })),
});

export function createSendTool(getCore: GetCore): ToolDefinition<typeof SendParams> {
	return {
		name: "subagent_send",
		label: "Message a subagent",
		description:
			"Send mail to a subagent (or answer its question with correlationId). Never interrupts a running turn — " +
			"delivered at the recipient's turn boundary, or it wakes a dormant agent.",
		parameters: SendParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				const result = await core.send({
					to: params.to,
					text: params.text,
					...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
					...(params.background !== undefined ? { background: params.background } : {}),
				});
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
		description: "Inject guidance into a subagent's CURRENT turn (main-agent-only). No-op if it isn't running; use subagent_send otherwise.",
		parameters: SteerParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return jsonResult(await getCore(ctx).steer(params.to, params.text));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const CollectParams = Type.Object({
	to: Type.String({ description: "The subagent to collect a structured result from." }),
	schema: Type.Any({ description: "JSON-schema subset (type/properties/required/items/enum/const/additionalProperties:false) the result must conform to." }),
});

export function createCollectTool(getCore: GetCore): ToolDefinition<typeof CollectParams> {
	return {
		name: "subagent_collect",
		label: "Collect result",
		description:
			"Ask a subagent for a schema-conforming structured result. Non-blocking: the agent delivers it later as a report " +
			"whose data is validated against the schema. Only a restricted JSON-schema subset is honored.",
		parameters: CollectParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				return jsonResult(await getCore(ctx).collect(params.to, params.schema));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const StatusParams = Type.Object({
	address: Type.Optional(Type.String({ description: "A <type>/<id> to inspect in detail. Omit for the full roster." })),
	tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "With address: number of trailing transcript entries (default 20)." })),
});

export function createStatusTool(getCore: GetCore): ToolDefinition<typeof StatusParams> {
	return {
		name: "subagent_status",
		label: "Subagent status",
		description:
			"Inspect subagents. With no address: the full roster (address, state, vitals). With an address: " +
			"detail plus the last transcript entries (read-only; never perturbs the agent).",
		parameters: StatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				if (params.address !== undefined) {
					const detail = await core.peek(params.address, params.tail ?? 20);
					if (!detail) return errorResult(new Error(`No such subagent ${JSON.stringify(params.address)}.`));
					return jsonResult(detail);
				}
				const roster = await core.status();
				return jsonResult({ agents: roster, count: roster.length });
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}
