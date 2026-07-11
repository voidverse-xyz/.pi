/**
 * Small ANSI helpers. Every helper wraps text in a self-contained SGR
 * sequence (open + close) — never nest one helper's output inside another,
 * pi-tui does not handle nested SGR of the same attribute.
 */

export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const crossedOut = (s: string) => `\x1b[9m${s}\x1b[29m`;

export function fgRgb(hexOrRgb: string | [number, number, number], s: string): string {
	let r: number, g: number, b: number;
	if (typeof hexOrRgb === "string") {
		const hex = hexOrRgb.replace("#", "");
		r = parseInt(hex.slice(0, 2), 16);
		g = parseInt(hex.slice(2, 4), 16);
		b = parseInt(hex.slice(4, 6), 16);
	} else {
		[r, g, b] = hexOrRgb;
	}
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

/** Visible width of a string, ignoring SGR sequences (ASCII content assumed). */
export function visibleWidth(s: string): number {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad styled string with plain spaces to a visible width. */
export function padEndVisible(s: string, width: number): string {
	const w = visibleWidth(s);
	return w >= width ? s : s + " ".repeat(width - w);
}

/**
 * Codex card border (codex-rs history_cell/session.rs with_border):
 * dim rounded corners, content padded to the widest row.
 */
export function borderedCard(rows: string[], width: number, maxInner = 56): string[] {
	if (width < 4) return [];
	const inner = Math.min(width - 4, maxInner);
	const contentWidth = Math.min(Math.max(...rows.map(visibleWidth), inner), Math.max(inner, Math.max(...rows.map(visibleWidth))));
	const borderInner = contentWidth + 2;
	const out: string[] = [];
	out.push(dim(`╭${"─".repeat(borderInner)}╮`));
	for (const row of rows) {
		out.push(dim("│ ") + padEndVisible(row, contentWidth) + dim(" │"));
	}
	out.push(dim(`╰${"─".repeat(borderInner)}╯`));
	return out;
}
