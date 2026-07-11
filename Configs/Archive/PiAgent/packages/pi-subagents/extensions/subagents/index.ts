/**
 * Subagents — two complementary features over one shared set of agent definitions
 * (markdown files in ~/.pi/agent/agents/*.md and <repo>/.pi/agents/*.md):
 *
 *   1. Foreground switcher (switcher.ts)
 *      Alt+A or /agents opens a picker of the available agents; selecting one
 *      re-skins THIS session (same thread) with that agent's model, tools, and
 *      system prompt. The active agent shows on the footer status line;
 *      /agents main restores defaults.
 *
 *   2. Delegation tool (delegate.ts)
 *      An LLM-callable `delegate` tool the main agent uses to hand a self-contained
 *      task to a specialized agent running in its own isolated `pi` process
 *      (single / parallel / chain). The parent passes full context via the task.
 *
 * Install: symlink or copy this directory to ~/.pi/agent/extensions/subagents/
 *          and the agent files to ~/.pi/agent/agents/. Then /reload (or restart
 *          Pi so the Alt+A shortcut registers).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskParent } from "./ask-parent.ts";
import { registerSubagentTool } from "./delegate.ts";
import { registerSandboxGuard } from "./guard.ts";
import { registerSwitcher } from "./switcher.ts";

export default function subagents(pi: ExtensionAPI) {
	registerSwitcher(pi);
	registerSubagentTool(pi);
	// ask_parent is a spawned-child-only tool (guarded on PI_ASK_PARENT); folded in here
	// so it ships with subagents rather than as a separate extension that imported depth.ts.
	registerAskParent(pi);
	// Sandbox enforcement for children delegate spawned with readOnly/allowedPaths —
	// a no-op unless THIS process carries the sandbox env (see guard.ts).
	registerSandboxGuard(pi);
}
