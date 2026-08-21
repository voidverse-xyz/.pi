/**
 * tools/main-agent.ts — the team_* tools the MAIN agent's LLM sees
 * (intent-grouped, D16): spawn, send, steer, collect, await, interrupt,
 * retire, status, peers.
 *
 * Tools talk ONLY to the core facade.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentsCore } from "../core.ts";
import { parseAddress } from "../mail/envelope.ts";
import type { Lifetime } from "../store/registry.ts";
import { errorResult, jsonResult } from "./results.ts";

type GetCore = () => SubagentsCore;

/** These tools target a subagent instance — `main`/`user`/garbage are rejected up front. */
function agentTargetError(address: string): ReturnType<typeof errorResult> | null {
	if (parseAddress(address)?.kind === "agent") return null;
	return errorResult(new Error(`\`${address}\` is not a subagent address — expected \`<type>/<id>\` (not "main" or "user").`));
}

const SpawnParams = Type.Object({
	type: Type.String({ description: "Type definition name from global or project subagents." }),
	id: Type.Optional(
		Type.String({ description: "Persistent instance id; defaults to main. Omit for oneshots." }),
	),
	lifetime: Type.Optional(
		Type.Union([Type.Literal("persistent"), Type.Literal("oneshot")], {
			description:
				"persistent (default) keeps memory until team_retire; oneshot auto-retires. Use oneshot without id for single tasks.",
		}),
	),
	task: Type.Optional(Type.String({ description: "Optional initial asynchronous task." })),
	label: Type.Optional(
		Type.String({
			maxLength: 80,
			description: "Short roster/TUI label; recommended for oneshots.",
		}),
	),
});

export function createSpawnTool(getCore: GetCore): ToolDefinition<typeof SpawnParams> {
	return {
		name: "team_spawn",
		label: "Spawn subagent",
		description:
			"Spawn or wake a typed agent. Persistent addresses are get-or-create and require later team_retire; oneshots " +
			"auto-retire. Use oneshot without id for single tasks.",
		parameters: SpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore();
			try {
				const result = await core.spawn({
					type: params.type,
					...(params.id !== undefined ? { id: params.id } : {}),
					...(params.lifetime !== undefined ? { lifetime: params.lifetime as Lifetime } : {}),
					...(params.task !== undefined ? { task: params.task } : {}),
					...(params.label !== undefined ? { label: params.label } : {}),
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
	to: Type.String({ description: "Recipient <type>/<id>." }),
	text: Type.String(),
	correlationId: Type.Optional(Type.String({ description: "Question envelope id when replying." })),
});

export function createSendTool(getCore: GetCore): ToolDefinition<typeof SendParams> {
	return {
		name: "team_send",
		label: "Message a subagent",
		description:
			"Queue mail or answer a question. It wakes dormant agents but never interrupts a running turn.",
		parameters: SendParams,
		async execute(_toolCallId, params) {
			const badTarget = agentTargetError(params.to);
			if (badTarget) return badTarget;
			const core = getCore();
			try {
				const result = await core.send({
					to: params.to,
					text: params.text,
					...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
				});
				// A bounce is a failure to deliver — surface it as an error so the LLM
				// doesn't mistake it for successful delivery (SEND-5).
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
		name: "team_steer",
		label: "Steer subagent",
		description: "Guide a running turn immediately; no-op if idle. Use team_send otherwise.",
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

const CollectParams = Type.Object({
	to: Type.String({ description: "Subagent to query." }),
	schema: Type.Any({ description: "Required schema subset: type/properties/required/items/enum/const/additionalProperties:false." }),
});

export function createCollectTool(getCore: GetCore): ToolDefinition<typeof CollectParams> {
	return {
		name: "team_collect",
		label: "Collect result",
		description:
			"Request a schema-validated result without blocking. Await the later report with team_await.",
		parameters: CollectParams,
		async execute(_toolCallId, params) {
			const badTarget = agentTargetError(params.to);
			if (badTarget) return badTarget;
			try {
				return jsonResult(await getCore().collect(params.to, params.schema));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const AwaitParams = Type.Object({
	to: Type.String({ description: "Subagent to wait for." }),
	waitFor: Type.Union([Type.Literal("final"), Type.Literal("collect")], { description: "Result kind: final report or team_collect result." }),
	anchorId: Type.String({ description: "taskEnvelopeId/envelopeId for final, or requestId for collect." }),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900, description: "Wait limit in seconds (default 300)." })),
});

export function createAwaitTool(getCore: GetCore): ToolDefinition<typeof AwaitParams> {
	return {
		name: "team_await",
		label: "Await subagent result",
		description:
			"Wait for a final or collected result by anchor. Returns attention, retired, or timeout when not completed.",
		parameters: AwaitParams,
		async execute(_toolCallId, params, signal) {
			const badTarget = agentTargetError(params.to);
			if (badTarget) return badTarget;
			try {
				const result = await getCore().awaitResult({
					to: params.to,
					waitFor: params.waitFor,
					anchorId: params.anchorId,
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

const InterruptParams = Type.Object({ to: Type.String({ description: "Running subagent address." }) });

export function createInterruptTool(getCore: GetCore): ToolDefinition<typeof InterruptParams> {
	return {
		name: "team_interrupt",
		label: "Interrupt subagent",
		description: "Stop the current turn without retiring the agent; its mail remains pending.",
		parameters: InterruptParams,
		async execute(_toolCallId, params) {
			const badTarget = agentTargetError(params.to);
			if (badTarget) return badTarget;
			try {
				return jsonResult(await getCore().interrupt(params.to));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const RetireParams = Type.Object({ to: Type.String({ description: "Subagent <type>/<id>." }) });

export function createRetireTool(getCore: GetCore): ToolDefinition<typeof RetireParams> {
	return {
		name: "team_retire",
		label: "Retire subagent",
		description:
			"Permanently remove an address and archive its memory. Use only for finished persistent agents; oneshots " +
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

const PeersParams = Type.Object({
	mode: Type.Union([Type.Literal("on"), Type.Literal("off"), Type.Literal("auto")], {
		description: "on enables peer mail; off routes through you; auto uses each type's default.",
	}),
});

export function createPeersTool(getCore: GetCore): ToolDefinition<typeof PeersParams> {
	return {
		name: "team_peers",
		label: "Set peer messaging",
		description:
			"Set fleet peer messaging. off routes coordination through you; changes apply on each agent's next wake. " +
			"User-pinned settings override this request.",
		parameters: PeersParams,
		async execute(_toolCallId, params) {
			try {
				const core = getCore();
				core.setMainPeerOverride(params.mode === "on" ? true : params.mode === "off" ? false : null);
				const state = core.peerState();
				return jsonResult({
					requested: params.mode,
					applied: !state.userControls,
					...(state.userControls ? { note: `The user has pinned peer messaging "${state.userMode}"; your setting is saved but not active until they release it.` } : {}),
					state,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

const StatusParams = Type.Object({
	address: Type.Optional(Type.String({ description: "Agent to inspect; omit for the roster." })),
	tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "Transcript entries to include (default 20)." })),
});

export function createStatusTool(getCore: GetCore): ToolDefinition<typeof StatusParams> {
	return {
		name: "team_status",
		label: "Subagent status",
		description: "Inspect the full roster or one agent with a read-only transcript tail.",
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
				return jsonResult({ agents: roster, count: roster.length });
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}
