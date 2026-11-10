import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { TimerSnapshot } from "../timer-manager.ts";
import { buildTimerPickerItems, CANCEL_ALL_VALUE } from "./render.ts";

export type TimerPickerResult =
	| { action: "cancel"; timerId: string }
	| { action: "cancel-all" }
	| { action: "closed" };

export interface TimerPickerOptions {
	timers: TimerSnapshot[];
	tui: TUI;
	theme: Theme;
	onDone(result: TimerPickerResult): void;
}

export interface TimerPickerComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
}

export function createTimerPicker(options: TimerPickerOptions): TimerPickerComponent {
	const { timers, tui, theme, onDone } = options;
	const items: SelectItem[] = buildTimerPickerItems(timers, Date.now());

	const border = new DynamicBorder((text: string) => theme.fg("border", text));
	const list = new SelectList(items, Math.min(items.length, 8), {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	}, {
		minPrimaryColumnWidth: 16,
		maxPrimaryColumnWidth: 42,
	});
	let closed = false;

	const finish = (result: TimerPickerResult): void => {
		if (closed) return;
		closed = true;
		onDone(result);
	};
	list.onSelect = (item) => {
		if (item.value === CANCEL_ALL_VALUE) {
			finish({ action: "cancel-all" });
			return;
		}
		if (item.value.startsWith("timer:")) {
			finish({ action: "cancel", timerId: item.value.slice("timer:".length) });
		}
	};
	list.onCancel = () => finish({ action: "closed" });

	return {
		invalidate(): void {
			list.invalidate();
		},
		render(width: number): string[] {
			const clip = (text: string): string => truncateToWidth(text, Math.max(1, width), "…");
			const rule = border.render(width)[0] ?? "";
			return [
				rule,
				clip(theme.fg("accent", theme.bold(`Cancel timer (${timers.length})`))),
				...list.render(width),
				clip(theme.fg("dim", "  ↑↓ move · Enter cancel · Esc close")),
				rule,
			];
		},
		handleInput(data: string): void {
			if (data === "q") {
				finish({ action: "closed" });
				return;
			}
			const forwarded = data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data;
			list.handleInput(forwarded);
			tui.requestRender();
		},
	};
}
