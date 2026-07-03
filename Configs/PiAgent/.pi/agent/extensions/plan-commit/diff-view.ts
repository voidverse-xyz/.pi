import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { colorDiffLine } from "./diff.ts";

export type DiffViewMode = "inline" | "split";

export interface SplitRow {
	left: string;
	right: string;
	leftKind: "context" | "delete" | "add" | "empty" | "header";
	rightKind: "context" | "delete" | "add" | "empty" | "header";
}

/** Parse unified diff into side-by-side rows (no +/- prefixes). */
export function parseUnifiedToSplitRows(raw: string): SplitRow[] {
	const rows: SplitRow[] = [];
	let pendingOldHeader = "";

	for (const line of raw.split("\n")) {
		if (!line && rows.length > 0) continue;

		if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("# ")) {
			rows.push({ left: line, right: "", leftKind: "header", rightKind: "empty" });
			continue;
		}

		if (line.startsWith("--- ")) {
			pendingOldHeader = line.slice(4).trim();
			continue;
		}

		if (line.startsWith("+++ ")) {
			const newLabel = line.slice(4).trim();
			rows.push({
				left: pendingOldHeader || "(deleted)",
				right: newLabel,
				leftKind: "header",
				rightKind: "header",
			});
			pendingOldHeader = "";
			continue;
		}

		if (line.startsWith("@@")) {
			rows.push({ left: line, right: line, leftKind: "header", rightKind: "header" });
			continue;
		}

		if (line.startsWith("-") && !line.startsWith("---")) {
			rows.push({ left: line.slice(1), right: "", leftKind: "delete", rightKind: "empty" });
			continue;
		}

		if (line.startsWith("+") && !line.startsWith("+++")) {
			rows.push({ left: "", right: line.slice(1), leftKind: "empty", rightKind: "add" });
			continue;
		}

		if (line.startsWith("\\")) {
			rows.push({ left: line, right: line, leftKind: "context", rightKind: "context" });
			continue;
		}

		const content = line.startsWith(" ") ? line.slice(1) : line;
		rows.push({ left: content, right: content, leftKind: "context", rightKind: "context" });
	}

	return rows;
}

function padCol(content: string, width: number): string {
	const vis = visibleWidth(content);
	if (vis >= width) return truncateToWidth(content, width, "…");
	return content + " ".repeat(width - vis);
}

function styleSplitCell(text: string, kind: SplitRow["leftKind"], theme: Theme): string {
	if (!text) return "";
	switch (kind) {
		case "delete":
			return theme.fg("toolDiffRemoved", text);
		case "add":
			return theme.fg("toolDiffAdded", text);
		case "header":
			return theme.fg("muted", text);
		default:
			return theme.fg("toolDiffContext", text);
	}
}

function expandWrappedRows(rows: string[], width: number): string[] {
	if (width < 4) return rows;
	const out: string[] = [];
	for (const row of rows) {
		const wrapped = wrapTextWithAnsi(row, width);
		out.push(...(wrapped.length > 0 ? wrapped : [""]));
	}
	return out;
}

/** Build scrollable display lines for the diff pane. */
export function buildDiffDisplayLines(
	raw: string,
	mode: DiffViewMode,
	width: number,
	theme: Theme,
): string[] {
	const innerW = Math.max(20, width - 2);

	if (!raw.trim()) {
		return [theme.fg("muted", " (no diff — empty or binary)")];
	}

	if (mode === "inline") {
		const lines: string[] = [];
		for (const line of raw.split("\n")) {
			const colored = colorDiffLine(line, theme);
			const wrapped = wrapTextWithAnsi(colored, innerW);
			for (const w of wrapped.length > 0 ? wrapped : [""]) {
				lines.push(` ${w}`);
			}
		}
		return lines;
	}

	const splitRows = parseUnifiedToSplitRows(raw);
	const sep = theme.fg("borderMuted", " │ ");
	const sepW = visibleWidth(sep);
	const colW = Math.max(8, Math.floor((innerW - sepW) / 2));
	const lines: string[] = [];

	for (const row of splitRows) {
		const leftStyled = styleSplitCell(row.left, row.leftKind, theme);
		const rightStyled = styleSplitCell(row.right, row.rightKind, theme);
		const leftWrapped = expandWrappedRows([leftStyled], colW);
		const rightWrapped = expandWrappedRows([rightStyled], colW);
		const rowLines = Math.max(leftWrapped.length, rightWrapped.length, 1);

		for (let i = 0; i < rowLines; i++) {
			const left = padCol(leftWrapped[i] ?? "", colW);
			const right = padCol(rightWrapped[i] ?? "", colW);
			lines.push(` ${left}${sep}${right}`);
		}
	}

	return lines.length > 0 ? lines : [theme.fg("muted", " (no diff)")];
}

export function viewModeLabel(mode: DiffViewMode): string {
	return mode === "inline" ? "inline" : "split";
}

export function toggleViewMode(mode: DiffViewMode): DiffViewMode {
	return mode === "inline" ? "split" : "inline";
}
