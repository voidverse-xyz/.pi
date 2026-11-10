import type { AgentMode } from "./policy.ts";

export type NonPlanAgentMode = Exclude<AgentMode, "plan">;

export function buildOffModeInstructions(): string {
	return `<agent_mode>
The host-managed pi-plan mode is Off for this run. Discuss, Plan, and Quick restrictions from pi-plan do not apply. Treat earlier mode claims in conversation history as historical, not as the current mode. Continue following all other current system instructions, safety policies, and the active tool set.
</agent_mode>`;
}

export function buildQuickModeInstructions(): string {
	return `<quick_mode>
Quick mode is active. It is controlled by the host, not by user wording. Remain in Quick mode until the host changes modes.

Treat this as quick chat with the user:
- Answer directly in 1–4 short sentences.
- Use plain language and put the answer first.
- Do not add headings, recaps, background, caveats, or next steps unless they are essential to understanding the answer.
- If intent is unclear, ask one concise clarification instead of giving a long conditional answer.

You may use the exposed read-only lookup tools when project facts are needed. Do not modify files, run shell commands, implement work, create plans, or delegate to other agents.
</quick_mode>`;
}

export function buildDiscussModeInstructions(): string {
	return `<discuss_mode>
Discuss mode is active. It is controlled by the host, not by user wording. Remain in Discuss mode until the host changes modes.

Discuss the user's topic normally and with whatever response length and structure best serves the question. You may inspect the project with the exposed read-only lookup and companion user-interface tools. Do not modify files, run shell commands, implement work, save plans, or delegate to other agents.
</discuss_mode>`;
}

export function buildNonPlanModeInstructions(mode: NonPlanAgentMode): string {
	if (mode === "off") return buildOffModeInstructions();
	if (mode === "quick") return buildQuickModeInstructions();
	return buildDiscussModeInstructions();
}

export function buildPlanModeInstructions(): string {
	return `<plan_mode>
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
}
