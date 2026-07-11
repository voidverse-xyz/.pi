/**
 * codex-look widgets — the live sub-agent status list and the goal line above
 * the editor. Driven by codex-core's event-bus broadcasts (EVT.agents/goal),
 * so the look owns the pixels while core owns the state.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { dim } from "./ansi.ts";
import { EVT, type AgentSummary } from "./contract.ts";

export function registerWidgets(pi: ExtensionAPI, getCtx: () => ExtensionContext | undefined) {
	let agentList: AgentSummary[] = [];
	let goal: string | null = null;

	const dot = (theme: Theme, a: AgentSummary): string => {
		if (a.closed) return theme.fg("muted", "○");
		if (a.status.startsWith("errored")) return theme.fg("error", "●");
		if (a.status === "completed") return theme.fg("success", "●");
		if (a.status === "running") return theme.fg("warning", "●");
		return theme.fg("dim", "○");
	};

	const refresh = () => {
		const ctx = getCtx();
		if (!ctx || ctx.mode !== "tui") return;
		if (agentList.length === 0) {
			ctx.ui.setWidget("codex-agents", undefined);
		} else {
			ctx.ui.setWidget(
				"codex-agents",
				(_tui, theme: Theme) => ({
					render(): string[] {
						const lines = [theme.fg("dim", "  agents")];
						for (const a of agentList) {
							const name = a.role ? `${a.nickname} ${theme.fg("dim", `[${a.role}]`)}` : a.nickname;
							lines.push(`  ${dot(theme, a)} ${name} ${theme.fg("dim", "· " + a.status)}`);
						}
						return lines;
					},
					invalidate() {},
				}),
				{ placement: "aboveEditor" },
			);
		}
		ctx.ui.setWidget("codex-goal", goal ? [dim("  goal: ") + goal] : undefined, { placement: "aboveEditor" });
	};

	pi.events.on(EVT.agents, (data) => {
		agentList = (data as AgentSummary[]) ?? [];
		refresh();
	});
	pi.events.on(EVT.goal, (data) => {
		goal = (data as string | null) ?? null;
		refresh();
	});

	return { refresh };
}
