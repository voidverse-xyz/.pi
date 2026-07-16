/**
 * tools/sub-agent.ts — the ONE tool a subagent sees beyond its coding tools.
 * Address is closed over — an agent cannot spoof its identity.
 *
 *   report — progress / final result to the main agent (final:true completes
 *            the current assignment; a oneshot auto-retires after).
 *
 * Hub-and-spoke: no peer messaging, no blocking questions. error envelopes are
 * runtime-emitted, not tools.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DeliveryOutcome } from "../mail/deliver.ts";
import { errorResult, jsonResult } from "./results.ts";

/** The narrow seam the runtime implements for subagent-originated reports. */
export interface SubagentMailPort {
	reportFromAgent(from: string, opts: { text: string; data?: unknown; final?: boolean }): DeliveryOutcome;
}

const MAX_REPORT_TEXT_CHARS = 16_000;
const MAX_DATA_BYTES = 64_000;

const ReportParams = Type.Object({
	text: Type.String({ maxLength: MAX_REPORT_TEXT_CHARS }),
	final: Type.Optional(
		Type.Boolean({
			description:
				"true = this task is complete. Include open questions under an `Open questions:` heading if anything blocked you. (A oneshot auto-retires after its final report.)",
		}),
	),
	data: Type.Optional(Type.Any({ description: "Structured result. Kept on disk; summarized in the main agent's digest." })),
});

export function createSubagentTools(address: string, port: SubagentMailPort): ToolDefinition[] {
	const report: ToolDefinition<typeof ReportParams> = {
		name: "report",
		label: "Report to main",
		description:
			"Send progress or a final result to the main agent — your only communication channel. " +
			"Use final:true when your assigned task is complete (or when it CANNOT be completed — say why and list your open questions).",
		parameters: ReportParams,
		async execute(_id, params) {
			if (params.data !== undefined && Buffer.byteLength(JSON.stringify(params.data)) > MAX_DATA_BYTES) {
				return errorResult(`report data exceeds ${MAX_DATA_BYTES} bytes.`);
			}
			const outcome = port.reportFromAgent(address, {
				text: params.text,
				...(params.final !== undefined ? { final: params.final } : {}),
				...(params.data !== undefined ? { data: params.data } : {}),
			});
			return jsonResult({ reported: true, final: params.final === true, envelopeId: outcome.envelopeId });
		},
	};

	return [report];
}
