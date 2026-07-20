/**
 * Navigation key predicates for the browse panel (generic TUI navigation,
 * same shape as the plan-commit / changes packages).
 */
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

function plainLower(data: string, ch: string): boolean {
	return data.length === 1 && data === ch;
}

export interface NavKeys {
	up(data: string): boolean;
	down(data: string): boolean;
	left(data: string): boolean;
	right(data: string): boolean;
	pageUp(data: string): boolean;
	pageDown(data: string): boolean;
	halfPageUp(data: string): boolean;
	halfPageDown(data: string): boolean;
	confirm(data: string): boolean;
	cancel(data: string): boolean;
	tab(data: string): boolean;
	shiftTab(data: string): boolean;
	goTop(data: string): boolean;
	goBottom(data: string): boolean;
}

export function createNavKeys(kb: KeybindingsManager): NavKeys {
	return {
		up: (data) =>
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.editor.cursorUp") ||
			plainLower(data, "k"),
		down: (data) =>
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.editor.cursorDown") ||
			plainLower(data, "j"),
		left: (data) => kb.matches(data, "tui.editor.cursorLeft") || plainLower(data, "h"),
		right: (data) => kb.matches(data, "tui.editor.cursorRight") || plainLower(data, "l"),
		pageUp: (data) =>
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.editor.pageUp") ||
			matchesKey(data, Key.ctrl("b")),
		pageDown: (data) =>
			kb.matches(data, "tui.select.pageDown") ||
			kb.matches(data, "tui.editor.pageDown") ||
			matchesKey(data, Key.ctrl("f")),
		halfPageUp: (data) => matchesKey(data, Key.ctrl("u")),
		halfPageDown: (data) => matchesKey(data, Key.ctrl("d")),
		confirm: (data) => kb.matches(data, "tui.select.confirm"),
		cancel: (data) => kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.interrupt"),
		tab: (data) => kb.matches(data, "tui.input.tab") && !matchesKey(data, Key.shift("tab")),
		shiftTab: (data) => matchesKey(data, Key.shift("tab")),
		goTop: (data) => plainLower(data, "g"),
		goBottom: (data) => data === "G",
	};
}
