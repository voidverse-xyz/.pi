import assert from "node:assert/strict";
import test from "node:test";
import {
	applyPlanSubagentPolicy,
	extractSuccessfulSpawnAddress,
	isToolAllowedInMode,
	isTrustedTool,
	nextAgentMode,
	parseAgentModeState,
	parseModeCommand,
	parsePlanCommand,
	PLAN_SUBAGENT_TOOL_NAMES,
	restrictedModeTools,
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

function owner(packageName: string, entry: string) {
	return {
		source: `/shared/packages/${packageName}`,
		path: `/shared/packages/${packageName}/${entry}`,
		scope: "user" as const,
		origin: "package" as const,
	};
}

const trustedOwners: TrustedCustomToolOwners = {
	ask_user: owner("pi-questions", "extensions/questions/index.ts"),
	show_files: owner("pi-show-files", "extensions/show-files/index.ts"),
	todo_write: owner("pi-todo", "extensions/todo/index.ts"),
	[SAVE_PLAN_TOOL]: owner("pi-plan", "extensions/plan/index.ts"),
	...Object.fromEntries(
		PLAN_SUBAGENT_TOOL_NAMES.map((name) => [
			name,
			owner("pi-subagents", "extensions/subagents/index.ts"),
		]),
	),
};

const trustedTools: ToolSource[] = [
	builtin("read"),
	builtin("grep"),
	builtin("find"),
	builtin("ls"),
	packageTool("ask_user", "pi-questions", "extensions/questions/index.ts"),
	packageTool("show_files", "pi-show-files", "extensions/show-files/index.ts"),
	packageTool("todo_write", "pi-todo", "extensions/todo/index.ts"),
	packageTool(SAVE_PLAN_TOOL, "pi-plan", "extensions/plan/index.ts"),
	...PLAN_SUBAGENT_TOOL_NAMES.map((name) =>
		packageTool(name, "pi-subagents", "extensions/subagents/index.ts")
	),
];

test("mode commands recognize controls and preserve message text", () => {
	assert.deepEqual(parseModeCommand(""), { kind: "toggle" });
	assert.deepEqual(parseModeCommand(" TOGGLE "), { kind: "toggle" });
	assert.deepEqual(parseModeCommand("status"), { kind: "status" });
	assert.deepEqual(parseModeCommand("on"), { kind: "set", enabled: true });
	assert.deepEqual(parseModeCommand("exit"), { kind: "set", enabled: false });
	assert.deepEqual(parseModeCommand(" explain this API "), {
		kind: "task",
		task: "explain this API",
	});
});

test("mode cycle follows Off, Discuss, Plan, Quick, then Off", () => {
	assert.equal(nextAgentMode("off"), "discuss");
	assert.equal(nextAgentMode("discuss"), "plan");
	assert.equal(nextAgentMode("plan"), "quick");
	assert.equal(nextAgentMode("quick"), "off");
});

test("Plan commands preserve template selection syntax", () => {
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

test("restrictedModeTools applies the exact tool surface for each mode", () => {
	const baseline = [
		"read", "bash", "write", "ask_user", "show_files", "todo_write", "team_spawn",
	];
	assert.deepEqual(
		restrictedModeTools("quick", baseline, trustedTools, trustedOwners),
		["read", "grep", "find", "ls"],
	);
	assert.deepEqual(
		restrictedModeTools("discuss", baseline, trustedTools, trustedOwners),
		["read", "grep", "find", "ls", "ask_user", "show_files"],
	);
	assert.deepEqual(
		restrictedModeTools("plan", baseline, trustedTools, trustedOwners),
		[
			"read", "grep", "find", "ls", "ask_user", "show_files", "todo_write", SAVE_PLAN_TOOL,
			...PLAN_SUBAGENT_TOOL_NAMES,
		],
	);
	assert.deepEqual(
		restrictedModeTools("plan", [], trustedTools, trustedOwners),
		["read", "grep", "find", "ls", SAVE_PLAN_TOOL, ...PLAN_SUBAGENT_TOOL_NAMES],
	);
});

test("trusted-tool policy is provenance-aware and mode-specific", () => {
	for (const tool of trustedTools) assert.equal(isTrustedTool(tool, trustedOwners), true, tool.name);
	const read = trustedTools.find((tool) => tool.name === "read");
	const askUser = trustedTools.find((tool) => tool.name === "ask_user");
	const spawn = trustedTools.find((tool) => tool.name === "subagent_spawn");
	assert.equal(isToolAllowedInMode("quick", read, trustedOwners), true);
	assert.equal(isToolAllowedInMode("quick", askUser, trustedOwners), false);
	assert.equal(isToolAllowedInMode("discuss", askUser, trustedOwners), true);
	assert.equal(isToolAllowedInMode("discuss", spawn, trustedOwners), false);
	assert.equal(isToolAllowedInMode("plan", spawn, trustedOwners), true);
	assert.equal(isToolAllowedInMode("off", undefined, trustedOwners), true);

	assert.equal(
		isTrustedTool({
			name: "read",
			sourceInfo: { source: "/extensions/evil", path: "<builtin:read>", scope: "user", origin: "package" },
		}, trustedOwners),
		false,
	);
	assert.equal(
		isTrustedTool(packageTool("subagent_spawn", "other/pi-subagents", "extensions/subagents/index.ts"), trustedOwners),
		false,
	);
	const wrongScope = packageTool("show_files", "pi-show-files", "extensions/show-files/index.ts");
	wrongScope.sourceInfo.scope = "project";
	assert.equal(isTrustedTool(wrongScope, trustedOwners), false);
});

test("state parsing supports all modes, Plan child scope, and legacy booleans", () => {
	assert.deepEqual(
		parseAgentModeState({
			mode: "plan",
			authorizedPlanPath: "docs/plan.md",
			authorizedProjectRoot: "/project-a",
			selectedPlanSkill: "software-implementation-planning",
			planSubagentAddresses: ["adhoc/one", "typed/main", "adhoc/one", "adhoc/two"],
		}),
		{
			mode: "plan",
			authorizedPlanPath: "docs/plan.md",
			authorizedProjectRoot: "/project-a",
			selectedPlanSkill: "software-implementation-planning",
			planSubagentAddresses: ["adhoc/one", "adhoc/two"],
		},
	);
	assert.deepEqual(parseAgentModeState({ mode: "quick" }), { mode: "quick" });
	assert.deepEqual(parseAgentModeState({ enabled: true }), { mode: "plan" });
	assert.deepEqual(parseAgentModeState({ enabled: false }), { mode: "off" });
	assert.deepEqual(
		parseAgentModeState({ mode: "plan", authorizedPlanPath: "docs/plan.md" }),
		{ mode: "plan" },
	);
	assert.equal(parseAgentModeState({ mode: "build" }), undefined);
});

test("Plan spawn policy rejects typed or persistent agents and forces fresh read-only workers", () => {
	assert.deepEqual(
		applyPlanSubagentPolicy(
			"subagent_spawn",
			{
				prompt: "Inspect the auth flow",
				task: "Find lifecycle risks",
				model: "provider/model",
				thinking: "high",
				tools: ["write", "bash"],
			},
			new Set(),
		),
		{
			allowed: true,
			normalizedInput: {
				prompt: "Inspect the auth flow",
				task: "Find lifecycle risks",
				model: "provider/model",
				thinking: "high",
				lifetime: "oneshot",
				tools: ["read", "grep", "find", "ls"],
			},
		},
	);
	assert.equal(applyPlanSubagentPolicy("subagent_spawn", { type: "reviewer" }, new Set()).allowed, false);
	assert.equal(
		applyPlanSubagentPolicy("subagent_spawn", { prompt: "Review", id: "saved" }, new Set()).allowed,
		false,
	);
	assert.equal(
		applyPlanSubagentPolicy("subagent_spawn", { prompt: "Review", lifetime: "persistent" }, new Set()).allowed,
		false,
	);
});

test("Plan subagent controls are scoped to workers spawned in Plan mode", () => {
	const allowed = new Set(["adhoc/readonly-1"]);
	assert.deepEqual(
		applyPlanSubagentPolicy("subagent_send", { to: "adhoc/readonly-1", text: "Continue" }, allowed),
		{ allowed: true },
	);
	assert.equal(
		applyPlanSubagentPolicy("subagent_send", { to: "coder/main", text: "Continue" }, allowed).allowed,
		false,
	);
	assert.equal(applyPlanSubagentPolicy("subagent_await", {}, allowed).allowed, false);
	assert.deepEqual(
		applyPlanSubagentPolicy(
			"subagent_await",
			{ targets: [{ to: "adhoc/readonly-1", anchorId: "msg_1" }] },
			allowed,
		),
		{ allowed: true },
	);
	assert.equal(
		applyPlanSubagentPolicy(
			"subagent_await",
			{ targets: [{ to: "coder/main", anchorId: "msg_2" }] },
			allowed,
		).allowed,
		false,
	);
	assert.deepEqual(applyPlanSubagentPolicy("subagent_status", {}, allowed), { allowed: true });
	assert.equal(
		applyPlanSubagentPolicy("subagent_status", { address: "coder/main" }, allowed).allowed,
		false,
	);
});

test("successful spawn results add only newly created ad-hoc addresses", () => {
	const content = [{
		type: "text",
		text: JSON.stringify({ address: "adhoc/readonly-1", created: true, state: "working" }),
	}];
	assert.equal(extractSuccessfulSpawnAddress(content, false), "adhoc/readonly-1");
	assert.equal(extractSuccessfulSpawnAddress(content, true), undefined);
	assert.equal(
		extractSuccessfulSpawnAddress([{ type: "text", text: JSON.stringify({ address: "coder/main", created: true }) }], false),
		undefined,
	);
	assert.equal(
		extractSuccessfulSpawnAddress([{ type: "text", text: JSON.stringify({ address: "adhoc/existing", created: false }) }], false),
		undefined,
	);
	assert.equal(extractSuccessfulSpawnAddress([{ type: "text", text: "not json" }], false), undefined);
});
