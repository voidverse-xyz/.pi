/**
 * Claude Code footer/status line: a dim hint on the left, context % on the
 * right. Claude Code shows contextual key hints under the composer; we mirror
 * that with "? for shortcuts" and the model + context on the right.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { padEndVisible, visibleWidth } from "./ansi.ts";

export interface FooterState {
	model: string;
	mode: string;
	directory: string;
	contextPercentUsed: number | null;
	gitBranch?: string;
}

export function renderFooterLine(theme: Theme, width: number, state: FooterState): string[] {
	const modeTag = state.mode && state.mode !== "default" ? theme.fg("accent", `${state.mode} mode · `) : "";
	const left =
		theme.fg("dim", "  ") + modeTag + theme.fg("dim", "? for shortcuts · ⧉ for agents") + theme.fg("dim", state.gitBranch ? `  ${state.gitBranch}` : "");
	let right = "";
	if (state.contextPercentUsed !== null && state.contextPercentUsed > 1) {
		right = theme.fg("dim", `${state.model} · ${Math.max(0, Math.round(100 - state.contextPercentUsed))}% context left`);
	} else {
		right = theme.fg("dim", state.model);
	}
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + rw + 2 >= width) return [left];
	return [padEndVisible(left, width - rw - 2) + right + "  "];
}
