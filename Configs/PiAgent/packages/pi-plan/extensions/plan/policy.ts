export const SAVE_PLAN_TOOL = "save_plan";

const BUILTIN_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

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

export interface PlanModeState {
	enabled: boolean;
	authorizedPlanPath?: string;
	authorizedProjectRoot?: string;
	selectedPlanSkill?: string;
}

export type PlanCommand =
	| { kind: "toggle" }
	| { kind: "status" }
	| { kind: "set"; enabled: boolean }
	| { kind: "task"; task: string; skillName?: string }
	| { kind: "invalid"; message: string };

function normalizedPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function parsePlanCommand(args: string): PlanCommand {
	const task = args.trim();
	const action = task.toLowerCase();
	if (!task || action === "toggle") return { kind: "toggle" };
	if (action === "status") return { kind: "status" };
	if (action === "on") return { kind: "set", enabled: true };
	if (action === "off" || action === "exit") return { kind: "set", enabled: false };
	if (task === "--skill" || task.startsWith("--skill ") || task.startsWith("--skill=")) {
		const match = task.match(/^--skill(?:=|\s+)([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\s+([\s\S]+))?$/);
		if (!match?.[1]) return { kind: "invalid", message: "Usage: /plan --skill <name> <task>" };
		const selectedTask = match[2]?.trim();
		if (!selectedTask) return { kind: "invalid", message: "A task is required after the Plan skill name" };
		return { kind: "task", task: selectedTask, skillName: match[1] };
	}
	return { kind: "task", task };
}

export function parsePlanModeState(value: unknown): PlanModeState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as {
		enabled?: unknown;
		authorizedPlanPath?: unknown;
		authorizedProjectRoot?: unknown;
		selectedPlanSkill?: unknown;
	};
	if (typeof candidate.enabled !== "boolean") return undefined;
	const hasCompleteAuthorization =
		typeof candidate.authorizedPlanPath === "string"
		&& candidate.authorizedPlanPath.length > 0
		&& typeof candidate.authorizedProjectRoot === "string"
		&& candidate.authorizedProjectRoot.length > 0;
	return {
		enabled: candidate.enabled,
		...(hasCompleteAuthorization
			? {
				authorizedPlanPath: candidate.authorizedPlanPath as string,
				authorizedProjectRoot: candidate.authorizedProjectRoot as string,
			}
			: {}),
		...(typeof candidate.selectedPlanSkill === "string" && candidate.selectedPlanSkill
			? { selectedPlanSkill: candidate.selectedPlanSkill }
			: {}),
	};
}

export function isTrustedPlanTool(
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

export function planModeTools(
	activeBeforePlanMode: readonly string[],
	allTools: readonly ToolSource[],
	trustedCustomTools: TrustedCustomToolOwners,
): string[] {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	const coreReadTools = [...BUILTIN_READ_TOOLS].filter((name) =>
		isTrustedPlanTool(byName.get(name), trustedCustomTools)
	);
	const activeTrustedCustomTools = activeBeforePlanMode.filter(
		(name) => !BUILTIN_READ_TOOLS.has(name)
			&& name !== SAVE_PLAN_TOOL
			&& isTrustedPlanTool(byName.get(name), trustedCustomTools),
	);
	const saveTool = byName.get(SAVE_PLAN_TOOL);
	return [
		...new Set([
			...coreReadTools,
			...activeTrustedCustomTools,
			...(isTrustedPlanTool(saveTool, trustedCustomTools) ? [SAVE_PLAN_TOOL] : []),
		]),
	];
}
