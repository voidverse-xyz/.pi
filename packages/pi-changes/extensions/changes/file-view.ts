/**
 * The changed-file list rows (with status markers + stats) and the full-file
 * content view (syntax-highlighted via the SDK's highlightCode).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { countDiffStat } from "./diff.ts";
import { escapeTerminalControls, padToWidth as pad, rule } from "./display.ts";
import { type ChangeStatus, type FileChange, fileDiffText } from "./tracker.ts";

const MARKER: Record<ChangeStatus, { char: string; color: string }> = {
	created: { char: "A", color: "toolDiffAdded" },
	modified: { char: "M", color: "warning" },
	missing: { char: "D", color: "toolDiffRemoved" },
	reverted: { char: "~", color: "dim" },
	"baseline-unknown": { char: "?", color: "muted" },
};

export function statusMarker(theme: Theme, status: ChangeStatus): string {
	const m = MARKER[status];
	return theme.fg(m.color as never, m.char);
}

// Memoize the +/- stat per file — the list re-renders on every keystroke and
// generateUnifiedPatch would otherwise run for every row each time.
const statCache = new WeakMap<FileChange, { added: number; removed: number }>();

function diffStatFor(fc: FileChange): { added: number; removed: number } {
	let s = statCache.get(fc);
	if (!s) {
		s = countDiffStat(fileDiffText(fc));
		statCache.set(fc, s);
	}
	return s;
}

function statLabel(theme: Theme, fc: FileChange): string {
	if (fc.status === "missing") return theme.fg("toolDiffRemoved", "deleted");
	if (fc.status === "baseline-unknown") {
		return theme.fg("muted", `${fc.changeCount || fc.recordedPatches.length || 1} recorded · no baseline`);
	}
	if (fc.currentUnreadable) return theme.fg("muted", "binary/large");
	const { added, removed } = diffStatFor(fc);
	const parts: string[] = [];
	if (added) parts.push(theme.fg("toolDiffAdded", `+${added}`));
	if (removed) parts.push(theme.fg("toolDiffRemoved", `−${removed}`));
	if (parts.length === 0) parts.push(theme.fg("dim", "±0"));
	return parts.join(" ");
}

/** Scrollable list of changed files. */
export function buildChangesListLines(
	changes: FileChange[],
	selectedIndex: number,
	width: number,
	theme: Theme,
): string[] {
	const innerW = Math.max(20, width - 2);
	if (changes.length === 0) {
		return [pad(` ${theme.fg("muted", "(no agent file changes this session)")}`, innerW)];
	}

	const lines: string[] = [];
	for (let i = 0; i < changes.length; i++) {
		const fc = changes[i]!;
		const selected = i === selectedIndex;
		const marker = selected ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ");
		const badge = statusMarker(theme, fc.status);

		const dim = fc.status === "reverted";
		const nameColor = dim ? "dim" : selected ? "text" : "dim";
		const rel = theme.fg(nameColor as never, escapeTerminalControls(fc.rel));

		const stat = statLabel(theme, fc);
		const count = fc.sourceLabel
			? theme.fg(fc.sourceLabel === "conflict" ? "error" : "dim", fc.sourceLabel)
			: theme.fg("dim", `${fc.changeCount || 1} change${(fc.changeCount || 1) === 1 ? "" : "s"}`);

		// Reserve the right side for stat + count; truncate the path to fit.
		const right = `${stat}  ${count}`;
		const rightW = visibleWidth(right);
		const nameW = Math.max(8, innerW - 5 - rightW - 2);
		const name = truncateToWidth(rel, nameW, "…");
		const left = ` ${marker}${badge} ${name}`;
		lines.push(pad(`${pad(left, innerW - rightW - 1)}${right}`, innerW));
	}
	return lines;
}

/** Full working-tree file content, syntax-highlighted, with a line-number gutter. */
export function buildFileContentLines(fc: FileChange, width: number, theme: Theme): string[] {
	const innerW = Math.max(20, width - 2);
	const lines: string[] = [];

	const header = theme.bold(escapeTerminalControls(fc.rel));
	for (const h of wrapTextWithAnsi(header, innerW)) lines.push(pad(` ${h}`, innerW));
	lines.push(pad(` ${rule(theme, innerW)}`, innerW));

	if (!fc.currentExists) {
		lines.push(pad(` ${theme.fg("muted", "(file no longer exists)")}`, innerW));
		return lines;
	}
	if (fc.currentUnreadable || fc.current === null) {
		lines.push(pad(` ${theme.fg("muted", "(binary or too large to display)")}`, innerW));
		return lines;
	}

	const safeCurrent = escapeTerminalControls(fc.current);
	const srcLines = safeCurrent.split("\n");
	let highlighted: string[];
	try {
		const lang = getLanguageFromPath(fc.abs);
		const hl = highlightCode(safeCurrent, lang);
		highlighted = hl.length === srcLines.length ? hl : srcLines.map((l) => theme.fg("dim", l));
	} catch {
		highlighted = srcLines.map((l) => theme.fg("dim", l));
	}

	const gutterW = Math.max(3, String(srcLines.length).length);
	for (let i = 0; i < srcLines.length; i++) {
		const num = theme.fg("muted", String(i + 1).padStart(gutterW, " "));
		const row = `${num} ${highlighted[i] ?? ""}`;
		for (const wrapped of wrapTextWithAnsi(row, innerW)) {
			lines.push(pad(` ${truncateToWidth(wrapped, innerW, "…")}`, innerW));
		}
	}
	return lines;
}
