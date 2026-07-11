/**
 * Claude Code welcome header — matched to the real v2.x banner:
 *
 *   ╭─── Claude Code v0.1.0 ───────────────────────────────────╮
 *   │                              │ Tips for getting started    │
 *   │      Welcome back!           │ Ask Claude to build a feature│
 *   │                              │ ────────────────────────────│
 *   │        ▐▛███▜▌               │ What's new                  │
 *   │       ▝▜█████▛▘              │ • codex-core functionality  │
 *   │         ▘▘ ▝▝                │ • swappable look plugins    │
 *   │   <model> · <cwd>            │ /help for more              │
 *   ╰──────────────────────────────────────────────────────────╯
 *
 * Title sits on the top border; two columns split by a vertical rule; gray
 * border with the rose accent used only for the title and the mascot.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";
import { padEndVisible, visibleWidth } from "./ansi.ts";

const MAX_INNER = 100;

function fit(s: string, width: number): string {
	return visibleWidth(s) > width ? truncateToWidth(s, width) : s;
}

export interface HeaderState {
	version: string;
	model: string;
	directory: string;
}

function homeRelative(p: string): string {
	const home = os.homedir();
	if (p === home) return "~";
	if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
	return p;
}

function center(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return s;
	const left = Math.floor((width - w) / 2);
	return " ".repeat(left) + s + " ".repeat(width - w - left);
}

export function renderHeaderCard(theme: Theme, width: number, state: HeaderState): string[] {
	if (width < 20) return [];
	const inner = Math.min(width - 4, MAX_INNER);
	const b = (s: string) => theme.fg("borderMuted", s);
	const accent = (s: string) => theme.fg("accent", s);
	const muted = (s: string) => theme.fg("muted", s);

	const leftW = Math.floor(inner / 2) - 1;
	const rightW = inner - leftW - 3; // 3 = " │ " divider

	// Left column: welcome, block mascot, model · cwd
	const mascot = ["▐▛███▜▌", "▝▜█████▛▘", "▘▘ ▝▝"];
	const left = [
		"",
		theme.bold("Welcome back!"),
		"",
		...mascot.map((m) => accent(m)),
		"",
		`${state.model}`,
		homeRelative(state.directory),
	].map((r) => center(r, leftW));

	// Right column: tips + what's new
	const right = [
		accent(theme.bold("Tips for getting started")),
		muted("Ask Claude to build a feature or fix a bug"),
		b("─".repeat(rightW)),
		accent(theme.bold("What's new")),
		muted("• Codex functionality via codex-core"),
		muted("• Swappable look plugins (this is claude-look)"),
		muted("/help for more"),
		"",
	].map((r) => padEndVisible(r, rightW));

	const rows = Math.max(left.length, right.length);
	const out: string[] = [];
	// Title on top border
	const title = ` Claude Code v${state.version} `;
	const dash = "─";
	const afterTitle = inner + 2 - 3 - visibleWidth(title);
	out.push(b(`╭${dash.repeat(3)}`) + accent(theme.bold(title)) + b(dash.repeat(Math.max(0, afterTitle)) + "╮"));
	for (let i = 0; i < rows; i++) {
		const l = padEndVisible(fit(left[i] ?? "", leftW), leftW);
		const r = padEndVisible(fit(right[i] ?? "", rightW), rightW);
		out.push(b("│ ") + l + b(" │ ") + r + b(" │"));
	}
	out.push(b(`╰${dash.repeat(inner + 2)}╯`));
	return out;
}
