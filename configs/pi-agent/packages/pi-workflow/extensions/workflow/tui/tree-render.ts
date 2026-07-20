/** Pure workflow-tree rendering and compact/expanded line budgeting. */

import type { RunSnapshot } from "../run.ts";

/** Human controls shown by the workflow widget. */
export const STOP_KEY = "alt+w";
export const EXPAND_KEY = "alt+e";

/** Nerd Fonts Octicons workflow glyph (nf-oct-workflow, U+F52E). */
export const WORKFLOW_ICON = "";

/** Match Pi's string-widget cap while reserving a hint and bottom padding. */
export const MAX_COLLAPSED_LINES = 10;

// A zero-width space makes the visually blank row survive container rendering.
export const BOTTOM_PADDING = "\u200B";

export interface TreeTheme {
	fg(color: string, text: string): string;
}

const STATE_MARKS: Record<string, { mark: string; color: string }> = {
	done: { mark: "", color: "success" },
	cached: { mark: "", color: "success" },
	error: { mark: "", color: "error" },
	running: { mark: "", color: "accent" },
	waiting: { mark: "", color: "warning" },
	queued: { mark: "", color: "dim" },
};

export interface TreeRenderOptions {
	expanded?: boolean;
}

/** Whether the full tree would exceed the compact widget's line budget. */
export function treeNeedsExpansion(snapshot: RunSnapshot | null): boolean {
	if (!snapshot || snapshot.status !== "running") return false;
	return 1 + snapshot.rows.length * 2 + Math.min(snapshot.logs.length, 2) + 1 > MAX_COLLAPSED_LINES;
}

/** Pure: the tree's lines for one render pass. [] when there is no active run. */
export function renderTreeLines(snapshot: RunSnapshot | null, theme: TreeTheme, options: TreeRenderOptions = {}): string[] {
	if (!snapshot || snapshot.status !== "running") return [];
	const expanded = options.expanded === true;
	const needsExpansion = treeNeedsExpansion(snapshot);
	const running = snapshot.rows.filter((r) => r.state === "running" || r.state === "waiting").length;
	const queued = snapshot.rows.filter((r) => r.state === "queued").length;
	const expandHint = needsExpansion ? ` · ${EXPAND_KEY} ${expanded ? "collapse" : "expand"}` : "";
	const header =
		theme.fg(
			"accent",
			`${WORKFLOW_ICON} workflow ${snapshot.name}${snapshot.currentPhase ? ` · phase ${snapshot.currentPhase}` : ""}` +
				(running + queued > 0 ? ` · ${running} running${queued > 0 ? ` ${queued} queued` : ""}` : ""),
		) + theme.fg("dim", `  ${STOP_KEY} stop${expandHint}`);

	const agentBlocks = snapshot.rows.map((row, i): [string, string] => {
		const last = i === snapshot.rows.length - 1;
		const branch = last ? "└─" : "├─";
		const cont = last ? "   " : "│  ";
		const { mark, color } = STATE_MARKS[row.state] ?? STATE_MARKS.queued!;
		let text = `${theme.fg(color!, mark!)} ${row.label}`;
		if (row.cached) text += theme.fg("dim", " (cached)");
		if (row.activity && row.activity.toolUses > 0) text += theme.fg("muted", ` · ${row.activity.toolUses} tool use${row.activity.toolUses === 1 ? "" : "s"}`);
		if (row.state === "waiting") text += theme.fg("warning", " (awaiting approval)");
		if (row.error) text += theme.fg("error", ` — ${row.error.length > 60 ? `${row.error.slice(0, 59)}…` : row.error}`);
		const detail = (() => {
			if (row.activity?.summary) return row.activity.summary;
			if (row.state === "queued") return "Waiting for a concurrency slot";
			if (row.state === "cached") return "Replayed from cache";
			if (row.state === "done") return "Complete";
			if (row.state === "error") return row.error || "Failed";
			if (row.state === "waiting") return "Awaiting approval";
			return "Working…";
		})();
		return [`${theme.fg("dim", branch)} ${text}`, theme.fg("dim", `${cont}└ ${detail}`)];
	});
	const logLines = snapshot.logs.slice(-2).map((log) => theme.fg("dim", `   log: ${log}`));
	const fullLines = [header, ...agentBlocks.flat(), ...logLines, BOTTOM_PADDING];
	if (expanded || !needsExpansion) return fullLines;

	// Preserve whole two-line agent blocks. The hint and raw blank row stay at
	// the tail instead of being replaced by Pi's generic truncation marker.
	const lines = [header];
	const contentLimit = MAX_COLLAPSED_LINES - 2;
	let shownRows = 0;
	for (const block of agentBlocks) {
		if (lines.length + block.length > contentLimit) break;
		lines.push(...block);
		shownRows++;
	}
	let shownLogs = 0;
	if (shownRows === agentBlocks.length) {
		for (const line of logLines) {
			if (lines.length + 1 > contentLimit) break;
			lines.push(line);
			shownLogs++;
		}
	}
	const hiddenLines = (agentBlocks.length - shownRows) * 2 + (logLines.length - shownLogs);
	lines.push(theme.fg("dim", `   … +${hiddenLines} line${hiddenLines === 1 ? "" : "s"} · ${EXPAND_KEY} expand`));
	lines.push(BOTTOM_PADDING);
	return lines;
}
