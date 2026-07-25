/**
 * tui/tree-widget.ts — the live procedure progress tree above the editor.
 *
 *    procedure release-check · phase Test · 2 running 1 queued  alt+w stop
 *   ├─ ✓ build (cached)
 *   ├─ ▶ unit-tests ·  4 tools ·  18% ·  12k tokens
 *   │  └ Bash: npm test
 *   └─ ○ integ-tests
 *      … +3 lines · alt+e expand
 *
 * A raw component factory bypasses Pi's 10-line string-widget truncation so
 * the widget can keep its bottom padding row. Long trees render a compact,
 * block-safe preview; alt+e toggles the complete tree. The widget is hidden
 * when no run is active.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { RunSnapshot } from "../run.ts";
import { fitThinkingSummary } from "../text.ts";
import { renderTreeLines, treeNeedsExpansion } from "./tree-render.ts";

export { BOTTOM_PADDING, EXPAND_KEY, STOP_KEY } from "./tree-render.ts";

export type TreeWidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export interface TreeWidgetHost {
	setWidget(key: string, content: TreeWidgetFactory | undefined, options: { placement: "aboveEditor" | "belowEditor" }): void;
}

export interface TreeWidgetController {
	refresh(): void;
	/** Toggle a long tree. False means there is no truncated active tree. */
	toggleExpanded(): boolean;
	dispose(): void;
}

export interface TreeWidgetOptions {
	/** Re-pin UI that must stay below this content widget after it mounts. */
	onMounted?: () => void;
}

const WIDGET_KEY = "procedure-tree";
const PLACEMENT = { placement: "aboveEditor" as const };

function fitActivitySummary(summary: string, max: number): string {
	const fitted = fitThinkingSummary(summary, max, visibleWidth);
	return truncateToWidth(fitted, max, "…");
}

/** Keep the tree card + status line fresh on run events + a poll. */
export function createTreeWidget(
	getSnapshot: () => RunSnapshot | null,
	ui: TreeWidgetHost,
	options: TreeWidgetOptions = {},
): TreeWidgetController {
	let currentSnapshot: RunSnapshot | null = null;
	let expanded = false;
	let lastState = "";
	let mounted = false;
	let lastRenderWidth = Number.POSITIVE_INFINITY;
	let activeTui: TUI | undefined;

	const mount = (): void => {
		mounted = true;
		ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				activeTui = tui;
				return {
					invalidate() {},
					render(width: number): string[] {
						const safeWidth = Math.max(1, width);
						lastRenderWidth = safeWidth;
						return renderTreeLines(currentSnapshot, theme, {
							expanded,
							width: safeWidth,
							fitDetail: fitActivitySummary,
							measure: visibleWidth,
							truncate: truncateToWidth,
						}).map((line) =>
							line ? truncateToWidth(line, safeWidth, "…") : line,
						);
					},
					dispose() {
						if (activeTui === tui) activeTui = undefined;
					},
				};
			},
			PLACEMENT,
		);
		options.onMounted?.();
	};

	const unmount = (): void => {
		mounted = false;
		activeTui = undefined;
		ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
	};

	const refresh = (): void => {
		const snapshot = getSnapshot();
		const activeSnapshot = snapshot?.status === "running" ? snapshot : null;
		if (activeSnapshot?.runId !== currentSnapshot?.runId) expanded = false;
		const state = JSON.stringify([activeSnapshot, expanded]);
		if (state === lastState) return;
		lastState = state;
		currentSnapshot = activeSnapshot;
		if (activeSnapshot && !mounted) mount();
		else if (!activeSnapshot && mounted) unmount();
		else if (mounted) activeTui?.requestRender();
	};

	const timer = setInterval(refresh, 400);
	(timer as { unref?: () => void }).unref?.();
	refresh();

	return {
		refresh,
		toggleExpanded(): boolean {
			const snapshot = getSnapshot();
			if (!treeNeedsExpansion(snapshot, lastRenderWidth, visibleWidth)) return false;
			currentSnapshot = snapshot;
			expanded = !expanded;
			lastState = JSON.stringify([currentSnapshot, expanded]);
			if (!mounted) mount();
			else activeTui?.requestRender();
			return true;
		},
		dispose(): void {
			clearInterval(timer);
			if (mounted) unmount();
			else ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
		},
	};
}
