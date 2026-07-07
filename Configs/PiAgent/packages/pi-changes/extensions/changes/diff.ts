/**
 * Unified-diff parsing shared by the /browse-edits diff views.
 *
 * `parseDiff` turns raw unified-diff text into structured lines that carry their
 * old/new file line numbers (tracked across `@@ -a,b +c,d @@` hunk headers), so
 * the views can render a line-number gutter. Rendering/coloring lives in
 * diff-view.ts; this module stays pure (no theme, no width).
 *
 * Copied verbatim from the plan-commit package so pi-changes stays self-contained.
 */

export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface ParsedDiffLine {
	kind: DiffLineKind;
	/** Old-file line number (present for del/context). */
	oldNo: number | null;
	/** New-file line number (present for add/context). */
	newNo: number | null;
	/** Content without the leading +/-/space marker (raw line for hunk/meta). */
	text: string;
}

const HUNK_RE = /^@@+\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/;

/** Parse a unified diff into line-numbered, kinded lines. */
export function parseDiff(raw: string): ParsedDiffLine[] {
	const out: ParsedDiffLine[] = [];
	let oldNo = 0;
	let newNo = 0;

	for (const line of raw.split("\n")) {
		const hunk = line.match(HUNK_RE);
		if (hunk) {
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			out.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
			continue;
		}

		// File-level headers and "\ No newline at end of file" markers.
		if (
			line.startsWith("diff ") ||
			line.startsWith("index ") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("old mode") ||
			line.startsWith("new mode") ||
			line.startsWith("similarity ") ||
			line.startsWith("rename ") ||
			line.startsWith("# ") ||
			line.startsWith("\\")
		) {
			out.push({ kind: "meta", oldNo: null, newNo: null, text: line });
			continue;
		}

		if (line.startsWith("+")) {
			out.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
			newNo++;
			continue;
		}
		if (line.startsWith("-")) {
			out.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
			oldNo++;
			continue;
		}

		// Context line (leading space, or a bare line inside a hunk).
		const text = line.startsWith(" ") ? line.slice(1) : line;
		out.push({ kind: "context", oldNo, newNo, text });
		oldNo++;
		newNo++;
	}

	return out;
}

/** Width of the line-number gutter needed for the largest number in the diff (min 3). */
export function diffGutterWidth(lines: ParsedDiffLine[]): number {
	let max = 0;
	for (const l of lines) {
		if (l.oldNo && l.oldNo > max) max = l.oldNo;
		if (l.newNo && l.newNo > max) max = l.newNo;
	}
	return Math.max(3, String(max).length);
}

/** Render tabs as spaces so column math stays predictable. */
export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/** Count added/removed lines in a unified diff (for list-row +/- summaries). */
export function countDiffStat(raw: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of raw.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}
