import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export function colorDiffLine(line: string, theme: Theme): string {
	if (line.startsWith("+") && !line.startsWith("+++")) {
		return theme.fg("toolDiffAdded", line);
	}
	if (line.startsWith("-") && !line.startsWith("---")) {
		return theme.fg("toolDiffRemoved", line);
	}
	if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) {
		return theme.fg("muted", line);
	}
	return theme.fg("toolDiffContext", line);
}

export function formatDiffLines(raw: string, width: number, theme: Theme): string[] {
	if (!raw.trim()) {
		return [theme.fg("muted", "(no diff — empty or binary)")];
	}

	return raw.split("\n").map((line) => truncateToWidth(colorDiffLine(line, theme), width, "…"));
}

export function summarizePaths(paths: string[]): string {
	if (paths.length <= 3) return paths.join(", ");
	return `${paths.slice(0, 2).join(", ")}, +${paths.length - 2} more`;
}
