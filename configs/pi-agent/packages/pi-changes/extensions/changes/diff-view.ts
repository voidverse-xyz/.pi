/**
 * Diff rendering (inline + side-by-side split), colored by diff-line kind.
 * Copied verbatim from the plan-commit package so pi-changes stays self-contained.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { diffGutterWidth, type ParsedDiffLine, parseDiff, replaceTabs } from "./diff.ts";
import { escapeTerminalControls } from "./display.ts";

export type DiffViewMode = "inline" | "split";

// Which background band highlights each kind of line. These are the only theme
// background keys available (see ThemeBg), so added→success, removed→error, and
// hunk headers→selected read as the conventional green/red/neutral bands.
const BAND: Record<ParsedDiffLine["kind"], "toolSuccessBg" | "toolErrorBg" | "selectedBg" | null> = {
	add: "toolSuccessBg",
	del: "toolErrorBg",
	hunk: "selectedBg",
	context: null,
	meta: null,
};

const FG: Record<ParsedDiffLine["kind"], "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" | "muted"> = {
	add: "toolDiffAdded",
	del: "toolDiffRemoved",
	context: "toolDiffContext",
	hunk: "muted",
	meta: "muted",
};

const SIGN: Record<ParsedDiffLine["kind"], string> = {
	add: "+",
	del: "-",
	context: " ",
	hunk: " ",
	meta: " ",
};

/** Pad a pre-styled string to an exact visible width with trailing spaces. */
function padTo(styled: string, visible: number, width: number): string {
	return width > visible ? styled + " ".repeat(width - visible) : styled;
}

/**
 * Render one unified (inline) diff line at exactly `fullW` visible columns:
 * ` <gutter> <sign> <content>`, wrapped in the line's highlight band so the
 * band spans the whole row.
 */
function renderInlineLine(line: ParsedDiffLine, gutterW: number, fullW: number, theme: Theme): string {
	const band = BAND[line.kind];

	// Hunk header / file meta: no gutter, just the raw line, optionally banded.
	if (line.kind === "hunk" || line.kind === "meta") {
		const contentW = Math.max(1, fullW - 1);
		const text = truncateToWidth(replaceTabs(line.text), contentW, "…");
		const styled = ` ${theme.fg(FG[line.kind], text)}`;
		const padded = padTo(styled, 1 + visibleWidth(text), fullW);
		return band ? theme.bg(band, padded) : padded;
	}

	const num = line.kind === "del" ? line.oldNo : line.newNo;
	const numStr = num != null ? String(num).padStart(gutterW) : " ".repeat(gutterW);
	// layout: leading space + gutter + space + sign + space + content
	const contentW = Math.max(1, fullW - gutterW - 4);
	const content = truncateToWidth(replaceTabs(line.text), contentW, "…");

	const gutter = theme.fg("toolDiffContext", numStr);
	const body = theme.fg(FG[line.kind], `${SIGN[line.kind]} ${content}`);
	const styled = ` ${gutter} ${body}`;
	const visible = 1 + gutterW + 1 + 2 + visibleWidth(content); // 2 = sign + space
	const padded = padTo(styled, visible, fullW);

	return band ? theme.bg(band, padded) : padded;
}

/** Render one side of a split row into a fixed-width, banded cell. */
function renderCell(
	text: string,
	kind: ParsedDiffLine["kind"] | "empty",
	num: number | null,
	gutterW: number,
	colW: number,
	theme: Theme,
): string {
	if (kind === "empty") return " ".repeat(colW);

	const numStr = num != null ? String(num).padStart(gutterW) : " ".repeat(gutterW);
	const contentW = Math.max(1, colW - gutterW - 1);
	const content = truncateToWidth(replaceTabs(text), contentW, "…");

	const gutter = theme.fg("toolDiffContext", numStr);
	const body = theme.fg(FG[kind], content);
	const styled = `${gutter} ${body}`;
	const padded = padTo(styled, gutterW + 1 + visibleWidth(content), colW);

	const band = BAND[kind];
	return band ? theme.bg(band, padded) : padded;
}

/** Build scrollable display lines for the diff pane. */
export function buildDiffDisplayLines(
	raw: string,
	mode: DiffViewMode,
	width: number,
	theme: Theme,
): string[] {
	if (!raw.trim()) {
		return [theme.fg("muted", " (no diff — empty, binary, or too large)")];
	}

	const parsed = parseDiff(escapeTerminalControls(raw));
	const gutterW = diffGutterWidth(parsed);

	if (mode === "inline") {
		return parsed.map((line) => renderInlineLine(line, gutterW, width, theme));
	}

	// Split: deletes on the left (old#), adds on the right (new#), context on both.
	const sep = theme.fg("borderMuted", " │ ");
	const sepW = visibleWidth(" │ ");
	const colW = Math.max(8, Math.floor((width - 1 - sepW) / 2));
	const lines: string[] = [];

	for (const line of parsed) {
		if (line.kind === "hunk" || line.kind === "meta") {
			const left = renderCell(line.text, line.kind, null, gutterW, colW, theme);
			lines.push(` ${left}${sep}${" ".repeat(colW)}`);
			continue;
		}
		if (line.kind === "add") {
			const left = renderCell("", "empty", null, gutterW, colW, theme);
			const right = renderCell(line.text, "add", line.newNo, gutterW, colW, theme);
			lines.push(` ${left}${sep}${right}`);
			continue;
		}
		if (line.kind === "del") {
			const left = renderCell(line.text, "del", line.oldNo, gutterW, colW, theme);
			const right = renderCell("", "empty", null, gutterW, colW, theme);
			lines.push(` ${left}${sep}${right}`);
			continue;
		}
		// context
		const left = renderCell(line.text, "context", line.oldNo, gutterW, colW, theme);
		const right = renderCell(line.text, "context", line.newNo, gutterW, colW, theme);
		lines.push(` ${left}${sep}${right}`);
	}

	return lines.length > 0 ? lines : [theme.fg("muted", " (no diff)")];
}

export function toggleViewMode(mode: DiffViewMode): DiffViewMode {
	return mode === "inline" ? "split" : "inline";
}
