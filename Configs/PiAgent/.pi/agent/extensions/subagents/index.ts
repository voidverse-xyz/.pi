/**
 * Subagents — two complementary features over one shared set of agent definitions
 * (markdown files in ~/.pi/agent/agents/*.md and <repo>/.pi/agents/*.md):
 *
 *   1. Foreground switcher (switcher.ts)
 *      Alt+A or /subagent opens a picker of the available agents; selecting one
 *      re-skins THIS session (same thread) with that agent's model, tools, and
 *      system prompt. The active agent shows on the footer status line;
 *      /subagent main restores defaults.
 *
 *   2. Delegation tool (delegate.ts)
 *      An LLM-callable `subagent` tool the main agent uses to hand a self-contained
 *      task to a specialized agent running in its own isolated `pi` process
 *      (single / parallel / chain). The parent passes full context via the task.
 *
 * Install: symlink or copy this directory to ~/.pi/agent/extensions/subagents/
 *          and the agent files to ~/.pi/agent/agents/. Then /reload (or restart
 *          Pi so the Alt+A shortcut registers).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "./delegate.ts";
import { registerSwitcher } from "./switcher.ts";

export default function subagents(pi: ExtensionAPI) {
	registerSwitcher(pi);
	registerSubagentTool(pi);
}
