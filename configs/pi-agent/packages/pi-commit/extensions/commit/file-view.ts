import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { pad } from "./tui-util.ts";

/** Scrollable file list for a review group. */
export function buildFilesListLines(
	paths: string[],
	selectedIndex: number,
	width: number,
	theme: Theme,
): string[] {
	const innerW = Math.max(20, width - 2);
	const lines: string[] = [];

	if (paths.length === 0) {
		return [pad(` ${theme.fg("muted", "(no files)")}`, innerW)];
	}

	for (let i = 0; i < paths.length; i++) {
		const path = paths[i]!;
		const marker = i === selectedIndex ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ");
		const name =
			i === selectedIndex ? theme.fg("accent", path) : theme.fg("dim", path);
		lines.push(pad(` ${marker}${truncateToWidth(name, innerW - 3, "…")}`, innerW));
	}

	return lines;
}
