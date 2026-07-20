/**
 * sandbox/tools-filter.ts — build a subagent's coding toolset from its type's
 * `tools` allowlist, wrapping the mutating tools with the v2 guards (D20).
 *
 *   edit / write → system-deny (hard, D20b) then pi-safety confirmation (D10a)
 *   bash         → system-deny text scan (hard) then pi-safety confirmation
 *   read/grep/find/ls → pass through (read-only)
 *
 * v2 has NO per-type path territory and NO bash classifier of its own — a
 * read-only agent simply omits edit/write/bash from its `tools`. Confirmation
 * stays human via the safety bridge (fail-closed).
 *
 * bash is hard-denied when its command TEXT references a protected root (state
 * tree / type-def dirs). This is best-effort (an opaque shell can still evade a
 * text scan), so a bash-capable type is an explicit trust decision — but the
 * silent one-line self-modification / mail-forgery bypass is closed.
 */

import { isAbsolute, resolve } from "node:path";
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
import { collapseAndCap } from "../text.ts";
import type { TypeConfig } from "../typedefs/parse.ts";
import type { SystemDenyResult } from "./system-deny.ts";

export const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];
const KNOWN = new Set<string>(CODING_TOOL_NAMES);

export interface SandboxPorts {
	/** Hard-deny check for a write target (D20b). Receives an ABSOLUTE path. */
	systemDeny(path: string): SystemDenyResult;
	/** Hard-deny check for a bash command that references a protected path (H1). */
	systemDenyCommand(command: string): SystemDenyResult;
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

function hardDeny(tool: string, reason: string): never {
	throw new Error(
		`Blocked by the teams sandbox: ${reason}. This is a hard denial (${tool}) — do not retry; work within your scope or report the limitation to the main agent.`,
	);
}

function confirmDenied(tool: string, note: string | undefined): never {
	throw new Error(`Your ${tool} call was not approved${note ? `: ${note}` : "."} Adjust your approach; do not retry the same call.`);
}

/** Wrap edit/write: hard system-deny on the target, then human confirmation. */
function wrapPathTool(tool: ToolDefinition, cwd: string, ports: SandboxPorts): ToolDefinition {
	const inner = tool.execute.bind(tool);
	const kind = tool.name === "edit" ? "edit" : "write";
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const path = (params as { path?: unknown }).path;
			if (typeof path !== "string" || path === "") throw new Error(`${tool.name}: missing target path.`);
			// Resolve the target against the SAME cwd the tool writes to, so the
			// deny check and the actual write can't diverge on a relative path (M7).
			const abs = isAbsolute(path) ? path : resolve(cwd, path);
			const deny = ports.systemDeny(abs);
			if (deny.denied) hardDeny(tool.name, deny.reason ?? "protected path");
			const result = await ports.confirm({ tool: kind, path: abs });
			if (!result.approved) confirmDenied(tool.name, result.note);
			// Re-check after the (possibly long) confirmation prompt to shrink the
			// TOCTOU window where a symlink could be swapped into the protected tree (M8).
			const recheck = ports.systemDeny(abs);
			if (recheck.denied) hardDeny(tool.name, recheck.reason ?? "protected path");
			return inner(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

/** Wrap bash: hard system-deny on protected-path references, then human confirmation. */
function wrapBashTool(tool: ToolDefinition, ports: SandboxPorts): ToolDefinition {
	const inner = tool.execute.bind(tool);
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const command = (params as { command?: unknown }).command;
			if (typeof command !== "string") throw new Error("bash: missing command.");
			const deny = ports.systemDenyCommand(command);
			if (deny.denied) hardDeny("bash", deny.reason ?? "protected path");
			const result = await ports.confirm({ tool: "bash", command: collapseAndCap(command, 4096) });
			if (!result.approved) confirmDenied("bash", result.note);
			// No post-confirm re-check (unlike wrapPathTool's TOCTOU re-deny): the deny
			// is a pure text scan of the same immutable command string — re-scanning
			// could not change the verdict.
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
				tools.push(wrapPathTool(createEditToolDefinition(cwd) as ToolDefinition, cwd, ports));
				break;
			case "write":
				tools.push(wrapPathTool(createWriteToolDefinition(cwd) as ToolDefinition, cwd, ports));
				break;
			case "bash":
				tools.push(wrapBashTool(createBashToolDefinition(cwd) as ToolDefinition, ports));
				break;
		}
	}
	return tools;
}
