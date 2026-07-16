/**
 * tools/results.ts — the one tool-result shape, shared by the main-agent and
 * subagent tool files.
 */

export function jsonResult(value: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: undefined };
}

export function errorResult(error: unknown): { content: [{ type: "text"; text: string }]; details: undefined; isError: true } {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}
