/**
 * tools/main-agent.ts — the eight subagent_* tools the main agent's LLM sees
 * (03-tool-surface.md, complete as of Phase 3).
 *
 * Imports ONLY core.ts (D23 structural rule 1). Tool results are
 * LLM-friendly JSON matching the documented return shapes exactly:
 *   subagent_spawn     → { address, created, state, vitals, taskEnvelopeId? }
 *   subagent_send      → { delivery, disposition, recipientState, envelopeId }
 *   subagent_steer     → { steered }
 *   subagent_status    → roster | detail(+tail)
 *   subagent_collect   → { requested: true, requestId, recipientState }
 *   subagent_await     → { status, report|attention?, progress? }
 *   subagent_interrupt → { interrupted }
 *   subagent_retire    → { retired: true }
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentsCore } from "../core.ts";
import type { Lifetime } from "../store/registry.ts";

/** Resolve the per-session core lazily from the tool-call context. */
export type GetCore = (ctx: ExtensionContext) => SubagentsCore;

function jsonResult(value: unknown): {
	content: [{ type: "text"; text: string }];
	details: undefined;
} {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: undefined };
}

function errorResult(error: unknown): {
	content: [{ type: "text"; text: string }];
	details: undefined;
	isError: true;
} {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

// ---------------------------------------------------------------------------
// subagent_spawn
// ---------------------------------------------------------------------------

const SpawnParams = Type.Object({
	type: Type.String({
		description: "Subagent type name — a <type>.md in the project or global type library",
	}),
	id: Type.Optional(
		Type.String({
			description:
				'Instance id: a meaningful purview slug (e.g. "auth"). Persistent spawns default ' +
				'to "main"; NEVER set for oneshots (they auto-name tmp-<short>)',
		}),
	),
	team: Type.Optional(
		Type.String({
			description: "Team to join; naming a new team creates it. Teams scope peer communication",
		}),
	),
	lifetime: Type.Optional(
		Type.Union([Type.Literal("persistent"), Type.Literal("oneshot")], {
			description:
				'Default "persistent" (long-lived identity with durable memory). "oneshot" ' +
				"auto-retires after its final report",
		}),
	),
	task: Type.Optional(
		Type.String({
			description:
				"First message — spawn + assign in one call. The agent cannot see your " +
				"conversation, so the task must carry the full brief",
		}),
	),
});

export function createSpawnTool(getCore: GetCore): ToolDefinition<typeof SpawnParams> {
	return {
		name: "subagent_spawn",
		label: "Spawn subagent",
		description:
			"Spawn or wake a subagent instance at address <type>/<id>. " +
			"Get-or-create: if the address already exists, it wakes with its memory intact " +
			"and the result reports created:false. The task, if given, runs asynchronously and " +
			"returns taskEnvelopeId; use subagent_await when the delegated result must be included " +
			"before you answer the user.",
		parameters: SpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				const result = await core.spawn({
					type: params.type,
					...(params.id !== undefined ? { id: params.id } : {}),
					...(params.team !== undefined ? { team: params.team } : {}),
					...(params.lifetime !== undefined ? { lifetime: params.lifetime as Lifetime } : {}),
					...(params.task !== undefined ? { task: params.task } : {}),
					inherit: {
						...(ctx.model ? { modelRef: `${ctx.model.provider}/${ctx.model.id}` } : {}),
					},
				});
				return jsonResult(result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// The type catalog helps ONLY when the type itself wasn't found —
				// appending it to unrelated failures (oneshot-id rule, invalid
				// frontmatter) buries the actual error.
				if (!message.startsWith("Unknown subagent type")) return errorResult(error);
				const types = core.availableTypes();
				const available =
					types.length > 0
						? `\nAvailable types:\n${types
								.map((t) => `- ${t.name} (${t.source}): ${t.invalid ?? t.description}`)
								.join("\n")}`
						: "\nNo subagent types found — author one as <project>/.pi/subagents/<type>.md or ~/.pi/agent/subagents/<type>.md.";
				return errorResult(new Error(`${message}${available}`));
			}
		},
	};
}

// ---------------------------------------------------------------------------
// subagent_send
// ---------------------------------------------------------------------------

const SendParams = Type.Object({
	to: Type.String({ description: "Recipient address <type>/<id>" }),
	text: Type.String({
		description: "The message. The agent cannot see your conversation — carry full context",
	}),
	when: Type.Optional(
		Type.Union([Type.Literal("now"), Type.Literal("after-turn")], {
			description:
				'Ordering hint only; default "now". Both values deliver at the recipient\'s next turn ' +
				"boundary, or wake it immediately if dormant — mail never interrupts a running turn, " +
				"and there is no way to hold mail back from a dormant agent without waking it",
		}),
	),
	correlationId: Type.Optional(
		Type.String({
			description:
				"Set when ANSWERING a subagent's question: the question's envelope id (msg_...) from " +
				"your mail digest. The asker wakes with its original question quoted next to your answer. " +
				"ALSO the escalation-deny channel: correlating to an escalation envelope's id DENIES that " +
				"blocked tool call, with your text as the deny note — never correlate to an escalation " +
				"unless you intend to deny it (you can never approve; only the human can)",
		}),
	),
});

export function createSendTool(getCore: GetCore): ToolDefinition<typeof SendParams> {
	return {
		name: "subagent_send",
		label: "Message subagent",
		description:
			"Send a message to a subagent's mailbox — plain instruction, or answer/escalation-deny " +
			"(correlationId set). Mail never interrupts a running turn: it is delivered at the " +
			"recipient's next turn boundary, or wakes it immediately if dormant. " +
			"Replies/questions from the agent arrive later as mail in your own digest.",
		parameters: SendParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				const result = await core.send({
					to: params.to,
					text: params.text,
					...(params.when !== undefined ? { when: params.when } : {}),
					...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
				});
				return jsonResult({
					delivery: result.delivery,
					disposition: result.disposition,
					recipientState: result.recipientState,
					envelopeId: result.envelopeId,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// subagent_steer
// ---------------------------------------------------------------------------

const SteerParams = Type.Object({
	to: Type.String({ description: "Agent address <type>/<id>" }),
	text: Type.String({ description: "Mid-turn redirection for the agent's CURRENT work" }),
});

export function createSteerTool(getCore: GetCore): ToolDefinition<typeof SteerParams> {
	return {
		name: "subagent_steer",
		label: "Steer subagent",
		description:
			"Inject a steering message into a subagent's RUNNING turn to redirect its current " +
			"work. Steering is not mail: the text is injected into the running turn without " +
			"aborting it — the agent absorbs the redirection and continues (subagent_interrupt " +
			"is the tool that aborts). Returns steered:false if the agent is not running " +
			"(use subagent_send instead).",
		parameters: SteerParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				return jsonResult(await core.steer(params.to, params.text));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// subagent_status
// ---------------------------------------------------------------------------

const StatusParams = Type.Object({
	address: Type.Optional(
		Type.String({
			description: "Agent address <type>/<id> for a detail view; omit for the full roster",
		}),
	),
	tail: Type.Optional(
		Type.Number({
			description: "With address: number of trailing transcript entries to include (default 20)",
		}),
	),
});

export function createStatusTool(getCore: GetCore): ToolDefinition<typeof StatusParams> {
	return {
		name: "subagent_status",
		label: "Subagent status",
		description:
			"Observe subagents without messaging them (read-only, never perturbs). " +
			"No address: full roster — per agent: address, type, state (queued|running|dormant|waiting), " +
			"lifetime, teams, purview, vitals (ctx %, tokens, cost, turns), unread (mail it has not " +
			"seen yet), and — for waiting agents — waitingOn (the pending escalation blocking it). " +
			"With address: detail plus outstandingQuestions (questions it asked that are still " +
			"unanswered) and the last `tail` transcript entries.",
		parameters: StatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				if (params.address !== undefined) {
					const detail = await core.peek(params.address, params.tail);
					if (!detail) {
						return errorResult(
							new Error(`No subagent at "${params.address}" (retired or never spawned).`),
						);
					}
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

// ---------------------------------------------------------------------------
// subagent_collect
// ---------------------------------------------------------------------------

const CollectParams = Type.Object({
	to: Type.String({ description: "Agent address <type>/<id>" }),
	schema: Type.Any({
		description:
			"JSON schema the result must conform to. Validation supports ONLY this subset: type, " +
			"properties, required, items, enum, const, additionalProperties:false — every other " +
			"keyword (oneOf, format, pattern, minimum, ...) is SILENTLY IGNORED, so a 'conforms' " +
			"verdict never reflects them. Express constraints within the subset",
	}),
});

export function createCollectTool(getCore: GetCore): ToolDefinition<typeof CollectParams> {
	return {
		name: "subagent_collect",
		label: "Collect from subagent",
		description:
			"Request a schema-conforming final result from a subagent. NON-BLOCKING: this only " +
			"sends the collect request; the result arrives later as a report whose data is validated " +
			"against the schema. Keep working, or call subagent_await with waitFor:\"collect\" and " +
			"the returned requestId when the result must be present before your response.",
		parameters: CollectParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				return jsonResult(await core.collect(params.to, params.schema));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// subagent_await
// ---------------------------------------------------------------------------

const AwaitParams = Type.Object({
	to: Type.String({ description: "Agent address <type>/<id>" }),
	waitFor: Type.Union([Type.Literal("final"), Type.Literal("collect")], {
		description:
			'"final" waits for a final report correlated to a spawn/send anchor; "collect" waits for a report correlated to a collect request',
	}),
	anchorId: Type.String({
		description: "taskEnvelopeId/envelopeId for final mode, or requestId for collect mode",
	}),
	timeoutSeconds: Type.Optional(
		Type.Integer({
			description: "Cancellable wait timeout in seconds (default 300; range 1–900)",
			minimum: 1,
			maximum: 900,
		}),
	),
});

export function createAwaitTool(getCore: GetCore): ToolDefinition<typeof AwaitParams> {
	return {
		name: "subagent_await",
		label: "Await subagent result",
		description:
			"Wait cancellably for one anchored delegated result. Returns completed only when the " +
			"matching report is available in this main session. Questions, escalations, and errors " +
			"return early as attention so you can act and await again. Timeout consumes no mail. " +
			"Use this whenever the user expects delegated findings in the current response; do not " +
			"claim review completion before status:completed.",
		parameters: AwaitParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				return jsonResult(
					await core.awaitResult({
						to: params.to,
						waitFor: params.waitFor,
						anchorId: params.anchorId,
						...(params.timeoutSeconds !== undefined ? { timeoutSeconds: params.timeoutSeconds } : {}),
						sessionFile: ctx.sessionManager.getSessionFile() ?? null,
						...(signal !== undefined ? { signal } : {}),
					}),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// subagent_interrupt
// ---------------------------------------------------------------------------

const InterruptParams = Type.Object({
	to: Type.String({ description: "Agent address <type>/<id>" }),
});

export function createInterruptTool(getCore: GetCore): ToolDefinition<typeof InterruptParams> {
	return {
		name: "subagent_interrupt",
		label: "Interrupt subagent",
		description:
			"Abort a subagent's current turn. The agent stays alive with memory intact and goes " +
			"dormant; its unprocessed mail is re-delivered at the next wake. Returns " +
			"interrupted:false if the agent was not running.",
		parameters: InterruptParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				return jsonResult(await core.interrupt(params.to));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// subagent_retire
// ---------------------------------------------------------------------------

const RetireParams = Type.Object({
	to: Type.String({ description: "Agent address <type>/<id>" }),
});

export function createRetireTool(getCore: GetCore): ToolDefinition<typeof RetireParams> {
	return {
		name: "subagent_retire",
		label: "Retire subagent",
		description:
			"The ONLY destructive tool: permanently retire a subagent. Deregisters it, scrubs it " +
			"from all teams, moves its directory (sessions, mailbox, files) to the archive for " +
			"post-mortem viewing, and bounces all future mail to its address. Not reversible via " +
			"tools — spawn creates a FRESH identity.",
		parameters: RetireParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const core = getCore(ctx);
			try {
				await core.retire(params.to);
				return jsonResult({ retired: true });
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}
