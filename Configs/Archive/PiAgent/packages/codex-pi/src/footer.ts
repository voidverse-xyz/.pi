/**
 * Codex footer — clone of the default status line in Codex CLI (v0.143):
 *   left:  "<model> <mode> · <cwd>" (dim)
 *   right: "NN% context left" (dim) once context is consumed (hidden at 100%)
 * (codex-rs/tui/src/bottom_pane/footer.rs render_footer_from_props; the
 * "? for shortcuts" hint only appears transiently / on ?, not by default.)
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import { dim, padEndVisible, visibleWidth } from "./ansi.ts";

export interface FooterState {
	model: string;
	/** collaboration/approval mode label, e.g. "default" or "plan". */
	mode: string;
	directory: string;
	/** 0-100 percent of context window used, or null if unknown. */
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
		const remaining = Math.max(0, Math.round(100 - state.contextPercentUsed));
		right = dim(`${remaining}% context left`);
	}

	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (rw === 0 || lw + rw + 2 >= width) {
		return [left];
	}
	return [padEndVisible(left, width - rw - 2) + right + "  "];
}
