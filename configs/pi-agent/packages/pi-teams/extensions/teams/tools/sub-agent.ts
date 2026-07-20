/**
 * tools/sub-agent.ts — the tool trio a SUBAGENT sees (01-power-matrix sub→sub +
 * reverse channel). Address is closed over — an agent cannot spoof its identity.
 *
 *   send_message — peer→peer mail (flat comm, D12). Not to main/user.
 *   report       — progress / final result to the main agent (final:true, D26').
 *   ask          — a non-blocking question to the main agent (D14).
 *
 * escalation/error envelopes are runtime-emitted, not tools.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DeliveryOutcome } from "../mail/deliver.ts";
import type { EnvelopeType } from "../mail/envelope.ts";
import { errorResult, jsonResult } from "./results.ts";

/** The narrow seam the runtime implements for subagent-originated mail. */
export interface SubagentMailPort {
	sendFromAgent(
		from: string,
		opts: { to: string; type: EnvelopeType; text: string; data?: unknown; final?: boolean; correlationId?: string | null },
	): DeliveryOutcome;
}

const MAX_REPORT_TEXT_CHARS = 16_000;
const MAX_DATA_BYTES = 64_000;

const SendParams = Type.Object({
	to: Type.String({ description: "A peer agent address <type>/<id> (not 'main' — use report/ask for the main agent)." }),
	text: Type.String(),
	expectReply: Type.Optional(Type.Boolean({ description: "true → a question (the peer should answer with correlationId). You go dormant until it replies." })),
	correlationId: Type.Optional(Type.String({ description: "Set to answer a peer's question (the question envelope's id)." })),
});

const ReportParams = Type.Object({
	text: Type.String({ maxLength: MAX_REPORT_TEXT_CHARS }),
	final: Type.Optional(Type.Boolean({ description: "true = this task is complete. (A oneshot auto-retires after its final report.)" })),
	data: Type.Optional(Type.Any({ description: "Structured result (e.g. a collect result). Kept on disk; summarized in the main agent's digest." })),
	correlationId: Type.Optional(Type.String({ description: "The collect-request id when fulfilling team_collect." })),
});

const AskParams = Type.Object({
	text: Type.String({ description: "A question for the main agent. You will go dormant and wake with the answer." }),
});

export interface SubagentToolOptions {
	/** false = omit `send_message` (peer messaging off; the main agent coordinates). Default true. */
	peers?: boolean;
}

export function createSubagentTools(address: string, port: SubagentMailPort, options: SubagentToolOptions = {}): ToolDefinition[] {
	const sendMessage: ToolDefinition<typeof SendParams> = {
		name: "send_message",
		label: "Message a peer",
		description: "Send mail to a PEER subagent (flat team — any peer listed in your context). Not for the main agent (use report/ask).",
		parameters: SendParams,
		async execute(_id, params) {
			if (params.to === "main" || params.to === "user") return errorResult("send_message is peer-only; use `report` or `ask` for the main agent.");
			if (params.expectReply && params.correlationId !== undefined) return errorResult("expectReply and correlationId are mutually exclusive.");
			const type: EnvelopeType = params.expectReply ? "question" : params.correlationId !== undefined ? "answer" : "message";
			const outcome = port.sendFromAgent(address, {
				to: params.to,
				type,
				text: params.text,
				...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
			});
			if (!outcome.delivered && outcome.disposition === "bounced") return errorResult(`Message bounced: ${outcome.bounceReason}`);
			return jsonResult({ sent: true, envelopeId: outcome.envelopeId, disposition: outcome.disposition });
		},
	};

	const report: ToolDefinition<typeof ReportParams> = {
		name: "report",
		label: "Report to main",
		description: "Send progress or a final result to the main agent. Use final:true when your assigned task is complete.",
		parameters: ReportParams,
		async execute(_id, params) {
			if (params.data !== undefined && Buffer.byteLength(JSON.stringify(params.data)) > MAX_DATA_BYTES) {
				return errorResult(`report data exceeds ${MAX_DATA_BYTES} bytes.`);
			}
			const outcome = port.sendFromAgent(address, {
				to: "main",
				type: "report",
				text: params.text,
				...(params.final !== undefined ? { final: params.final } : {}),
				...(params.data !== undefined ? { data: params.data } : {}),
				...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
			});
			return jsonResult({ reported: true, final: params.final === true, envelopeId: outcome.envelopeId });
		},
	};

	const ask: ToolDefinition<typeof AskParams> = {
		name: "ask",
		label: "Ask main",
		description: "Ask the main agent a question, then END YOUR TURN. You go dormant and wake with the answer quoted next to your question.",
		parameters: AskParams,
		async execute(_id, params) {
			const outcome = port.sendFromAgent(address, { to: "main", type: "question", text: params.text });
			return jsonResult({ asked: true, envelopeId: outcome.envelopeId, note: "End your turn now — you'll be woken with the answer." });
		},
	};

	// Peer messaging off → the agent has no send_message; it coordinates via main.
	return options.peers === false ? [report, ask] : [sendMessage, report, ask];
}
