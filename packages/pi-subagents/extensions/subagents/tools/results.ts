/**
 * tools/results.ts — the one tool-result shape, shared by the main-agent and
 * subagent tool files.
 */

export function jsonResult(value: unknown, terminate = false): { content: [{ type: "text"; text: string }]; details: undefined; terminate?: true } {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined, ...(terminate ? { terminate: true as const } : {}) };
}

export function errorResult(error: unknown): never {
	// Pi only sets isError when execute throws; a returned isError field is ignored.
	throw error instanceof Error ? error : new Error(String(error));
}
