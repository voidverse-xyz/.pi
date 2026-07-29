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
	type: Type.String({ description: "Type name (a <type>.md in ~/.pi/agent/subagents or <project>/.pi/subagents)." }),
	id: Type.Optional(
		Type.String({ description: "Instance id / purview slug (e.g. 'auth'). Defaults to 'main'. Persistent only — omit for oneshots." }),
	),
	lifetime: Type.Optional(
		Type.Union([Type.Literal("persistent"), Type.Literal("oneshot")], {
			description:
				"persistent (default): named, durable memory — lives until YOU team_retire it, so every persistent spawn is a cleanup obligation. " +
				"oneshot: disposable, auto-named (tmp-<hex>, never pass an id — give it a `label` instead), retires itself after it sends a final report. " +
				"Rule of thumb: one-off task, probe, or experiment → oneshot; an agent you'll message again across tasks → persistent.",
		}),
	),
	task: Type.Optional(Type.String({ description: "Optional first task — spawn and assign in one call. Runs asynchronously." })),
	label: Type.Optional(
		Type.String({
			maxLength: 80,
			description:
				"Short display label ('what is this one doing'), shown in the roster and TUI next to the address. " +
				"Strongly recommended for oneshots (their tmp-<hex> ids say nothing), e.g. 'lint sweep' or 'flaky-test probe'.",
		}),
	),
});

export function createSpawnTool(getCore: GetCore): ToolDefinition<typeof SpawnParams> {
	return {
		name: "team_spawn",
		label: "Spawn subagent",
		description:
			"Spawn or wake a subagent. Get-or-create on <type>/<id>: if the address already exists it wakes " +
			"with memory intact (created:false). An optional task runs asynchronously; observe progress with team_status. " +
			"IMPORTANT — pick the lifetime deliberately: use lifetime:'oneshot' (and no id) for single-task work like " +
			"probes, checks, and experiments — it cleans up after itself. Persistent agents (the default) stay on the " +
			"roster forever until you team_retire them, so don't leave one behind for a task you won't revisit.",
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
	to: Type.String({ description: "Recipient subagent address <type>/<id>." }),
	text: Type.String(),
	correlationId: Type.Optional(Type.String({ description: "Set to answer a subagent's question (the question envelope's id)." })),
});

export function createSendTool(getCore: GetCore): ToolDefinition<typeof SendParams> {
	return {
		name: "team_send",
		label: "Message a subagent",
		description:
			"Send mail to a subagent (or answer its question with correlationId). Never interrupts a running turn — " +
			"delivered at the recipient's turn boundary, or it wakes a dormant agent.",
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
	to: Type.String({ description: "The running subagent to steer." }),
	text: Type.String({ description: "Guidance injected mid-turn to redirect current work." }),
});

export function createSteerTool(getCore: GetCore): ToolDefinition<typeof SteerParams> {
	return {
		name: "team_steer",
		label: "Steer subagent",
		description: "Inject guidance into a subagent's CURRENT turn (main-agent-only). No-op if it isn't running; use team_send otherwise.",
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
	to: Type.String({ description: "The subagent to collect a structured result from." }),
	schema: Type.Any({ description: "JSON-schema subset (type/properties/required/items/enum/const/additionalProperties:false) the result must conform to." }),
});

export function createCollectTool(getCore: GetCore): ToolDefinition<typeof CollectParams> {
	return {
		name: "team_collect",
		label: "Collect result",
		description:
			"Ask a subagent for a schema-conforming structured result. Non-blocking: the agent delivers it later as a report " +
			"whose data is validated against the schema. Only a restricted JSON-schema subset is honored.",
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
	to: Type.String({ description: "The subagent whose result to wait for." }),
	waitFor: Type.Union([Type.Literal("final"), Type.Literal("collect")], { description: "final = its final report for the task; collect = a specific team_collect result." }),
	anchorId: Type.String({ description: "The anchor id: taskEnvelopeId from team_spawn/team_send (final), or requestId from team_collect (collect)." }),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900, description: "Max seconds to wait (default 300)." })),
});

export function createAwaitTool(getCore: GetCore): ToolDefinition<typeof AwaitParams> {
	return {
		name: "team_await",
		label: "Await subagent result",
		description:
			"Block until a subagent delivers its final report (or a collect result) for a given anchor, then return it. " +
			"Returns early with 'attention' if the agent needs an answer/escalation/errors (so it can't deadlock), 'retired' " +
			"if the agent is gone, or 'timeout'. Subagents are background by default — use this to join their work in-turn.",
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

const InterruptParams = Type.Object({ to: Type.String({ description: "The running subagent to interrupt." }) });

export function createInterruptTool(getCore: GetCore): ToolDefinition<typeof InterruptParams> {
	return {
		name: "team_interrupt",
		label: "Interrupt subagent",
		description: "Abort a subagent's current turn. It stays alive with memory intact and goes dormant; its triggering mail stays pending.",
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

const RetireParams = Type.Object({ to: Type.String({ description: "The subagent to retire (<type>/<id>)." }) });

export function createRetireTool(getCore: GetCore): ToolDefinition<typeof RetireParams> {
	return {
		name: "team_retire",
		label: "Retire subagent",
		description:
			"Permanently retire a subagent: deregister it and archive its memory. The ONLY destructive action — the address " +
			"bounces afterward. Use for finished persistent agents; oneshots retire themselves.",
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
		description: "on = subagents may message each other directly; off = all cross-agent work routes through you; auto = each type's own default.",
	}),
});

export function createPeersTool(getCore: GetCore): ToolDefinition<typeof PeersParams> {
	return {
		name: "team_peers",
		label: "Set peer messaging",
		description:
			"Turn subagent-to-subagent messaging on or off for the fleet (D12). off makes YOU the sole coordinator — " +
			"agents can only report to you, and you relay between them. Applies from each agent's next wake (off is also " +
			"enforced immediately at delivery; an agent mid-turn keeps its current tool set until it rebuilds). " +
			"Note: if the user pinned peer messaging on/off, your setting is recorded but the user's choice wins.",
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
	address: Type.Optional(Type.String({ description: "A <type>/<id> to inspect in detail. Omit for the full roster." })),
	tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "With address: number of trailing transcript entries (default 20)." })),
});

export function createStatusTool(getCore: GetCore): ToolDefinition<typeof StatusParams> {
	return {
		name: "team_status",
		label: "Subagent status",
		description:
			"Inspect subagents. With no address: the full roster (address, state, vitals). With an address: " +
			"detail plus the last transcript entries (read-only; never perturbs the agent).",
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
