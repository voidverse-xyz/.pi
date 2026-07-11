/**
 * tools/sub-agent.ts — the tools a SUBAGENT's LLM sees (01-power-matrix:
 * sub→sub is send/queue ONLY; sub→main is the envelope-type reverse channel
 * report | question | escalation | error — types, not powers).
 *
 * Exactly three tools:
 *   send_message — peer send/queue (the two allowed sub→sub powers). Also
 *                  carries peer questions (expectReply → type:question) and
 *                  peer answers (correlationId → type:answer), which are
 *                  envelope TYPES riding the same send power, not new powers.
 *   report       — report envelope to main (progress, or final with
 *                  final:true — which auto-retires a oneshot, D13). Collect
 *                  results ride this with data + the request's correlationId.
 *   ask          — question envelope to main; NON-BLOCKING (D14): end the
 *                  turn after asking, the answer wakes you.
 *
 * escalation/error envelopes are runtime-emitted (Phase 5 sandbox, turn
 * failures), not tools — an agent never self-declares an escalation.
 *
 * Injected per subagent session via createAgentSession's customTools (the
 * runtime builds them with the agent's own address closed over — no
 * self-reported identity). This module imports NO runtime implementation; the
 * runtime hands it a narrow SubagentMailPort.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Disposition } from "../mail/deliver.ts";

/**
 * What the runtime exposes to subagent tools: outbound mail only, sender
 * pinned by the runtime (hops threading + oneshot bookkeeping live behind it).
 */
export interface SubagentMailPort {
	sendFromAgent(options: {
		from: string;
		to: string;
		type: "message" | "question" | "answer" | "report";
		text: string;
		data?: unknown;
		correlationId?: string;
		when?: "now" | "after-turn";
	}): Promise<{ disposition: Disposition; bounceReason?: string }>;
	/**
	 * A final report was durably delivered — auto-retire if the sender is a
	 * oneshot (D13; after the current turn, so the report turn completes).
	 */
	noteFinalReport(from: string): void;
}

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

const NON_BLOCKING_NOTE =
	"Questions are NON-BLOCKING: after asking, finish your turn (leave a one-line " +
	'checkpoint like "paused mid-X; next: Y"). You will go dormant and be woken with ' +
	"the answer quoted next to your question. Never poll or busy-wait for a reply.";

// ---------------------------------------------------------------------------
// send_message (peer send/queue)
// ---------------------------------------------------------------------------

const SendMessageParams = Type.Object({
	to: Type.String({
		description:
			'Teammate address "<type>/<id>" (see Your team in your context). Peers only — use the report/ask tools for the main agent',
	}),
	text: Type.String({ description: "The message. Peers cannot see your session — carry full context" }),
	when: Type.Optional(
		Type.Union([Type.Literal("now"), Type.Literal("after-turn")], {
			description:
				'Both deliver at the recipient\'s next turn boundary or wake — mail never interrupts. Default "now"',
		}),
	),
	expectReply: Type.Optional(
		Type.Boolean({
			description:
				"true = this is a question: the peer is told to answer with your message's correlation id. " +
				"End your turn after asking — the answer will wake you",
		}),
	),
	correlationId: Type.Optional(
		Type.String({
			description:
				'When ANSWERING a question from your wake digest, set this to the question\'s envelope id (msg_...) so the asker sees their question quoted with your answer',
		}),
	),
});

// ---------------------------------------------------------------------------
// report / ask (reverse channel to main)
// ---------------------------------------------------------------------------

const ReportParams = Type.Object({
	text: Type.String({ description: "Progress update or final result summary" }),
	final: Type.Optional(
		Type.Boolean({
			description:
				"true = this is your FINAL report: the task is complete. Default false (progress report). " +
				"A oneshot agent is retired after its final report",
		}),
	),
	data: Type.Optional(
		Type.Any({
			description:
				"Structured result payload. When answering a collect request, this must conform to the requested schema",
		}),
	),
	correlationId: Type.Optional(
		Type.String({
			description:
				"When this report answers a collect request from your mail, set the request's envelope id (msg_...)",
		}),
	),
});

const AskParams = Type.Object({
	text: Type.String({
		description: "The question for the main agent. Include enough context to answer without your transcript",
	}),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build the three subagent tools with the agent's own address closed over. */
export function createSubagentTools(address: string, port: SubagentMailPort): ToolDefinition[] {
	const sendMessage: ToolDefinition<typeof SendMessageParams> = {
		name: "send_message",
		label: "Message teammate",
		description:
			"Send a message to a teammate's mailbox. Mail NEVER interrupts: it is delivered at " +
			"the recipient's next turn boundary, or wakes them if dormant. Set expectReply:true " +
			`to ask a question — ${NON_BLOCKING_NOTE} Set correlationId when answering a question ` +
			"from your wake digest.",
		parameters: SendMessageParams,
		async execute(_toolCallId, params) {
			try {
				if (params.to === "main" || params.to === "user") {
					return errorResult(
						new Error('send_message is for teammates only — use the "report" or "ask" tool to reach the main agent.'),
					);
				}
				if (params.expectReply === true && params.correlationId !== undefined) {
					return errorResult(new Error("A message is a question (expectReply) or an answer (correlationId), not both."));
				}
				const type = params.correlationId !== undefined ? "answer" : params.expectReply === true ? "question" : "message";
				const outcome = await port.sendFromAgent({
					from: address,
					to: params.to,
					type,
					text: params.text,
					...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
					...(params.when !== undefined ? { when: params.when } : {}),
				});
				if (outcome.disposition === "bounced") {
					return errorResult(new Error(`Not delivered: ${outcome.bounceReason ?? "bounced"}`));
				}
				return jsonResult({
					sent: true,
					type,
					disposition: outcome.disposition,
					...(type === "question" ? { note: "Answer will arrive as mail that wakes you — end your turn." } : {}),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	};

	const report: ToolDefinition<typeof ReportParams> = {
		name: "report",
		label: "Report to main agent",
		description:
			"Send a report to the main agent: progress updates (default) or your final result " +
			"(final:true — signals the task is complete; oneshot agents are retired after it). " +
			"When fulfilling a collect request, include the structured result as `data` and the " +
			"request's envelope id as correlationId.",
		parameters: ReportParams,
		async execute(_toolCallId, params) {
			try {
				const outcome = await port.sendFromAgent({
					from: address,
					to: "main",
					type: "report",
					text: params.text,
					...(params.data !== undefined ? { data: params.data } : {}),
					...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
				});
				if (outcome.disposition === "bounced") {
					return errorResult(new Error(`Not delivered: ${outcome.bounceReason ?? "bounced"}`));
				}
				if (params.final === true) port.noteFinalReport(address);
				return jsonResult({ reported: true, final: params.final === true });
			} catch (error) {
				return errorResult(error);
			}
		},
	};

	const ask: ToolDefinition<typeof AskParams> = {
		name: "ask",
		label: "Ask the main agent",
		description: `Ask the main agent a question you need answered to proceed. ${NON_BLOCKING_NOTE}`,
		parameters: AskParams,
		async execute(_toolCallId, params) {
			try {
				const outcome = await port.sendFromAgent({
					from: address,
					to: "main",
					type: "question",
					text: params.text,
				});
				if (outcome.disposition === "bounced") {
					return errorResult(new Error(`Not delivered: ${outcome.bounceReason ?? "bounced"}`));
				}
				return jsonResult({
					asked: true,
					note: "Non-blocking: end your turn now (with a checkpoint line). The answer will wake you.",
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	};

	return [sendMessage, report, ask] as ToolDefinition[];
}
