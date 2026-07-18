/**
 * tui/tree-widget.ts — the single ambient subagent surface above the editor.
 * The header carries the counts formerly published in the shared footer, then
 * one row per currently-working agent shows its tool-use count and current call:
 *
 *   󰚩 2 running · 1 waiting · 󰇮 3 · alt+a stop
 *   ├─ adhoc/tmp-3f21 · 10 tool uses
 *   │  └ Bash: npm test
 *   └─ scout/main · 3 tool uses
 *      └ Read: src/index.ts
 *
 * A raw component factory (rather than string-array content) preserves the
 * trailing blank padding line after the widget. The widget is hidden when there
 * is no running/waiting activity and no unread main mail.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { SubagentsCore } from "../core.ts";
import type { AgentActivityRow } from "../runtime/types.ts";
import { AGENTS_ICON, emptySnapshot, takeSnapshot, type WidgetSnapshot, widgetSegments } from "./widget.ts";

/**
 * The human brake: stop every working subagent. Bound in index.ts and shown in
 * this widget's header — ONE constant so the hint can never advertise a key that
 * isn't bound. `alt+a` is free across the installed extensions (pi-teams owns
 * alt+s, pi-queue alt+q/alt+x, pi-todo alt+o, pi-plan shift+tab; user
 * keybindings take alt+t/alt+m); Esc stays Pi's own turn-abort.
 */
export const STOP_KEY = "alt+a";

export interface TreeTheme {
	fg(color: string, text: string): string;
}

/** Pure: the widget's lines for one render pass, including bottom padding. */
export function renderTreeLines(rows: AgentActivityRow[], snapshot: WidgetSnapshot, theme: TreeTheme): string[] {
	const segments = widgetSegments(snapshot);
	// Activity is the freshest source during a turn. Fall back to it if the async
	// roster snapshot briefly lags the runtime event that created the rows.
	if (segments.length === 0 && rows.length > 0) segments.push(`${rows.length} running`);
	if (segments.length === 0) return [];

	const working = snapshot.running > 0 || snapshot.waiting > 0 || rows.length > 0;
	const lines: string[] = [
		theme.fg("muted", `${AGENTS_ICON} ${segments.join(" · ")}`) +
		(working ? theme.fg("dim", ` · ${STOP_KEY} stop`) : ""),
	];
	rows.forEach((row, i) => {
		const last = i === rows.length - 1;
		const branch = last ? "└─" : "├─";
		const cont = last ? "   " : "│  ";
		lines.push(theme.fg("text", `${branch} ${row.address} · ${row.toolUses} tool use${row.toolUses === 1 ? "" : "s"}`));
		lines.push(theme.fg("dim", `${cont}└ ${row.summary || "thinking…"}`));
	});
	lines.push("");
	return lines;
}

type TreeWidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export interface TreeWidgetHost {
	setWidget(key: string, content: TreeWidgetFactory | undefined, options: { placement: "aboveEditor" | "belowEditor" }): void;
}

export interface TreeWidgetController {
	dispose(): void;
}

const WIDGET_KEY = "subagents-tree";
const PLACEMENT = { placement: "aboveEditor" as const };

/** Register the tree card and keep it fresh on runtime events + a poll. */
export function createTreeWidget(core: SubagentsCore, ui: TreeWidgetHost): TreeWidgetController {
	let rows: AgentActivityRow[] = [];
	let snapshot = emptySnapshot();
	let last = "";
	let mounted = false;
	let activeTui: TUI | undefined;
	let disposed = false;
	let refreshing = false;
	let refreshQueued = false;

	const mount = (): void => {
		mounted = true;
		ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				activeTui = tui;
				return {
					invalidate() {},
					render(width: number): string[] {
						return renderTreeLines(rows, snapshot, theme).map((line) =>
							line ? truncateToWidth(line, Math.max(1, width), "…") : line,
						);
					},
					dispose() {
						if (activeTui === tui) activeTui = undefined;
					},
				};
			},
			PLACEMENT,
		);
	};

	const unmount = (): void => {
		mounted = false;
		activeTui = undefined;
		ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
	};

	const refresh = (): void => {
		if (disposed) return;
		if (refreshing) {
			refreshQueued = true;
			return;
		}
		refreshing = true;
		void takeSnapshot(core)
			.then((nextSnapshot) => {
				if (disposed) return;
				const nextRows = core.activitySnapshot();
				const key = JSON.stringify([nextRows, nextSnapshot]);
				if (key === last) return;
				last = key;
				rows = nextRows;
				snapshot = nextSnapshot;
				const visible = renderTreeLines(rows, snapshot, { fg: (_color, text) => text }).length > 0;
				if (visible && !mounted) mount();
				else if (!visible && mounted) unmount();
				else if (visible) activeTui?.requestRender();
			})
			.catch(() => {})
			.finally(() => {
				refreshing = false;
				if (refreshQueued) {
					refreshQueued = false;
					refresh();
				}
			});
	};

	const off = core.onEvent(refresh);
	const timer = setInterval(refresh, 400);
	timer.unref?.();
	refresh();

	return {
		dispose(): void {
			disposed = true;
			off();
			clearInterval(timer);
			if (mounted) unmount();
		},
	};
}
