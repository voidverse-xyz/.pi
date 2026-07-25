import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { TimerManager } from "../timer-manager.ts";
import { renderTimerWidgetLines } from "./render.ts";

const WIDGET_KEY = "timers-tree";
const PLACEMENT = { placement: "aboveEditor" as const };
const COUNTDOWN_REFRESH_MS = 1_000;

type TimerWidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export interface TimerWidgetHost {
	setWidget(key: string, content: TimerWidgetFactory | undefined, options: typeof PLACEMENT): void;
}

export interface TimerWidgetController {
	refresh(): void;
	dispose(): void;
}

/** Mount one stable above-editor tree and refresh its live countdown once a second. */
export function createTimerWidget(manager: TimerManager, ui: TimerWidgetHost): TimerWidgetController {
	let activeTui: TUI | undefined;
	let disposed = false;

	ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			activeTui = tui;
			return {
				invalidate() {},
				render(width: number): string[] {
					return renderTimerWidgetLines(manager.list(), Date.now(), theme).map((line) =>
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

	const countdownTimer = setInterval(() => activeTui?.requestRender(), COUNTDOWN_REFRESH_MS);
	countdownTimer.unref?.();

	return {
		refresh(): void {
			if (!disposed) activeTui?.requestRender();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearInterval(countdownTimer);
			activeTui = undefined;
			ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
		},
	};
}
