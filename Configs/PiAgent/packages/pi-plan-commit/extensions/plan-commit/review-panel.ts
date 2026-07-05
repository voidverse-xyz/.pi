import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createReviewKeys } from "./keys.ts";
import type { ReviewGroup } from "./classify.ts";
import { summarizePaths } from "./diff.ts";
import {
	buildDiffDisplayLines,
	toggleViewMode,
	type DiffViewMode,
} from "./diff-view.ts";
import {
	buildFileContentLines,
	buildFilesListLines,
	contentViewLabel,
} from "./file-view.ts";

export type ReviewAction = "accept" | "ask" | "skip" | "edit" | "stop";
type Pane = "content" | "actions";
type ContentView = "diff" | "files" | "file";

const ACTIONS: SelectItem[] = [
	{ value: "ask", label: "Ask" },
	{ value: "edit", label: "Edit" },
	{ value: "skip", label: "Skip" },
	{ value: "accept", label: "Accept" },
	{ value: "stop", label: "Stop" },
];

interface ReviewPanelOptions {
	group: ReviewGroup;
	index: number;
	total: number;
	diff: string;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	diffForPath: (path: string) => Promise<string>;
	readFile: (path: string) => Promise<string | null>;
	onDone: (action: ReviewAction) => void;
}

export function createReviewPanel(opts: ReviewPanelOptions): Component {
	const { group, index, total, diff, tui, theme, keybindings, diffForPath, readFile, onDone } =
		opts;
	const keys = createReviewKeys(keybindings);

	const groupDiff = diff;
	let currentDiff = diff;
	let diffScope: "group" | "file" = "group";
	let activeDiffPath: string | null = null;

	let contentScroll = 0;
	let focus: Pane = "actions";
	let contentView: ContentView = "diff";
	let diffViewMode: DiffViewMode = "inline";
	let filesSelectedIndex = 0;
	let openFilePath: string | null = null;
	let openFileContent: string | null = null;
	let openFileLoading = false;
	let diffLoading = false;
	let cachedWidth: number | undefined;
	let cachedHeight: number | undefined;
	let cachedLines: string[] | undefined;
	let cachedDisplayLines: string[] | undefined;
	let cachedDisplayKey: string | undefined;
	let currentContentHeight = 8;
	let pendingG = false;
	let actionSelectedIndex = 0;

	const selectList = new SelectList(ACTIONS, ACTIONS.length, {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	});

	selectList.onSelect = (item) => onDone(item.value as ReviewAction);
	selectList.onCancel = () => onDone("stop");
	selectList.onSelectionChange = () => {
		const item = selectList.getSelectedItem();
		if (item) {
			const idx = ACTIONS.findIndex((a) => a.value === item.value);
			if (idx >= 0) actionSelectedIndex = idx;
		}
		invalidate();
	};

	function invalidate() {
		cachedWidth = undefined;
		cachedHeight = undefined;
		cachedLines = undefined;
		cachedDisplayLines = undefined;
		cachedDisplayKey = undefined;
		selectList.invalidate();
	}

	function displayCacheKey(width: number): string {
		return [
			width,
			contentView,
			diffViewMode,
			diffScope,
			currentDiff,
			diffLoading ? "loading" : "ready",
			activeDiffPath ?? "",
			filesSelectedIndex,
			openFilePath ?? "",
			openFileLoading ? "loading" : "ready",
			openFileContent ?? "",
		].join("\0");
	}

	function displayLines(width: number): string[] {
		const key = displayCacheKey(width);
		if (cachedDisplayLines && cachedDisplayKey === key) {
			return cachedDisplayLines;
		}

		let lines: string[];
		if (contentView === "diff") {
			if (diffLoading) {
				lines = [theme.fg("muted", " Loading diff…")];
			} else {
				lines = buildDiffDisplayLines(currentDiff, diffViewMode, width, theme);
			}
		} else if (contentView === "files") {
			lines = buildFilesListLines(group.paths, filesSelectedIndex, width, theme);
		} else {
			lines = buildFileContentLines(
				openFilePath ?? "",
				openFileContent,
				openFileLoading,
				width,
				theme,
			);
		}

		cachedDisplayLines = lines;
		cachedDisplayKey = key;
		return lines;
	}

	function panelRows(): number {
		return Math.max(14, tui.terminal.rows);
	}

	function rule(width: number): string {
		const border = new DynamicBorder((s: string) => theme.fg("borderMuted", s));
		return border.render(Math.max(1, width))[0] ?? "";
	}

	function pad(content: string, width: number): string {
		const vis = visibleWidth(content);
		return content + " ".repeat(Math.max(0, width - vis));
	}

	function switchPane(next: Pane) {
		if (focus === next) return;
		focus = next;
		invalidate();
		tui.requestRender();
	}

	function switchContentView(next: ContentView) {
		if (contentView === next) return;
		contentView = next;
		contentScroll = 0;
		invalidate();
		tui.requestRender();
	}

	function toggleDiffView() {
		if (contentView !== "diff") return;
		diffViewMode = toggleViewMode(diffViewMode);
		contentScroll = 0;
		invalidate();
		tui.requestRender();
	}

	function showGroupDiff() {
		diffScope = "group";
		activeDiffPath = null;
		currentDiff = groupDiff;
		diffLoading = false;
		contentView = "diff";
		contentScroll = 0;
		invalidate();
		tui.requestRender();
	}

	async function loadFileDiff(path: string) {
		const fileIndex = group.paths.indexOf(path);
		if (fileIndex >= 0) filesSelectedIndex = fileIndex;

		diffScope = "file";
		activeDiffPath = path;
		currentDiff = "";
		diffLoading = true;
		contentView = "diff";
		contentScroll = 0;
		invalidate();
		tui.requestRender();

		const fileDiff = await diffForPath(path);
		if (activeDiffPath !== path) return;

		currentDiff = fileDiff;
		diffLoading = false;
		invalidate();
		tui.requestRender();
	}

	async function loadFile(path: string) {
		const fileIndex = group.paths.indexOf(path);
		if (fileIndex >= 0) filesSelectedIndex = fileIndex;

		openFilePath = path;
		openFileContent = null;
		openFileLoading = true;
		contentView = "file";
		contentScroll = 0;
		invalidate();
		tui.requestRender();

		const content = await readFile(path);
		if (openFilePath !== path) return;

		openFileContent = content;
		openFileLoading = false;
		invalidate();
		tui.requestRender();
	}

	function contentPaneLabel(): string {
		const active = focus === "content";
		const prefix = active ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ");

		let title = "Changes";
		if (contentView === "files") title = `Files (${group.paths.length})`;
		if (contentView === "file") title = "File";
		if (contentView === "diff" && diffScope === "file" && activeDiffPath) {
			title = activeDiffPath.split("/").pop() ?? activeDiffPath;
		}

		const modeLabel = contentViewLabel(
			contentView,
			diffViewMode,
			contentView === "file" ? (openFilePath ?? undefined) : (activeDiffPath ?? undefined),
		);

		const viewHint =
			contentView === "diff"
				? diffScope === "file"
					? theme.fg("dim", "file diff")
					: diffViewMode === "inline"
						? theme.fg("dim", "group · unified")
						: theme.fg("dim", "group · old │ new")
				: contentView === "files"
					? theme.fg("dim", "Enter diff · o full")
					: theme.fg("dim", openFilePath ?? "");

		return (
			prefix +
			(active ? theme.fg("text", title) : theme.fg("dim", title)) +
			theme.fg("dim", `  ${modeLabel}  `) +
			viewHint
		);
	}

	function applyContentScroll(data: string, maxScroll: number): boolean {
		if (keys.goTop(data)) {
			if (pendingG) {
				contentScroll = 0;
				pendingG = false;
			} else {
				pendingG = true;
			}
			return true;
		}
		pendingG = false;

		if (keys.goBottom(data)) {
			contentScroll = maxScroll;
			return true;
		}
		if (keys.lineStart(data)) {
			contentScroll = 0;
			return true;
		}
		if (keys.lineEnd(data)) {
			contentScroll = maxScroll;
			return true;
		}
		if (keys.up(data)) {
			contentScroll = Math.max(0, contentScroll - 1);
			return true;
		}
		if (keys.down(data)) {
			contentScroll = Math.min(maxScroll, contentScroll + 1);
			return true;
		}
		if (keys.pageUp(data)) {
			contentScroll = Math.max(0, contentScroll - currentContentHeight);
			return true;
		}
		if (keys.pageDown(data)) {
			contentScroll = Math.min(maxScroll, contentScroll + currentContentHeight);
			return true;
		}
		if (keys.halfPageUp(data)) {
			const half = Math.max(1, Math.floor(currentContentHeight / 2));
			contentScroll = Math.max(0, contentScroll - half);
			return true;
		}
		if (keys.halfPageDown(data)) {
			const half = Math.max(1, Math.floor(currentContentHeight / 2));
			contentScroll = Math.min(maxScroll, contentScroll + half);
			return true;
		}
		return false;
	}

	function handleInput(data: string): void {
		if (keys.tab(data)) {
			pendingG = false;
			switchPane(focus === "content" ? "actions" : "content");
			return;
		}
		if (keys.shiftTab(data)) {
			pendingG = false;
			switchPane(focus === "actions" ? "content" : "actions");
			return;
		}
		if (keys.right(data) && focus === "content") {
			pendingG = false;
			switchPane("actions");
			return;
		}
		if (keys.left(data) && focus === "content" && contentView === "diff" && diffScope === "file") {
			pendingG = false;
			switchContentView("files");
			return;
		}

		if (focus === "actions") {
			if (keys.left(data)) {
				pendingG = false;
				switchPane("content");
				return;
			}

			const actionIdx = keys.actionIndex(data);
			if (actionIdx !== null && actionIdx < ACTIONS.length) {
				onDone(ACTIONS[actionIdx]!.value as ReviewAction);
				return;
			}

			if (keys.up(data)) {
				pendingG = false;
				actionSelectedIndex =
					actionSelectedIndex === 0 ? ACTIONS.length - 1 : actionSelectedIndex - 1;
				selectList.setSelectedIndex(actionSelectedIndex);
				invalidate();
				tui.requestRender();
				return;
			}
			if (keys.down(data)) {
				pendingG = false;
				actionSelectedIndex =
					actionSelectedIndex === ACTIONS.length - 1 ? 0 : actionSelectedIndex + 1;
				selectList.setSelectedIndex(actionSelectedIndex);
				invalidate();
				tui.requestRender();
				return;
			}
			if (keys.confirm(data)) {
				pendingG = false;
				onDone(ACTIONS[actionSelectedIndex]!.value as ReviewAction);
				return;
			}
			if (keys.cancel(data)) {
				pendingG = false;
				onDone("stop");
				return;
			}

			selectList.handleInput(data);
			invalidate();
			tui.requestRender();
			return;
		}

		if (matchesKey(data, "v") || matchesKey(data, "V")) {
			if (contentView === "diff") toggleDiffView();
			return;
		}

		if (matchesKey(data, "f") || matchesKey(data, "F")) {
			if (contentView === "diff") {
				switchContentView("files");
			} else if (contentView === "files") {
				showGroupDiff();
			} else {
				contentView = "diff";
				contentScroll = 0;
				openFilePath = null;
				openFileContent = null;
				openFileLoading = false;
				invalidate();
				tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "o") || matchesKey(data, "O")) {
			if (contentView === "files") {
				const path = group.paths[filesSelectedIndex];
				if (path) void loadFile(path);
			} else if (contentView === "diff" && activeDiffPath) {
				void loadFile(activeDiffPath);
			}
			return;
		}

		if (contentView === "files") {
			const maxIndex = Math.max(0, group.paths.length - 1);
			const maxScroll = Math.max(0, group.paths.length - currentContentHeight);

			if (keys.up(data)) {
				filesSelectedIndex = Math.max(0, filesSelectedIndex - 1);
				if (filesSelectedIndex < contentScroll) contentScroll = filesSelectedIndex;
			} else if (keys.down(data)) {
				filesSelectedIndex = Math.min(maxIndex, filesSelectedIndex + 1);
				if (filesSelectedIndex >= contentScroll + currentContentHeight) {
					contentScroll = filesSelectedIndex - currentContentHeight + 1;
				}
			} else if (keys.pageUp(data)) {
				contentScroll = Math.max(0, contentScroll - currentContentHeight);
				filesSelectedIndex = Math.max(filesSelectedIndex, contentScroll);
			} else if (keys.pageDown(data)) {
				contentScroll = Math.min(maxScroll, contentScroll + currentContentHeight);
				filesSelectedIndex = Math.min(maxIndex, contentScroll);
			} else if (keys.confirm(data)) {
				const path = group.paths[filesSelectedIndex];
				if (path) void loadFileDiff(path);
				return;
			} else if (keys.cancel(data)) {
				showGroupDiff();
				return;
			} else {
				return;
			}

			pendingG = false;
			invalidate();
			tui.requestRender();
			return;
		}

		if (contentView === "file") {
			const lines = displayLines(tui.terminal.cols);
			const maxScroll = Math.max(0, lines.length - currentContentHeight);

			if (keys.cancel(data)) {
				switchContentView("files");
				openFilePath = null;
				openFileContent = null;
				openFileLoading = false;
				pendingG = false;
				return;
			}

			if (applyContentScroll(data, maxScroll)) {
				invalidate();
				tui.requestRender();
				return;
			}

			if (keys.confirm(data)) {
				pendingG = false;
				switchPane("actions");
			} else {
				return;
			}

			invalidate();
			tui.requestRender();
			return;
		}

		// diff view
		const lines = displayLines(tui.terminal.cols);
		const maxScroll = Math.max(0, lines.length - currentContentHeight);

		if (keys.cancel(data) && diffScope === "file") {
			pendingG = false;
			switchContentView("files");
			return;
		}

		if (applyContentScroll(data, maxScroll)) {
			invalidate();
			tui.requestRender();
			return;
		}

		if (keys.confirm(data)) {
			pendingG = false;
			switchPane("actions");
		} else if (keys.cancel(data)) {
			onDone("stop");
			return;
		} else {
			return;
		}

		invalidate();
		tui.requestRender();
	}

	function render(width: number): string[] {
		const targetH = panelRows();
		if (cachedLines && cachedWidth === width && cachedHeight === targetH) return cachedLines;

		const innerW = Math.max(20, width);
		const actionRows = ACTIONS.length;
		const footerRows = 1;

		const headerLines: string[] = [];
		headerLines.push(rule(innerW));
		const titleLine =
			theme.bold(`${index + 1}/${total} `) +
			theme.fg("text", group.title) +
			theme.fg("dim", `  ${group.layer}  ·  `) +
			theme.fg("dim", "commit ") +
			theme.fg("text", group.commitMessage);
		for (const h of wrapTextWithAnsi(titleLine, innerW)) {
			headerLines.push(pad(h, innerW));
		}
		const pathsLine = theme.fg("dim", summarizePaths(group.paths));
		for (const p of wrapTextWithAnsi(pathsLine, innerW)) {
			headerLines.push(pad(p, innerW));
		}

		const allContentLines = displayLines(innerW);
		const contentLabel = contentPaneLabel();

		const actionsBlockRows = 1 + actionRows;
		const overhead = headerLines.length + 1 + actionsBlockRows + footerRows;
		const contentH = Math.max(3, targetH - overhead);
		currentContentHeight = contentH;

		const maxScroll = Math.max(0, allContentLines.length - contentH);
		contentScroll = Math.min(contentScroll, maxScroll);
		const visibleContent = allContentLines.slice(contentScroll, contentScroll + contentH);

		const lines: string[] = [...headerLines];
		lines.push(pad(contentLabel, innerW));

		for (let i = 0; i < contentH; i++) {
			const line = visibleContent[i];
			if (line !== undefined) {
				lines.push(pad(truncateToWidth(line, innerW, "…"), innerW));
			} else if (i === 0 && allContentLines.length === 0) {
				lines.push(pad(theme.fg("muted", " (empty)"), innerW));
			} else {
				lines.push(pad("", innerW));
			}
		}

		if (allContentLines.length > contentH) {
			const pos = `${contentScroll + 1}–${Math.min(contentScroll + contentH, allContentLines.length)}/${allContentLines.length}`;
			const scrollIdx = headerLines.length + 1 + contentH - 1;
			if (scrollIdx >= 0 && scrollIdx < lines.length) {
				const hint = theme.fg("dim", ` · ${pos}`);
				const base = lines[scrollIdx] ?? "";
				const room = innerW - visibleWidth(base) - visibleWidth(hint);
				if (room >= 0) {
					lines[scrollIdx] = pad(base + hint, innerW);
				}
			}
		}

		lines.push(rule(innerW));
		selectList.setSelectedIndex(actionSelectedIndex);

		const actionsLabel =
			(focus === "actions" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "actions" ? theme.fg("text", "Actions") : theme.fg("dim", "Actions")) +
			(focus === "actions" ? theme.fg("dim", "  ↑↓ Enter · Tab pane") : "");
		lines.push(pad(actionsLabel, innerW));

		const actionLines = selectList.render(Math.max(1, innerW - 2));
		for (let i = 0; i < actionRows; i++) {
			const line = actionLines[i] ?? "";
			lines.push(pad(` ${line}`, innerW));
		}

		const footerHint =
			contentView === "diff"
				? diffScope === "file"
					? "Tab pane · ↑↓ scroll · PgUp/PgDn · v split · f files · o full · Esc files"
					: "Tab pane · ↑↓ scroll · PgUp/PgDn · v split · f files · Esc stop"
				: contentView === "files"
					? "Tab pane · ↑↓ · Enter diff · o full · f group · Esc group"
					: "Tab pane · ↑↓ scroll · Esc files · f diff · o full";
		lines.push(pad(theme.fg("dim", footerHint), innerW));

		if (lines.length < targetH) {
			const extra = targetH - lines.length;
			const insertAt = headerLines.length + 1 + contentH;
			for (let i = 0; i < extra; i++) {
				lines.splice(insertAt, 0, pad("", innerW));
			}
			currentContentHeight += extra;
		} else if (lines.length > targetH) {
			lines.length = targetH;
			lines[targetH - 1] = pad(theme.fg("dim", footerHint), innerW);
		}

		cachedWidth = width;
		cachedHeight = targetH;
		cachedLines = lines;
		return lines;
	}

	return {
		render,
		handleInput,
		invalidate,
	};
}
