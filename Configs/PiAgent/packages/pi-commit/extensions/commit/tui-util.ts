/** Shared TUI layout helpers for the commit review/chat panels. */

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Full-height overlay: use every terminal row (at least one). */
export function panelRows(tui: TUI): number {
	return Math.max(1, tui.terminal.rows);
}

/** A muted horizontal rule spanning `width` columns. */
export function rule(width: number, theme: Theme): string {
	const border = new DynamicBorder((s: string) => theme.fg("borderMuted", s));
	return border.render(Math.max(1, width))[0] ?? "";
}

/** Clip `content` to `width` visible columns (… ellipsis) and pad with spaces. */
export function pad(content: string, width: number): string {
	const clipped = truncateToWidth(content, Math.max(0, width), "…");
	const vis = visibleWidth(clipped);
	return clipped + " ".repeat(Math.max(0, width - vis));
}
