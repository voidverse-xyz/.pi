/** Pure procedure-tree rendering and compact/expanded line budgeting. */

import type { AgentRow, RunSnapshot } from "../run.ts";

/** Human controls shown by the procedure widget. */
export const STOP_KEY = "alt+w";
export const EXPAND_KEY = "alt+e";

/** Nerd Font symbols shared with the teams/subagents activity widgets. */
export const PROCEDURE_ICON = "";
export const TOOL_ICON = "";
export const CONTEXT_ICON = "";
export const TOKEN_ICON = "";

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
	width?: number;
	fitDetail?: (detail: string, max: number) => string;
	measure?: (text: string) => number;
	truncate?: (text: string, max: number, ellipsis?: string) => string;
}

interface ActivityMetrics {
	verbose: string;
	compact: string;
}

function plainWidth(text: string): number {
	return Array.from(text).length;
}

function truncatePlain(text: string, max: number, ellipsis = "…"): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	const suffix = max > plainWidth(ellipsis) ? ellipsis : "";
	return chars.slice(0, Math.max(0, max - plainWidth(suffix))).join("") + suffix;
}

/** Match the compact cumulative-token labels used by pi-subagents. */
function formatTokens(count: number): string {
	const safe = Math.max(0, Math.round(count));
	if (safe < 1_000) return String(safe);
	if (safe < 10_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000) return `${Math.round(safe / 1_000)}k`;
	if (safe < 10_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${Math.round(safe / 1_000_000)}M`;
}

function activityMetrics(row: AgentRow): ActivityMetrics | null {
	if (!row.activity) return null;
	const { toolUses, tokens, ctxPercent } = row.activity;
	const context = ctxPercent === null ? "?" : `${Math.round(ctxPercent)}%`;
	return {
		verbose: [
			`${TOOL_ICON} ${toolUses} tool${toolUses === 1 ? "" : "s"}`,
			`${CONTEXT_ICON} ${context}`,
			`${TOKEN_ICON} ${formatTokens(tokens)} tokens`,
		].join(" · "),
		compact: `${TOOL_ICON} ${toolUses} · ${CONTEXT_ICON} ${context} · ${TOKEN_ICON} ${formatTokens(tokens)}`,
	};
}

function metricsNeedOwnLine(row: AgentRow, width: number, measure: (text: string) => number): boolean {
	const metrics = activityMetrics(row);
	if (!metrics || !Number.isFinite(width)) return false;
	const labelBudget = width - measure("├─ ") - measure(` · ${metrics.verbose}`);
	return labelBudget < 8;
}

function agentBlockLineCount(row: AgentRow, width: number, measure: (text: string) => number): number {
	return metricsNeedOwnLine(row, width, measure) ? 3 : 2;
}

/** Whether the full tree would exceed the compact widget's line budget. */
export function treeNeedsExpansion(
	snapshot: RunSnapshot | null,
	width = Number.POSITIVE_INFINITY,
	measure: (text: string) => number = plainWidth,
): boolean {
	if (!snapshot || snapshot.status !== "running") return false;
	const agentLines = snapshot.rows.reduce((total, row) => total + agentBlockLineCount(row, width, measure), 0);
	return 1 + agentLines + Math.min(snapshot.logs.length, 2) + 1 > MAX_COLLAPSED_LINES;
}

function rowStatusText(row: AgentRow, theme: TreeTheme): string {
	const state = STATE_MARKS[row.state] ?? STATE_MARKS.queued!;
	let text = `${theme.fg(state.color, state.mark)} ${row.label}`;
	if (row.cached) text += theme.fg("dim", " (cached)");
	if (row.state === "waiting") text += theme.fg("warning", " (awaiting approval)");
	if (row.error) text += theme.fg("error", ` — ${row.error.length > 60 ? `${row.error.slice(0, 59)}…` : row.error}`);
	return text;
}

function rowDetail(row: AgentRow): string {
	if (row.activity?.summary) return row.activity.summary;
	if (row.state === "queued") return "Waiting for a concurrency slot";
	if (row.state === "cached") return "Replayed from cache";
	if (row.state === "done") return "Complete";
	if (row.state === "error") return row.error || "Failed";
	if (row.state === "waiting") return "Awaiting approval";
	return "Working…";
}

function renderAgentBlock(
	row: AgentRow,
	index: number,
	totalRows: number,
	theme: TreeTheme,
	options: TreeRenderOptions,
): string[] {
	const last = index === totalRows - 1;
	const branch = last ? "└─" : "├─";
	const cont = last ? "   " : "│  ";
	const width = options.width ?? Number.POSITIVE_INFINITY;
	const measure = options.measure ?? plainWidth;
	const truncate = options.truncate ?? truncatePlain;
	const statusText = rowStatusText(row, theme);
	const metrics = activityMetrics(row);
	const lines: string[] = [];

	if (metrics && metricsNeedOwnLine(row, width, measure)) {
		lines.push(truncate(`${theme.fg("dim", branch)} ${statusText}`, Math.max(1, width), "…"));
		lines.push(theme.fg("muted", truncate(`${cont}├ ${metrics.compact}`, Math.max(1, width), "…")));
	} else {
		const prefix = `${theme.fg("dim", branch)} `;
		const suffix = metrics ? ` · ${metrics.verbose}` : "";
		const labelBudget = Number.isFinite(width)
			? Math.max(1, width - measure(prefix) - measure(suffix))
			: Number.POSITIVE_INFINITY;
		const fittedStatus = Number.isFinite(labelBudget) ? truncate(statusText, labelBudget, "…") : statusText;
		lines.push(`${prefix}${fittedStatus}${metrics ? theme.fg("muted", suffix) : ""}`);
	}

	const detail = rowDetail(row);
	const detailPrefix = `${cont}└ `;
	const detailBudget = Number.isFinite(width) ? Math.max(1, width - measure(detailPrefix)) : Number.POSITIVE_INFINITY;
	const fittedDetail = options.fitDetail && Number.isFinite(detailBudget) ? options.fitDetail(detail, detailBudget) : detail;
	lines.push(theme.fg("dim", `${detailPrefix}${fittedDetail}`));
	return lines;
}

/** Pure: the tree's lines for one render pass. [] when there is no active run. */
export function renderTreeLines(snapshot: RunSnapshot | null, theme: TreeTheme, options: TreeRenderOptions = {}): string[] {
	if (!snapshot || snapshot.status !== "running") return [];
	const expanded = options.expanded === true;
	const renderWidth = options.width ?? Number.POSITIVE_INFINITY;
	const measure = options.measure ?? plainWidth;
	const agentBlocks = snapshot.rows.map((row, index) => renderAgentBlock(row, index, snapshot.rows.length, theme, options));
	const needsExpansion = treeNeedsExpansion(snapshot, renderWidth, measure);
	const running = snapshot.rows.filter((row) => row.state === "running" || row.state === "waiting").length;
	const queued = snapshot.rows.filter((row) => row.state === "queued").length;
	const expandHint = needsExpansion ? ` · ${EXPAND_KEY} ${expanded ? "collapse" : "expand"}` : "";
	const header =
		theme.fg(
			"accent",
			`${PROCEDURE_ICON} procedure ${snapshot.name}${snapshot.currentPhase ? ` · phase ${snapshot.currentPhase}` : ""}` +
				(running + queued > 0 ? ` · ${running} running${queued > 0 ? ` ${queued} queued` : ""}` : ""),
		) + theme.fg("dim", `  ${STOP_KEY} stop${expandHint}`);
	const logLines = snapshot.logs.slice(-2).map((log) => theme.fg("dim", `   log: ${log}`));
	const fullLines = [header, ...agentBlocks.flat(), ...logLines, BOTTOM_PADDING];
	if (expanded || !needsExpansion) return fullLines;

	// Preserve whole agent blocks. The hint and raw blank row stay at the tail
	// instead of being replaced by Pi's generic truncation marker.
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
	const hiddenAgentLines = agentBlocks.slice(shownRows).reduce((total, block) => total + block.length, 0);
	const hiddenLines = hiddenAgentLines + (logLines.length - shownLogs);
	lines.push(theme.fg("dim", `   … +${hiddenLines} line${hiddenLines === 1 ? "" : "s"} · ${EXPAND_KEY} expand`));
	lines.push(BOTTOM_PADDING);
	return lines;
}
