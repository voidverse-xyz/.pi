/**
 * Codex footer: "<model> <mode> · <cwd>" (dim), "NN% context left" on the right
 * once context is consumed. Matches Codex CLI v0.143's default status line.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import { dim, padEndVisible, visibleWidth } from "./ansi.ts";

export interface FooterState {
	model: string;
	mode: string;
	directory: string;
	contextPercentUsed: number | null;
	gitBranch?: string;
}

function homeRelative(p: string): string {
	const home = os.homedir();
	if (p === home) return "~";
	if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
	return p;
}

export function renderFooterLine(_theme: Theme, width: number, state: FooterState): string[] {
	const dirText = homeRelative(state.directory) + (state.gitBranch ? ` (${state.gitBranch})` : "");
	const left = dim(`  ${state.model} ${state.mode} · ${dirText}`);
	let right = "";
	if (state.contextPercentUsed !== null && state.contextPercentUsed > 1) {
		right = dim(`${Math.max(0, Math.round(100 - state.contextPercentUsed))}% context left`);
	}
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (rw === 0 || lw + rw + 2 >= width) return [left];
	return [padEndVisible(left, width - rw - 2) + right + "  "];
}
