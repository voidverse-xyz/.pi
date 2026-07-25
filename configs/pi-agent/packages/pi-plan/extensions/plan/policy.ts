import { realpathSync } from "node:fs";

export const SAVE_PLAN_TOOL = "save_plan";

export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export const PLAN_SUBAGENT_TOOL_NAMES = [
	"subagent_spawn",
	"subagent_send",
	"subagent_steer",
	"subagent_await",
	"subagent_cancel",
	"subagent_retire",
	"subagent_status",
] as const;
export const PLAN_SUBAGENT_CODING_TOOLS = [...READ_ONLY_TOOL_NAMES];

const BUILTIN_READ_TOOLS = new Set<string>(READ_ONLY_TOOL_NAMES);
const DISCUSS_CUSTOM_TOOLS = new Set(["ask_user", "show_files"]);
const PLAN_COMPANION_TOOLS = new Set(["ask_user", "show_files", "todo_write"]);
const PLAN_SUBAGENT_TOOLS = new Set<string>(PLAN_SUBAGENT_TOOL_NAMES);
const MAX_PERSISTED_PLAN_SUBAGENTS = 256;
const ADHOC_ADDRESS_RE = /^adhoc\/[a-z0-9][a-z0-9._-]*$/i;

export type AgentMode = "off" | "discuss" | "plan" | "quick";

export interface ToolSource {
	name: string;
	sourceInfo: {
		path: string;
		source: string;
		scope: string;
		origin: string;
	};
}

export interface TrustedCustomToolOwner {
	path: string;
	source: string;
	scope: "user";
	origin: "package";
}

export type TrustedCustomToolOwners = Readonly<Record<string, TrustedCustomToolOwner>>;

export interface AgentModeState {
	mode: AgentMode;
	authorizedPlanPath?: string;
	authorizedProjectRoot?: string;
	selectedPlanSkill?: string;
	planSubagentAddresses?: string[];
}

export type ModeCommand =
	| { kind: "toggle" }
	| { kind: "status" }
	| { kind: "set"; enabled: boolean }
	| { kind: "task"; task: string }
	| { kind: "invalid"; message: string };

export type PlanCommand =
	| Exclude<ModeCommand, { kind: "task" }>
	| { kind: "task"; task: string; skillName?: string };

export type PlanSubagentPolicyDecision =
	| { allowed: true; normalizedInput?: Record<string, unknown> }
	| { allowed: false; reason: string };

function normalizedPath(value: string): string {
	let path = value;
	try {
		path = realpathSync(value);
	} catch {
		// Synthetic paths (for example <builtin:read>) and missing test fixtures fall
		// back to string normalization. Real extension/package paths canonicalize so
		// ~/.pi and ~/.pi/agent shim layouts compare to the same trusted package root.
	}
	return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

const AGENT_MODE_ORDER: AgentMode[] = ["off", "discuss", "plan", "quick"];

function isAgentMode(value: unknown): value is AgentMode {
	return AGENT_MODE_ORDER.includes(value as AgentMode);
}

export function nextAgentMode(mode: AgentMode): AgentMode {
	const currentIndex = AGENT_MODE_ORDER.indexOf(mode);
	return AGENT_MODE_ORDER[(currentIndex + 1) % AGENT_MODE_ORDER.length]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlanSubagentAddress(value: unknown): value is string {
	return typeof value === "string" && ADHOC_ADDRESS_RE.test(value);
}

export function parseModeCommand(args: string): ModeCommand {
	const task = args.trim();
	const action = task.toLowerCase();
	if (!task || action === "toggle") return { kind: "toggle" };
	if (action === "status") return { kind: "status" };
	if (action === "on") return { kind: "set", enabled: true };
	if (action === "off" || action === "exit") return { kind: "set", enabled: false };
	return { kind: "task", task };
}

export function parsePlanCommand(args: string): PlanCommand {
	const command = parseModeCommand(args);
	if (command.kind !== "task") return command;
	const task = command.task;
	if (task === "--skill" || task.startsWith("--skill ") || task.startsWith("--skill=")) {
		const match = task.match(/^--skill(?:=|\s+)([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\s+([\s\S]+))?$/);
		if (!match?.[1]) return { kind: "invalid", message: "Usage: /plan --skill <name> <task>" };
		const selectedTask = match[2]?.trim();
		if (!selectedTask) return { kind: "invalid", message: "A task is required after the Plan skill name" };
		return { kind: "task", task: selectedTask, skillName: match[1] };
	}
	return command;
}

export function parseAgentModeState(value: unknown): AgentModeState | undefined {
	if (!isRecord(value)) return undefined;
	const mode = isAgentMode(value.mode)
		? value.mode
		: typeof value.enabled === "boolean"
			? (value.enabled ? "plan" : "off")
			: undefined;
	if (!mode) return undefined;

	const hasCompleteAuthorization =
		typeof value.authorizedPlanPath === "string"
		&& value.authorizedPlanPath.length > 0
		&& typeof value.authorizedProjectRoot === "string"
		&& value.authorizedProjectRoot.length > 0;
	const planSubagentAddresses = Array.isArray(value.planSubagentAddresses)
		? [...new Set(value.planSubagentAddresses.filter(isPlanSubagentAddress))]
			.slice(0, MAX_PERSISTED_PLAN_SUBAGENTS)
		: [];

	return {
		mode,
		...(hasCompleteAuthorization
			? {
				authorizedPlanPath: value.authorizedPlanPath as string,
				authorizedProjectRoot: value.authorizedProjectRoot as string,
			}
			: {}),
		...(typeof value.selectedPlanSkill === "string" && value.selectedPlanSkill
			? { selectedPlanSkill: value.selectedPlanSkill }
			: {}),
		...(planSubagentAddresses.length > 0 ? { planSubagentAddresses } : {}),
	};
}

export function isTrustedTool(
	tool: ToolSource | undefined,
	trustedCustomTools: TrustedCustomToolOwners,
): boolean {
	if (!tool) return false;
	if (BUILTIN_READ_TOOLS.has(tool.name)) {
		return tool.sourceInfo.source === "builtin"
			&& tool.sourceInfo.path === `<builtin:${tool.name}>`
			&& tool.sourceInfo.scope === "temporary"
			&& tool.sourceInfo.origin === "top-level";
	}
	const owner = trustedCustomTools[tool.name];
	if (!owner) return false;
	return normalizedPath(tool.sourceInfo.source) === normalizedPath(owner.source)
		&& normalizedPath(tool.sourceInfo.path) === normalizedPath(owner.path)
		&& tool.sourceInfo.scope === owner.scope
		&& tool.sourceInfo.origin === owner.origin;
}

export function isToolAllowedInMode(
	mode: AgentMode,
	tool: ToolSource | undefined,
	trustedCustomTools: TrustedCustomToolOwners,
): boolean {
	if (mode === "off") return true;
	if (!isTrustedTool(tool, trustedCustomTools)) return false;
	if (tool && BUILTIN_READ_TOOLS.has(tool.name)) return true;
	if (!tool) return false;
	if (mode === "quick") return false;
	if (mode === "discuss") return DISCUSS_CUSTOM_TOOLS.has(tool.name);
	return PLAN_COMPANION_TOOLS.has(tool.name)
		|| tool.name === SAVE_PLAN_TOOL
		|| PLAN_SUBAGENT_TOOLS.has(tool.name);
}

function existingTrustedNames(
	names: Iterable<string>,
	byName: ReadonlyMap<string, ToolSource>,
	trustedCustomTools: TrustedCustomToolOwners,
): string[] {
	return [...names].filter((name) => isTrustedTool(byName.get(name), trustedCustomTools));
}

export function restrictedModeTools(
	mode: Exclude<AgentMode, "off">,
	activeBeforeRestrictedMode: readonly string[],
	allTools: readonly ToolSource[],
	trustedCustomTools: TrustedCustomToolOwners,
): string[] {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	const coreReadTools = READ_ONLY_TOOL_NAMES.filter((name) =>
		isTrustedTool(byName.get(name), trustedCustomTools)
	);
	if (mode === "quick") return coreReadTools;
	if (mode === "discuss") {
		return [...new Set([
			...coreReadTools,
			...existingTrustedNames(DISCUSS_CUSTOM_TOOLS, byName, trustedCustomTools),
		])];
	}

	const activeCompanionTools = activeBeforeRestrictedMode.filter(
		(name) => PLAN_COMPANION_TOOLS.has(name)
			&& isTrustedTool(byName.get(name), trustedCustomTools),
	);
	return [...new Set([
		...coreReadTools,
		...activeCompanionTools,
		...existingTrustedNames([SAVE_PLAN_TOOL], byName, trustedCustomTools),
		...existingTrustedNames(PLAN_SUBAGENT_TOOL_NAMES, byName, trustedCustomTools),
	])];
}

function targetDecision(
	toolName: string,
	input: Record<string, unknown>,
	allowedAddresses: ReadonlySet<string>,
): PlanSubagentPolicyDecision {
	const target = input.to;
	if (typeof target !== "string" || !allowedAddresses.has(target)) {
		return {
			allowed: false,
			reason: `${toolName} may target only an ad-hoc read-only subagent spawned in Plan mode.`,
		};
	}
	return { allowed: true };
}

export function applyPlanSubagentPolicy(
	toolName: string,
	input: unknown,
	allowedAddresses: ReadonlySet<string>,
): PlanSubagentPolicyDecision {
	if (!PLAN_SUBAGENT_TOOLS.has(toolName)) return { allowed: true };
	if (!isRecord(input)) return { allowed: false, reason: `${toolName} requires an object input.` };

	if (toolName === "subagent_spawn") {
		if (input.type !== undefined) {
			return {
				allowed: false,
				reason: "Plan mode permits only ad-hoc subagents; use prompt instead of type.",
			};
		}
		if (typeof input.prompt !== "string" || !input.prompt.trim()) {
			return {
				allowed: false,
				reason: "Plan mode requires a non-empty ad-hoc prompt for subagent_spawn.",
			};
		}
		if (input.id !== undefined || input.lifetime === "persistent") {
			return {
				allowed: false,
				reason: "Plan mode subagents must be fresh one-shot workers; omit id and use lifetime=oneshot.",
			};
		}
		const { type: _type, id: _id, lifetime: _lifetime, tools: _tools, ...rest } = input;
		return {
			allowed: true,
			normalizedInput: {
				...rest,
				prompt: input.prompt,
				lifetime: "oneshot",
				tools: [...PLAN_SUBAGENT_CODING_TOOLS],
			},
		};
	}

	if (toolName === "subagent_await") {
		if (!Array.isArray(input.targets) || input.targets.length === 0) {
			return {
				allowed: false,
				reason: "Plan mode requires explicit subagent_await targets from Plan-spawned workers.",
			};
		}
		for (const target of input.targets) {
			if (!isRecord(target) || typeof target.to !== "string" || !allowedAddresses.has(target.to)) {
				return {
					allowed: false,
					reason: "Plan mode may await only explicit targets from ad-hoc read-only subagents it spawned.",
				};
			}
		}
		return { allowed: true };
	}

	if (toolName === "subagent_status") {
		if (input.address === undefined) return { allowed: true };
		if (typeof input.address !== "string" || !allowedAddresses.has(input.address)) {
			return {
				allowed: false,
				reason: "Plan mode may inspect details only for an ad-hoc read-only subagent it spawned.",
			};
		}
		return { allowed: true };
	}

	return targetDecision(toolName, input, allowedAddresses);
}

export function extractSuccessfulSpawnAddress(content: unknown, isError: boolean): string | undefined {
	if (isError || !Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } =>
			isRecord(part) && part.type === "text" && typeof part.text === "string"
		)
		.map((part) => part.text)
		.join("\n");
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as { address?: unknown; created?: unknown };
		return parsed.created === true && isPlanSubagentAddress(parsed.address)
			? parsed.address
			: undefined;
	} catch {
		return undefined;
	}
}
