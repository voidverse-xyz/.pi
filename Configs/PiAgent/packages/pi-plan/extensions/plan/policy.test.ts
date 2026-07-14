import assert from "node:assert/strict";
import test from "node:test";
import {
	isTrustedPlanTool,
	parsePlanCommand,
	parsePlanModeState,
	planModeTools,
	SAVE_PLAN_TOOL,
	type ToolSource,
	type TrustedCustomToolOwners,
} from "./policy.ts";

function builtin(name: string): ToolSource {
	return {
		name,
		sourceInfo: {
			source: "builtin",
			path: `<builtin:${name}>`,
			scope: "temporary",
			origin: "top-level",
		},
	};
}

function packageTool(name: string, packageName: string, entry: string): ToolSource {
	return {
		name,
		sourceInfo: {
			source: `/shared/packages/${packageName}`,
			path: `/shared/packages/${packageName}/${entry}`,
			scope: "user",
			origin: "package",
		},
	};
}

const trustedOwners: TrustedCustomToolOwners = {
	ask_user: {
		source: "/shared/packages/pi-questions",
		path: "/shared/packages/pi-questions/extensions/questions/index.ts",
		scope: "user",
		origin: "package",
	},
	show_files: {
		source: "/shared/packages/pi-show-files",
		path: "/shared/packages/pi-show-files/extensions/show-files/index.ts",
		scope: "user",
		origin: "package",
	},
	[SAVE_PLAN_TOOL]: {
		source: "/shared/packages/pi-plan",
		path: "/shared/packages/pi-plan/extensions/plan/index.ts",
		scope: "user",
		origin: "package",
	},
};

const trustedTools: ToolSource[] = [
	builtin("read"),
	builtin("grep"),
	builtin("find"),
	builtin("ls"),
	packageTool("ask_user", "pi-questions", "extensions/questions/index.ts"),
	packageTool("show_files", "pi-show-files", "extensions/show-files/index.ts"),
	packageTool(SAVE_PLAN_TOOL, "pi-plan", "extensions/plan/index.ts"),
];

test("parsePlanCommand recognizes controls and preserves task text", () => {
	assert.deepEqual(parsePlanCommand(""), { kind: "toggle" });
	assert.deepEqual(parsePlanCommand(" TOGGLE "), { kind: "toggle" });
	assert.deepEqual(parsePlanCommand("status"), { kind: "status" });
	assert.deepEqual(parsePlanCommand("on"), { kind: "set", enabled: true });
	assert.deepEqual(parsePlanCommand("exit"), { kind: "set", enabled: false });
	assert.deepEqual(parsePlanCommand(" design auth migration "), {
		kind: "task",
		task: "design auth migration",
	});
	assert.deepEqual(parsePlanCommand("--skill software-implementation-planning design auth migration"), {
		kind: "task",
		task: "design auth migration",
		skillName: "software-implementation-planning",
	});
	assert.deepEqual(parsePlanCommand("--skill=general-planning plan a conference"), {
		kind: "task",
		task: "plan a conference",
		skillName: "general-planning",
	});
	assert.deepEqual(parsePlanCommand("--skill general-planning"), {
		kind: "invalid",
		message: "A task is required after the Plan skill name",
	});
});

test("planModeTools keeps only exact trusted definitions and save_plan", () => {
	assert.deepEqual(
		planModeTools(
			["read", "bash", "write", "ask_user", "show_files", "subagent_spawn"],
			trustedTools,
			trustedOwners,
		),
		["read", "grep", "find", "ls", "ask_user", "show_files", SAVE_PLAN_TOOL],
	);
	assert.deepEqual(
		planModeTools([], trustedTools, trustedOwners),
		["read", "grep", "find", "ls", SAVE_PLAN_TOOL],
	);
});

test("trusted-tool policy rejects name, path, source, scope, and origin collisions", () => {
	for (const tool of trustedTools) assert.equal(isTrustedPlanTool(tool, trustedOwners), true, tool.name);
	assert.equal(
		isTrustedPlanTool({
			name: "read",
			sourceInfo: { source: "/extensions/evil", path: "<builtin:read>", scope: "user", origin: "package" },
		}, trustedOwners),
		false,
	);
	assert.equal(
		isTrustedPlanTool(packageTool(SAVE_PLAN_TOOL, "other/pi-plan", "extensions/plan/index.ts"), trustedOwners),
		false,
	);
	assert.equal(
		isTrustedPlanTool(packageTool("ask_user", "pi-questions", "extensions/other/index.ts"), trustedOwners),
		false,
	);
	const wrongScope = packageTool("show_files", "pi-show-files", "extensions/show-files/index.ts");
	wrongScope.sourceInfo.scope = "project";
	assert.equal(isTrustedPlanTool(wrongScope, trustedOwners), false);
	assert.equal(isTrustedPlanTool(undefined, trustedOwners), false);
});

test("parsePlanModeState requires path and canonical project root together", () => {
	assert.deepEqual(
		parsePlanModeState({
			enabled: true,
			authorizedPlanPath: "docs/plan.md",
			authorizedProjectRoot: "/project-a",
			selectedPlanSkill: "software-implementation-planning",
		}),
		{
			enabled: true,
			authorizedPlanPath: "docs/plan.md",
			authorizedProjectRoot: "/project-a",
			selectedPlanSkill: "software-implementation-planning",
		},
	);
	assert.deepEqual(parsePlanModeState({ enabled: false }), { enabled: false });
	assert.deepEqual(
		parsePlanModeState({ enabled: true, authorizedPlanPath: "docs/plan.md" }),
		{ enabled: true },
	);
	assert.equal(parsePlanModeState({ enabled: "yes" }), undefined);
});
