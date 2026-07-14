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
