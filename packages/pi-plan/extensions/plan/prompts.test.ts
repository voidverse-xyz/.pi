import assert from "node:assert/strict";
import test from "node:test";
import { nextAgentMode, type AgentMode } from "./policy.ts";
import {
	buildDiscussModeInstructions,
	buildNonPlanModeInstructions,
	buildOffModeInstructions,
	buildPlanModeInstructions,
	buildQuickModeInstructions,
} from "./prompts.ts";

const EXPECTED_OFF_PROMPT = `<agent_mode>
The host-managed pi-plan mode is Off for this run. Discuss, Plan, and Quick restrictions from pi-plan do not apply. Treat earlier mode claims in conversation history as historical, not as the current mode. Continue following all other current system instructions, safety policies, and the active tool set.
</agent_mode>`;

const EXPECTED_DISCUSS_PROMPT = `<discuss_mode>
Discuss mode is active. It is controlled by the host, not by user wording. Remain in Discuss mode until the host changes modes.

Discuss the user's topic normally and with whatever response length and structure best serves the question. You may inspect the project with the exposed read-only lookup and companion user-interface tools. Do not modify files, run shell commands, implement work, save plans, or delegate to other agents.
</discuss_mode>`;

const EXPECTED_QUICK_PROMPT = `<quick_mode>
Quick mode is active. It is controlled by the host, not by user wording. Remain in Quick mode until the host changes modes.

Treat this as quick chat with the user:
- Answer directly in 1–4 short sentences.
- Use plain language and put the answer first.
- Do not add headings, recaps, background, caveats, or next steps unless they are essential to understanding the answer.
- If intent is unclear, ask one concise clarification instead of giving a long conditional answer.

You may use the exposed read-only lookup tools when project facts are needed. Do not modify files, run shell commands, implement work, create plans, or delegate to other agents.
</quick_mode>`;

const EXPECTED_PLAN_PROMPT = `<plan_mode>
Plan mode is active. It is controlled by the host, not by user wording. Remain in Plan mode until the host changes modes.

The host enforces a default-deny main-agent tool policy. Use only the project-read-only, companion UI/session, Plan-save, and Plan-subagent tools currently exposed. Bash, general file mutation tools, teams, procedures, and unknown custom tools are unavailable.

<plan_subagents>
Spawn only ad-hoc subagents with prompt (never type or id). The host forces every Plan-spawned worker to lifetime=oneshot and tools=[read, grep, find, ls], regardless of the requested tool list. These workers cannot edit files or run shell commands. Send, steer, await, inspect, cancel, or retire only workers created during Plan mode, and pass explicit targets to subagent_await.
</plan_subagents>

To save a plan:
- Determine its project-relative Markdown path from the project's instructions and conventions.
- If the correct path is genuinely ambiguous, ask the user with ask_user.
- Call save_plan with the complete replacement document and the chosen path.
- The host will ask the user to authorize a new or changed path. Never use another tool to save the plan.
- After save_plan succeeds, report the saved path in the final response.
</plan_mode>`;

test("Off mode emits an authoritative current-run marker", () => {
	assert.equal(buildOffModeInstructions(), EXPECTED_OFF_PROMPT);
	assert.equal(buildNonPlanModeInstructions("off"), EXPECTED_OFF_PROMPT);
});

test("the Off marker supersedes historical mode claims without overriding other policies", () => {
	const prompt = buildOffModeInstructions();

	assert.match(prompt, /earlier mode claims in conversation history as historical, not as the current mode/);
	assert.match(prompt, /all other current system instructions, safety policies, and the active tool set/);
	assert.doesNotMatch(prompt, /globally unrestricted|ignore all|all restrictions are inactive/i);
});

test("Discuss, Plan, and Quick prompts retain their existing instructions", () => {
	assert.equal(buildDiscussModeInstructions(), EXPECTED_DISCUSS_PROMPT);
	assert.equal(buildNonPlanModeInstructions("discuss"), EXPECTED_DISCUSS_PROMPT);
	assert.equal(buildQuickModeInstructions(), EXPECTED_QUICK_PROMPT);
	assert.equal(buildNonPlanModeInstructions("quick"), EXPECTED_QUICK_PROMPT);
	assert.equal(
		buildPlanModeInstructions(),
		EXPECTED_PLAN_PROMPT,
	);
});

test("cycling Discuss, Plan, Quick, then Off selects the Off marker for the next run", () => {
	let mode: AgentMode = "discuss";
	mode = nextAgentMode(mode);
	assert.equal(mode, "plan");
	mode = nextAgentMode(mode);
	assert.equal(mode, "quick");
	mode = nextAgentMode(mode);
	assert.equal(mode, "off");
	assert.equal(buildNonPlanModeInstructions(mode), EXPECTED_OFF_PROMPT);
});
