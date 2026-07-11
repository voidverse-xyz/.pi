/**
 * Navigation key predicates, copied from the plan-commit package (generic TUI
 * navigation). View/action keys (a/u/o/v/f) are matched inline in panel.ts.
 */
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

function plainLower(data: string, ch: string): boolean {
	return data.length === 1 && data === ch;
}

export interface NavKeys {
	up(data: string): boolean;
	down(data: string): boolean;
	pageUp(data: string): boolean;
	pageDown(data: string): boolean;
	halfPageUp(data: string): boolean;
	halfPageDown(data: string): boolean;
	confirm(data: string): boolean;
	cancel(data: string): boolean;
	lineStart(data: string): boolean;
	lineEnd(data: string): boolean;
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

		lineStart: (data) => kb.matches(data, "tui.editor.cursorLineStart"),
		lineEnd: (data) => kb.matches(data, "tui.editor.cursorLineEnd"),

		goTop: (data) => plainLower(data, "g"),
		goBottom: (data) => data === "G",
	};
}
