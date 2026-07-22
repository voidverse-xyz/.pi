/**
 * runner/structured-output.ts — schema forcing for agent({schema}).
 *
 * The procedure agent gets a `structured_output` tool as its ONLY way to
 * deliver a result. Its params stay permissive ({output: Any}) — validation
 * runs against the caller's JSON schema via schema/validate.ts, so a mismatch
 * returns a tool error the model can fix within the same turn. A valid call
 * captures the object into the slot and asks the harness to end the turn
 * (`terminate: true`; the runner's re-prompt loop is the fallback if the host
 * ignores that hint).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateAgainstSchema } from "../schema/validate.ts";

export const STRUCTURED_OUTPUT_TOOL = "structured_output";

export interface OutputSlot {
	set: boolean;
	value: unknown;
}

export function createOutputSlot(): OutputSlot {
	return { set: false, value: undefined };
}

const Params = Type.Object(
	{
		output: Type.Any({ description: "Your final result. Must match the JSON schema given in your instructions." }),
	},
	{ additionalProperties: false },
);

export function createStructuredOutputTool(schema: unknown, slot: OutputSlot): ToolDefinition {
	const tool = {
		name: STRUCTURED_OUTPUT_TOOL,
		label: "Structured Output",
		description:
			"Deliver your final structured result. Call this exactly once with an `output` value matching the required JSON schema — " +
			"it completes your assignment. If validation fails, fix the value and call it again.",
		parameters: Params,
		async execute(_toolCallId: string, params: { output: unknown }) {
			const result = validateAgainstSchema(params.output, schema);
			if (!result.valid) {
				throw new Error(
					`Your output does not match the required schema:\n- ${result.errors.join("\n- ")}\nFix the value and call ${STRUCTURED_OUTPUT_TOOL} again.`,
				);
			}
			slot.set = true;
			slot.value = params.output;
			return {
				content: [{ type: "text" as const, text: "Output accepted. Your assignment is complete — do not call any more tools." }],
				details: undefined,
				terminate: true,
			};
		},
	};
	return tool as unknown as ToolDefinition;
}
