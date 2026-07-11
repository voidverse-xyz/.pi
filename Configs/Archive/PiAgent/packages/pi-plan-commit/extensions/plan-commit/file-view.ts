import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

function pad(content: string, width: number): string {
	const vis = visibleWidth(content);
	return content + " ".repeat(Math.max(0, width - vis));
}

function ruleLine(theme: Theme, width: number): string {
	const border = new DynamicBorder((s: string) => theme.fg("borderMuted", s));
	return border.render(Math.max(1, width - 2))[0] ?? "";
}

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
		lines.push(pad(` ${marker}${truncateToWidth(name, innerW - 2, "…")}`, innerW));
	}

	return lines;
}

/** Full working-tree file content (not a diff). */
export function buildFileContentLines(
	path: string,
	content: string | null,
	loading: boolean,
	width: number,
	theme: Theme,
): string[] {
	const innerW = Math.max(20, width - 2);
	const lines: string[] = [];

	const header = theme.bold(path);
	for (const h of wrapTextWithAnsi(header, innerW)) {
		lines.push(pad(` ${h}`, innerW));
	}
	lines.push(pad(` ${ruleLine(theme, innerW)}`, innerW));

	if (loading) {
		lines.push(pad(` ${theme.fg("muted", "Loading…")}`, innerW));
		return lines;
	}

	if (content === null || content === "") {
		lines.push(pad(` ${theme.fg("muted", "(empty or unreadable)")}`, innerW));
		return lines;
	}

	const fileLines = content.split("\n");
	for (let i = 0; i < fileLines.length; i++) {
		const num = theme.fg("muted", String(i + 1).padStart(4, " "));
		const text = theme.fg("dim", fileLines[i] ?? "");
		const row = `${num} ${text}`;
		for (const wrapped of wrapTextWithAnsi(row, innerW)) {
			lines.push(pad(` ${truncateToWidth(wrapped, innerW, "…")}`, innerW));
		}
	}

	return lines;
}

export function contentViewLabel(
	view: "diff" | "files" | "file",
	diffMode: "inline" | "split",
	filePath?: string,
): string {
	switch (view) {
		case "diff":
			return diffMode === "inline" ? "inline" : "split";
		case "files":
			return "files";
		case "file":
			return filePath ? `file · ${filePath.split("/").pop() ?? filePath}` : "file";
	}
}
