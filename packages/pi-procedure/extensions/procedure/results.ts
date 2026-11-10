/**
 * results.ts — the one tool-result shape (copied verbatim from
 * pi-subagents/extensions/subagents/tools/results.ts).
 */

export function jsonResult(value: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: undefined };
}

