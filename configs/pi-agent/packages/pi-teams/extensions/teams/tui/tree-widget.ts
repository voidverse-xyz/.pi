/**
 * tui/tree-widget.ts — the live "Running N team agents…" tree above the editor
 * (ref IMG_5778). One row per currently-working agent with its
 * tool-use count, context fill, cumulative token usage, queued mail, and current
 * tool call. Nerd Font icons keep the metrics compact but retain short labels:
 *
 *   󱘎 Running 2 team agents · 󰇮 1 main mail · alt+s stop
 *   ├─ refactorer/auth ·  10 tools ·  41.2% ·  23k tokens · 󰇮 2 mail
 *   │  └ Bash: find CLI or main entry files
 *   └─ docs/main ·  3 tools ·  8.0% ·  6k tokens
 *      └ Read: src/index.ts
 *
 * Rendered as a permanently mounted above-editor component with a trailing blank
 * line whenever visible. Keeping one stable widget-map slot prevents activity
 * refreshes from hopping below the project/Git status row. The component renders
 * nothing when no agent is working and no main mail is unread. Pure
 * `renderTreeLines` is unit-tested; the controller requests a rerender on runtime
 * events + a poll without calling setWidget again.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentsCore } from "../core.ts";
import type { AgentActivityRow } from "../runtime/types.ts";
import { fitThinkingSummary, THINKING_PLACEHOLDER } from "../text.ts";

/**
 * The human brake: stop every working agent (D22). Bound in index.ts and shown in
 * this widget's header — ONE constant so the hint can never advertise a key that
 * isn't bound. `alt+s` is free across the installed extensions (pi-queue owns
 * alt+q/alt+x, pi-plan owns shift+tab); Esc stays Pi's own turn-abort.
 */
export const STOP_KEY = "alt+s";

/** Nerd Font symbols shared across the compact activity metrics. */
export const AGENTS_ICON = "󱘎"; // nf-md-family_tree
export const TOOL_ICON = ""; // nf-oct-terminal
export const CONTEXT_ICON = ""; // nf-fa-hdd_o — requested context-capacity metaphor
export const TOKEN_ICON = ""; // nf-oct-cpu — token activity
export const MAIL_ICON = "󰇮"; // nf-md-email

export interface TreeTheme {
	fg(color: string, text: string): string;
}

function fitActivitySummary(summary: string, max: number): string {
	const fitted = fitThinkingSummary(summary, max, visibleWidth);
	return truncateToWidth(fitted, max, "…");
}

/** Compact cumulative-token label for the narrow ambient tree row. */
function formatTokenCount(tokens: number): string {
	const value = Math.max(0, tokens);
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 1_000_000) {
		const thousands = value / 1_000;
		return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
	}
	const millions = value / 1_000_000;
	return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, "") : Math.round(millions)}m`;
}

/** Pure: the tree's lines for one render pass. [] when idle with no main mail. */
export function renderTreeLines(
	rows: AgentActivityRow[],
	mainUnread: number,
	theme: TreeTheme,
	width = Number.POSITIVE_INFINITY,
): string[] {
	if (rows.length === 0 && mainUnread === 0) return [];
	// The stop hint rides the header only while agents are running. Main mail can
	// keep the widget visible briefly after activity settles, until auto-wake drains it.
	// Muted codex treatment (like the "Working · 5s" message): the tree is ambient
	// status, not an alert — muted label, dim separators/details.
	const running = rows.length > 0 ? `Running ${rows.length} team agent${rows.length === 1 ? "" : "s"}` : "Teams";
	const mainMail = mainUnread > 0 ? ` · ${MAIL_ICON} ${mainUnread} main mail` : "";
	const stop = rows.length > 0 ? ` · ${STOP_KEY} stop` : "";
	const lines: string[] = [theme.fg("muted", `${AGENTS_ICON} ${running}${mainMail}`) + theme.fg("dim", stop)];
	rows.forEach((row, i) => {
		const last = i === rows.length - 1;
		const branch = last ? "└─" : "├─";
		const cont = last ? "   " : "│  ";
		// The display label makes anonymous oneshots readable: worker/tmp-3f9a “lint sweep”.
		const label = row.label ? ` “${row.label}”` : "";
		const context = row.ctxPercent === null ? "?" : `${row.ctxPercent.toFixed(1)}%`;
		const metrics = [
			`${TOOL_ICON} ${row.toolUses} tool${row.toolUses === 1 ? "" : "s"}`,
			`${CONTEXT_ICON} ${context}`,
			`${TOKEN_ICON} ${formatTokenCount(row.tokens)} tokens`,
		];
		if (row.unread > 0) metrics.push(`${MAIL_ICON} ${row.unread} mail`);
		lines.push(theme.fg("text", `${branch} ${row.address}${label} · ${metrics.join(" · ")}`));
		const detailPrefix = `${cont}└ `;
		const summary = row.summary || THINKING_PLACEHOLDER;
		const fittedSummary = Number.isFinite(width)
			? fitActivitySummary(summary, Math.max(1, width - visibleWidth(detailPrefix)))
			: summary;
		lines.push(theme.fg("dim", `${detailPrefix}${fittedSummary}`));
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

const WIDGET_KEY = "teams-tree";
const PLACEMENT = { placement: "aboveEditor" as const };

/** Mount once, then keep the tree fresh without changing its widget-stack slot. */
export function createTreeWidget(core: SubagentsCore, ui: TreeWidgetHost): TreeWidgetController {
	let rows: AgentActivityRow[] = [];
	let mainUnread = 0;
	let last = "";
	let activeTui: TUI | undefined;
	let disposed = false;

	ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			activeTui = tui;
			return {
				invalidate() {},
				render(width: number): string[] {
					return renderTreeLines(rows, mainUnread, theme, Math.max(1, width)).map((line) =>
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

	const refresh = (): void => {
		if (disposed) return;
		const nextRows = core.activitySnapshot();
		const nextMainUnread = core.mainUnreadCount();
		const key = JSON.stringify([nextRows, nextMainUnread]);
		if (key === last) return;
		last = key;
		rows = nextRows;
		mainUnread = nextMainUnread;
		activeTui?.requestRender();
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
			activeTui = undefined;
			ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
		},
	};
}
