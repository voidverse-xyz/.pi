/**
 * Codex session header — 1:1 clone of codex-rs/tui/src/history_cell/session.rs
 * (SessionHeaderHistoryCell + with_border): a dim rounded card
 *
 *   ╭──────────────────────────────────────────╮
 *   │ >_ OpenAI Codex (v0.1.0)                 │
 *   │                                          │
 *   │ model:     gpt-5 medium   /model to change │
 *   │ directory: ~/project                     │
 *   ╰──────────────────────────────────────────╯
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import { bold, dim, padEndVisible, visibleWidth } from "./ansi.ts";

// codex: SESSION_HEADER_MAX_INNER_WIDTH = 56
const MAX_INNER_WIDTH = 56;

export interface HeaderState {
	version: string;
	model: string;
	reasoning?: string;
	directory: string;
}

function homeRelative(p: string): string {
	const home = os.homedir();
	if (p === home) return "~";
	if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
	return p;
}

/** codex text_formatting::center_truncate_path equivalent (simplified). */
function centerTruncate(s: string, max: number): string {
	if (s.length <= max) return s;
	if (max <= 1) return "…";
	const keep = max - 1;
	const head = Math.ceil(keep / 2);
	const tail = keep - head;
	return s.slice(0, head) + "…" + (tail > 0 ? s.slice(-tail) : "");
}

export function renderHeaderCard(theme: Theme, width: number, state: HeaderState): string[] {
	if (width < 4) return [];
	const inner = Math.min(width - 4, MAX_INNER_WIDTH);

	const cyan = (s: string) => theme.fg("accent", s);

	// Title: ">_ " dim, "OpenAI Codex" bold, "(vX)" dim
	const title = dim(">_ ") + bold("OpenAI Codex") + dim(` (v${state.version})`);

	// Labels padded to the widest label ("directory:")
	const DIR_LABEL = "directory:";
	const modelLabel = "model:".padEnd(DIR_LABEL.length);

	let modelLine =
		dim(`${modelLabel} `) +
		state.model +
		(state.reasoning ? ` ${state.reasoning}` : "") +
		dim("   ") +
		cyan("/model") +
		dim(" to change");

	const dirPrefix = `${DIR_LABEL} `;
	const dirMax = Math.max(0, inner - dirPrefix.length);
	const dirLine = dim(dirPrefix) + centerTruncate(homeRelative(state.directory), dirMax);

	const rows = [title, "", modelLine, dirLine];

	const contentWidth = Math.min(
		Math.max(inner, 0),
		Math.max(...rows.map((r) => visibleWidth(r)), inner),
	);
	const borderInner = contentWidth + 2;

	const out: string[] = [];
	out.push(dim(`╭${"─".repeat(borderInner)}╮`));
	for (const row of rows) {
		out.push(dim("│ ") + padEndVisible(row, contentWidth) + dim(" │"));
	}
	out.push(dim(`╰${"─".repeat(borderInner)}╯`));
	return out;
}
