/**
 * tui/tree-widget.ts — the live "Running N subagents…" tree above the editor.
 * One row per currently-working agent with its tool-use count and current tool
 * call:
 *
 *   󰚩 Running 2 subagents…  alt+a stop
 *   ├─ adhoc/tmp-3f21 · 10 tool uses
 *   │  └ Bash: npm test
 *   └─ scout/main · 3 tool uses
 *      └ Read: src/index.ts
 *
 * Rendered via ctx.ui.setWidget(key, lines, { placement: "aboveEditor" }); hidden
 * (undefined) when no agent is working. Pure `renderTreeLines` is unit-tested;
 * the controller re-sets the lines on runtime events + a poll.
 */

import type { SubagentsCore } from "../core.ts";
import type { AgentActivityRow } from "../runtime/types.ts";
import { AGENTS_ICON } from "./widget.ts";

export { AGENTS_ICON };

/**
 * The human brake: stop every working subagent. Bound in index.ts and shown in
 * this widget's header — ONE constant so the hint can never advertise a key that
 * isn't bound. `alt+a` is free across the installed extensions (pi-teams owns
 * alt+s, pi-queue alt+q/alt+x, pi-todo alt+d, pi-plan shift+tab; user
 * keybindings take alt+t/alt+m); Esc stays Pi's own turn-abort.
 */
export const STOP_KEY = "alt+a";

export interface TreeTheme {
	fg(color: string, text: string): string;
}

/** Pure: the tree's lines for one render pass. [] when nothing is working. */
export function renderTreeLines(rows: AgentActivityRow[], theme: TreeTheme): string[] {
	if (rows.length === 0) return [];
	// The stop hint rides the header: the brake is only discoverable while agents are
	// actually running, which is exactly when you need it.
	const lines: string[] = [
		theme.fg("accent", `${AGENTS_ICON} Running ${rows.length} subagent${rows.length === 1 ? "" : "s"}…`) +
			theme.fg("dim", `  ${STOP_KEY} stop`),
	];
	rows.forEach((row, i) => {
		const last = i === rows.length - 1;
		const branch = last ? "└─" : "├─";
		const cont = last ? "   " : "│  ";
		lines.push(theme.fg("text", `${branch} ${row.address} · ${row.toolUses} tool use${row.toolUses === 1 ? "" : "s"}`));
		lines.push(theme.fg("dim", `${cont}└ ${row.summary || "thinking…"}`));
	});
	return lines;
}

export interface TreeWidgetHost {
	setWidget(key: string, content: string[] | undefined, options: { placement: "aboveEditor" | "belowEditor" }): void;
	theme: TreeTheme;
}

export interface TreeWidgetController {
	dispose(): void;
}

const WIDGET_KEY = "subagents-tree";
const PLACEMENT = { placement: "aboveEditor" as const };

/** Register the tree card and keep it fresh on runtime events + a poll. */
export function createTreeWidget(core: SubagentsCore, ui: TreeWidgetHost): TreeWidgetController {
	let last = "";
	const refresh = (): void => {
		const lines = renderTreeLines(core.activitySnapshot(), ui.theme);
		const key = lines.join("\n");
		if (key === last) return; // avoid redundant setWidget churn
		last = key;
		ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, PLACEMENT);
	};

	const off = core.onEvent(refresh);
	const timer = setInterval(refresh, 400);
	timer.unref?.();
	refresh();

	return {
		dispose(): void {
			off();
			clearInterval(timer);
			ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
		},
	};
}
