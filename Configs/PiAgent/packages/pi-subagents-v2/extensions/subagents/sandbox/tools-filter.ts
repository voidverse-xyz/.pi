/**
 * sandbox/tools-filter.ts — map a type's frontmatter (tools / readOnly /
 * writePaths / denyPaths, 04-type-schema) onto the ACTUAL tool set handed to
 * `createAgentSession` (the Phase 5 seam in runtime/in-process.ts).
 *
 * How the mapping rides createAgentSession options: the runtime passes
 * `noTools: "builtin"` (Pi's default read/bash/edit/write are disabled) and
 * everything the agent gets arrives via `customTools`:
 *   - the subagent mail trio (tools/sub-agent.ts) — ALWAYS present, appended
 *     by the runtime,
 *   - this module's sandboxed coding tools: Pi's own tool definitions from
 *     the exported create*ToolDefinition factories, with the mutating ones
 *     (edit / write / bash) wrapped so every target goes through
 *     sandbox/paths.ts + sandbox/bash-guard.ts first.
 *
 * Selection rules:
 *   - tools allowlist → subset of the seven coding tools (unknown names are
 *     a hard error — a typo must not silently drop or grant capability).
 *   - readOnly → edit/write are ABSENT (not wrapped-and-denying: the LLM
 *     never sees the verbs) and bash is guarded in readOnly mode; the rest
 *     of the read-only set (read/grep/find/ls) passes through.
 *   - writePaths/denyPaths → edit/write/bash wrapped with the path policy.
 *
 * Verdict handling inside a wrapped tool:
 *   allowed  → delegate to Pi's real tool
 *   denied   → throw (the agent loop turns a tool throw into an error tool
 *              result the LLM reacts to)
 *   escalate → block on EscalationManager.request(); approve → delegate,
 *              deny → throw with the deny note (D22 deny-with-note)
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
import { classifyBashCommand } from "./bash-guard.ts";
import { checkWrite, type PathPolicy, type WriteCheck } from "./paths.ts";
import type { EscalationResolution } from "./escalation.ts";

/** All coding tools a subagent can be granted (SDK ToolName set). */
export const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

/** The readOnly subset: no mutating verbs; bash stays but hard-guarded. */
export const READ_ONLY_TOOL_NAMES: readonly CodingToolName[] = ["read", "bash", "grep", "find", "ls"];

/** What the wrapped tools need from the runtime (escalation + policy). */
export interface SandboxPorts {
	/** Path policy for this agent (systemDenyPrefixes + realpath included). */
	policy: PathPolicy;
	/**
	 * Raise an escalation and block until the human decides (or the turn
	 * aborts — the promise then rejects and the tool unwinds).
	 */
	escalate: (
		input: { tool: string; inputSummary: string; reason: string },
		signal: AbortSignal | undefined,
	) => Promise<EscalationResolution>;
}

/**
 * Resolve the type's tool-name selection (allowlist ∩ mode set). Unknown
 * names fail loud — surfaced as a spawn/wake error.
 */
export function selectToolNames(config: Pick<TypeConfig, "name" | "tools" | "readOnly">): CodingToolName[] {
	const base: readonly CodingToolName[] = config.readOnly ? READ_ONLY_TOOL_NAMES : CODING_TOOL_NAMES;
	if (config.tools === undefined) return [...base];
	const known = new Set<string>(CODING_TOOL_NAMES);
	const unknown = config.tools.filter((name) => !known.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Type "${config.name}": unknown tool name(s) ${unknown.map((n) => `"${n}"`).join(", ")} — ` +
				`allowed: ${CODING_TOOL_NAMES.join(", ")} (04-type-schema).`,
		);
	}
	// readOnly beats the allowlist: mutating verbs stay absent (D20 precedence).
	return [...base].filter((name) => config.tools!.includes(name));
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

function summarize(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Gate one mutation through the sandbox: allowed → return; denied → throw;
 * escalate → block on the human, deny-with-note → throw with the note.
 */
async function gate(
	check: { verdict: "allowed" } | { verdict: "denied" | "escalate"; reason: string },
	tool: string,
	inputSummary: string,
	ports: SandboxPorts,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (check.verdict === "allowed") return;
	if (check.verdict === "denied") {
		throw new Error(
			`Blocked by this agent's sandbox: ${check.reason}. This is a hard denial — do not retry; ` +
				"work within your declared scope or report the limitation to the main agent.",
		);
	}
	const resolution = await ports.escalate({ tool, inputSummary, reason: check.reason }, signal);
	if (resolution.approved) return;
	throw new Error(
		`The human DENIED your escalated ${tool} call (blocked by: ${check.reason}).` +
			(resolution.note !== null ? ` Note from the denial: ${resolution.note}` : "") +
			" Adjust your approach; do not retry the same call.",
	);
}

/** Wrap a mutating file tool (edit/write): its `path` param is the target. */
function wrapPathTool(tool: ToolDefinition, ports: SandboxPorts): ToolDefinition {
	const inner = tool.execute.bind(tool);
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const path = (params as { path?: unknown }).path;
			if (typeof path !== "string" || path === "") {
				throw new Error(`${tool.name}: missing target path.`);
			}
			await gate(checkWrite(path, ports.policy), tool.name, path, ports, signal);
			return inner(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

/** Wrap bash with the D20 mutation heuristics. */
function wrapBashTool(tool: ToolDefinition, readOnly: boolean, ports: SandboxPorts): ToolDefinition {
	const inner = tool.execute.bind(tool);
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const command = (params as { command?: unknown }).command;
			if (typeof command !== "string") {
				throw new Error("bash: missing command.");
			}
			const verdict = classifyBashCommand(command, {
				readOnly,
				checkWrite: (path) => checkWrite(path, ports.policy),
			});
			const mapped: WriteCheck =
				verdict.verdict === "allow"
					? { verdict: "allowed" }
					: verdict.verdict === "deny"
						? { verdict: "denied", reason: verdict.reason }
						: { verdict: "escalate", reason: verdict.reason };
			await gate(mapped, "bash", summarize(command), ports, signal);
			return inner(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Build the sandboxed coding toolset for one agent session. `cwd` anchors
 * Pi's own tool factories; the policy in `ports` anchors the guards.
 */
export function buildSandboxedTools(config: TypeConfig, cwd: string, ports: SandboxPorts): ToolDefinition[] {
	const names = selectToolNames(config);
	// NOTE: even an unrestricted type (no writePaths/denyPaths, not readOnly)
	// keeps the wrappers — its policy is default-cwd, and mutations outside
	// the project or into the subagent system tree must still deny/escalate.
	// There is never a truly unguarded mutating tool.
	const tools: ToolDefinition[] = [];
	for (const name of names) {
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
				tools.push(wrapBashTool(createBashToolDefinition(cwd) as ToolDefinition, config.readOnly, ports));
				break;
		}
	}
	return tools;
}
