/**
 * tui/tree-widget.ts — the live workflow progress tree above the editor
 * (adapted from pi-subagents tui/tree-widget.ts):
 *
 *   󰔟 workflow release-check · phase Test · 2 running 1 queued  alt+w stop
 *   ├─ ✓ build (cached)
 *   ├─ ▶ unit-tests · 4 tool uses
 *   │  └ Bash: npm test
 *   └─ ○ integ-tests
 *      log: fanning out test shards
 *
 * Rendered via ctx.ui.setWidget(key, lines, {placement:"aboveEditor"}); hidden
 * (undefined) when no run is active. Pure `renderTreeLines` is unit-tested;
 * the controller re-renders on run events + a poll.
 */

import type { RunSnapshot } from "../run.ts";

/**
 * The human brake: stop the active workflow run. Bound in index.ts and shown
 * in this widget's header — ONE constant so the hint can never advertise a key
 * that isn't bound. `alt+w` is free across the installed extensions (pi-teams
 * alt+s, pi-subagents alt+a, pi-queue alt+q/alt+x, pi-todo alt+d, pi-plan
 * shift+tab; user keybindings take alt+t/alt+m); Esc stays Pi's turn-abort.
 */
export const STOP_KEY = "alt+w";

export const WORKFLOW_ICON = "󰔟";

// Pi drops empty/whitespace-only Text widget rows. A zero-width space renders
// as a visually blank row, preserving one line of padding below the tree.
const BOTTOM_PADDING = "\u200B";

export interface TreeTheme {
	fg(color: string, text: string): string;
}

const STATE_MARKS: Record<string, { mark: string; color: string }> = {
	done: { mark: "", color: "success" },
	cached: { mark: "", color: "success" },
	error: { mark: "", color: "error" },
	running: { mark: "", color: "accent" },
	waiting: { mark: "", color: "warning" },
	queued: { mark: "", color: "dim" },
};

/** Pure: the tree's lines for one render pass. [] when there is no active run. */
export function renderTreeLines(snapshot: RunSnapshot | null, theme: TreeTheme): string[] {
	if (!snapshot || snapshot.status !== "running") return [];
	const running = snapshot.rows.filter((r) => r.state === "running" || r.state === "waiting").length;
	const queued = snapshot.rows.filter((r) => r.state === "queued").length;
	const header =
		theme.fg(
			"accent",
			`${WORKFLOW_ICON} workflow ${snapshot.name}${snapshot.currentPhase ? ` · phase ${snapshot.currentPhase}` : ""}` +
				(running + queued > 0 ? ` · ${running} running${queued > 0 ? ` ${queued} queued` : ""}` : ""),
		) + theme.fg("dim", `  ${STOP_KEY} stop`);
	const lines: string[] = [header];

	snapshot.rows.forEach((row, i) => {
		const last = i === snapshot.rows.length - 1;
		const branch = last ? "└─" : "├─";
		const cont = last ? "   " : "│  ";
		const { mark, color } = STATE_MARKS[row.state] ?? STATE_MARKS.queued!;
		let text = `${theme.fg(color!, mark!)} ${row.label}`;
		if (row.cached) text += theme.fg("dim", " (cached)");
		if (row.activity && row.activity.toolUses > 0) text += theme.fg("muted", ` · ${row.activity.toolUses} tool use${row.activity.toolUses === 1 ? "" : "s"}`);
		if (row.state === "waiting") text += theme.fg("warning", " (awaiting approval)");
		if (row.error) text += theme.fg("error", ` — ${row.error.length > 60 ? `${row.error.slice(0, 59)}…` : row.error}`);
		lines.push(`${theme.fg("dim", branch)} ${text}`);
		const detail = (() => {
			if (row.activity?.summary) return row.activity.summary;
			if (row.state === "queued") return "Waiting for a concurrency slot";
			if (row.state === "cached") return "Replayed from cache";
			if (row.state === "done") return "Complete";
			if (row.state === "error") return row.error || "Failed";
			if (row.state === "waiting") return "Awaiting approval";
			return "Working…";
		})();
		lines.push(theme.fg("dim", `${cont}└ ${detail}`));
	});

	for (const log of snapshot.logs.slice(-2)) {
		lines.push(theme.fg("dim", `   log: ${log}`));
	}
	lines.push(BOTTOM_PADDING);
	return lines;
}

export interface TreeWidgetHost {
	setWidget(key: string, content: string[] | undefined, options: { placement: "aboveEditor" | "belowEditor" }): void;
	theme: TreeTheme;
}

export interface TreeWidgetController {
	refresh(): void;
	dispose(): void;
}

const WIDGET_KEY = "workflow-tree";
const PLACEMENT = { placement: "aboveEditor" as const };

/** Keep the tree card + status line fresh on run events + a poll. */
export function createTreeWidget(getSnapshot: () => RunSnapshot | null, ui: TreeWidgetHost): TreeWidgetController {
	let lastWidget = "";
	const refresh = (): void => {
		const snapshot = getSnapshot();
		const lines = renderTreeLines(snapshot, ui.theme);
		const widgetKey = lines.join("\n");
		if (widgetKey !== lastWidget) {
			lastWidget = widgetKey;
			ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, PLACEMENT);
		}
	};

	const timer = setInterval(refresh, 400);
	(timer as { unref?: () => void }).unref?.();
	refresh();

	return {
		refresh,
		dispose(): void {
			clearInterval(timer);
			ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
		},
	};
}
