/**
 * sandbox/tools-filter.ts — build a subagent's coding toolset from its type's
 * `tools` allowlist, wrapping the mutating tools with the v2 guards (D20).
 *
 *   edit / write → system-deny (hard, D20b) then pi-safety confirmation (D10a)
 *   bash         → pi-safety confirmation (risk-classified in pi-safety)
 *   read/grep/find/ls → pass through (read-only)
 *
 * v2 has NO per-type path territory and NO bash classifier of its own — a
 * read-only agent simply omits edit/write/bash from its `tools`. Confirmation
 * stays human via the safety bridge (fail-closed).
 *
 * Known v2 trade-off: bash mutations are confirmation-gated but not path-parsed,
 * so bash is not hard-denied from the state tree the way edit/write are — the
 * state tree lives outside the project cwd, and pi-safety prompts on risky bash.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TypeConfig } from "../typedefs/parse.ts";
import type { SystemDenyResult } from "./system-deny.ts";

export const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];
const KNOWN = new Set<string>(CODING_TOOL_NAMES);

export interface SandboxPorts {
	/** Hard-deny check for a write target (D20b). */
	systemDeny(path: string): SystemDenyResult;
	/** Human confirmation via pi-safety (D10a); already bound to the agent address. */
	confirm(request: { tool: "bash" | "edit" | "write"; command?: string; path?: string }): Promise<{ approved: boolean; note?: string }>;
}

/** The tool names a type gets: its allowlist, or all coding tools when unset. Unknown → error. */
export function selectToolNames(config: Pick<TypeConfig, "name" | "tools">): CodingToolName[] {
	if (config.tools === undefined) return [...CODING_TOOL_NAMES];
	const unknown = config.tools.filter((name) => !KNOWN.has(name));
	if (unknown.length > 0) throw new Error(`Type "${config.name}" lists unknown tools: ${unknown.join(", ")}.`);
	return CODING_TOOL_NAMES.filter((name) => config.tools!.includes(name));
}

function summarize(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function hardDeny(tool: string, reason: string): never {
	throw new Error(
		`Blocked by the teams sandbox: ${reason}. This is a hard denial (${tool}) — do not retry; work within your scope or report the limitation to the main agent.`,
	);
}

function confirmDenied(tool: string, note: string | undefined): never {
	throw new Error(`Your ${tool} call was not approved${note ? `: ${note}` : "."} Adjust your approach; do not retry the same call.`);
}

/** Wrap edit/write: hard system-deny on the target, then human confirmation. */
function wrapPathTool(tool: ToolDefinition, ports: SandboxPorts): ToolDefinition {
	const inner = tool.execute.bind(tool);
	const kind = tool.name === "edit" ? "edit" : "write";
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const path = (params as { path?: unknown }).path;
			if (typeof path !== "string" || path === "") throw new Error(`${tool.name}: missing target path.`);
			const deny = ports.systemDeny(path);
			if (deny.denied) hardDeny(tool.name, deny.reason ?? "protected path");
			const result = await ports.confirm({ tool: kind, path });
			if (!result.approved) confirmDenied(tool.name, result.note);
			return inner(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

/** Wrap bash: human confirmation (pi-safety classifies risk). */
function wrapBashTool(tool: ToolDefinition, ports: SandboxPorts): ToolDefinition {
	const inner = tool.execute.bind(tool);
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const command = (params as { command?: unknown }).command;
			if (typeof command !== "string") throw new Error("bash: missing command.");
			const result = await ports.confirm({ tool: "bash", command: summarize(command, 4096) });
			if (!result.approved) confirmDenied("bash", result.note);
			return inner(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

/** Build the sandboxed coding toolset for one agent session. */
export function buildSandboxedTools(config: Pick<TypeConfig, "name" | "tools">, cwd: string, ports: SandboxPorts): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	for (const name of selectToolNames(config)) {
		switch (name) {
			case "read":
				tools.push(createReadToolDefinition(cwd) as ToolDefinition);
				break;
			case "grep":
				tools.push(createGrepToolDefinition(cwd) as ToolDefinition);
				break;
			case "find":
				tools.push(createFindToolDefinition(cwd) as ToolDefinition);
				break;
			case "ls":
				tools.push(createLsToolDefinition(cwd) as ToolDefinition);
				break;
			case "edit":
				tools.push(wrapPathTool(createEditToolDefinition(cwd) as ToolDefinition, ports));
				break;
			case "write":
				tools.push(wrapPathTool(createWriteToolDefinition(cwd) as ToolDefinition, ports));
				break;
			case "bash":
				tools.push(wrapBashTool(createBashToolDefinition(cwd) as ToolDefinition, ports));
				break;
		}
	}
	return tools;
}
