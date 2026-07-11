/**
 * codex-core — Codex CLI *functionality* as a standalone, exportable pi plugin.
 *
 * Owns behavior only: slash commands, approval/sandbox policy, multi-agent
 * tools, the plan tool + Plan Mode, and code review. It renders no chrome and
 * sets no theme — instead it emits semantic cards (see contract.ts) and
 * broadcasts state on pi.events, which a *look* plugin (codex-look or
 * claude-look) turns into pixels.
 *
 * Load this together with exactly one look plugin. Swapping the look changes
 * the appearance; this plugin — and all functionality — stays the same.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EVT, type CodexState } from "./contract.ts";
import { registerCommands } from "./commands.ts";
import { registerApprovals } from "./approvals.ts";
import { registerAgents } from "./agents/register.ts";
import { registerPlan, registerReview } from "./plan.ts";

export default function (pi: ExtensionAPI) {
	const state: CodexState = {
		approvalMode: "on-request",
		sandboxMode: "workspace-write",
		mode: "default",
	};

	registerCommands(pi, state);
	registerApprovals(pi, state);
	registerAgents(pi); // declarative .pi/agents/*.md subagents (Phase 1)
	registerPlan(pi, state);
	registerReview(pi);

	// Re-broadcast current state on load so a look plugin that starts after us
	// (or reloads) can sync its footer/widgets.
	pi.on("session_start", async () => {
		pi.events.emit(EVT.mode, state.mode);
		pi.events.emit(EVT.policy, { approval: state.approvalMode, sandbox: state.sandboxMode });
	});
}
