import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
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
import { buildDiffDisplayLines, type DiffViewMode, toggleViewMode } from "./diff-view.ts";
import { buildFilesListLines } from "./file-view.ts";
import { pad, panelRows, rule } from "./tui-util.ts";

export type ReviewAction = "accept" | "ask" | "skip" | "edit" | "stop";
type Pane = "content" | "actions";
type ContentView = "files" | "detail";
/** diff = changed hunks only (±3 lines). full = the whole file, changes highlighted. */
type DetailContext = "diff" | "full";

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
	/** Accept reports instead of committing; the header shows a dry-run marker. */
	dryRun?: boolean;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	/** Fetch a unified diff for the group or a single file, hunks-only or full-file. */
	loadDiff: (scope: "group" | "file", path: string | null, full: boolean) => Promise<string>;
	/** Lazily generate the explanatory text shown below the header. */
	loadDescription: (signal: AbortSignal) => Promise<string>;
	onDone: (action: ReviewAction) => void;
}

export function createReviewPanel(opts: ReviewPanelOptions): Component {
	const { group, index, total, dryRun, tui, theme, keybindings, loadDiff, loadDescription, onDone } = opts;
	const keys = createReviewKeys(keybindings);

	// Task 2: open on the Files list, with the content (tab) pane focused — not Actions.
	let contentView: ContentView = "files";
	let focus: Pane = "content";

	let diffScope: "group" | "file" = "group";
	let activeFilePath: string | null = null;
	let detailContext: DetailContext = "diff";
	let diffViewMode: DiffViewMode = "inline";

	let currentDiff = "";
	let diffLoading = false;
	let detailToken = 0;
	let description = "";
	let descriptionError = "";
	let descriptionLoading = true;
	const descriptionController = new AbortController();
	let finished = false;

	let contentScroll = 0;
	let filesSelectedIndex = 0;
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

	function finish(action: ReviewAction) {
		if (finished) return;
		finished = true;
		descriptionController.abort();
		onDone(action);
	}

	selectList.onSelect = (item) => finish(item.value as ReviewAction);
	selectList.onCancel = () => finish("stop");
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
			detailContext,
			diffScope,
			activeFilePath ?? "",
			diffLoading ? "loading" : "ready",
			currentDiff,
			filesSelectedIndex,
		].join("\0");
	}

	function displayLines(width: number): string[] {
		const key = displayCacheKey(width);
		if (cachedDisplayLines && cachedDisplayKey === key) return cachedDisplayLines;

		let lines: string[];
		if (contentView === "files") {
			lines = buildFilesListLines(group.paths, filesSelectedIndex, width, theme);
		} else if (diffLoading) {
			lines = [theme.fg("muted", detailContext === "full" ? " Loading file…" : " Loading diff…")];
		} else {
			lines = buildDiffDisplayLines(currentDiff, diffViewMode, width, theme);
		}

		cachedDisplayLines = lines;
		cachedDisplayKey = key;
		return lines;
	}

	async function refreshDescription() {
		try {
			description = await loadDescription(descriptionController.signal);
		} catch (error) {
			if (!descriptionController.signal.aborted) {
				descriptionError = error instanceof Error ? error.message : String(error);
			}
		} finally {
			descriptionLoading = false;
			invalidate();
			tui.requestRender();
		}
	}

	function switchPane(next: Pane) {
		if (focus === next) return;
		focus = next;
		invalidate();
		tui.requestRender();
	}

	// Load the diff text for the current (scope, path, context). Called on entering
	// detail and whenever the context (diff/full) or the target file/scope changes.
	async function refreshDetail() {
		const token = ++detailToken;
		diffLoading = true;
		currentDiff = "";
		invalidate();
		tui.requestRender();

		let text: string;
		try {
			text = await loadDiff(diffScope, activeFilePath, detailContext === "full");
		} catch (error) {
			text = `Failed to load diff: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (token !== detailToken) return;

		currentDiff = text;
		diffLoading = false;
		invalidate();
		tui.requestRender();
	}

	function openFileDetail(path: string) {
		const fileIndex = group.paths.indexOf(path);
		if (fileIndex >= 0) filesSelectedIndex = fileIndex;
		diffScope = "file";
		activeFilePath = path;
		contentView = "detail";
		contentScroll = 0;
		void refreshDetail();
	}

	function openGroupDetail() {
		diffScope = "group";
		activeFilePath = null;
		contentView = "detail";
		contentScroll = 0;
		void refreshDetail();
	}

	function backToFiles() {
		contentView = "files";
		contentScroll = 0;
		pendingG = false;
		invalidate();
		tui.requestRender();
	}

	function toggleLayout() {
		diffViewMode = toggleViewMode(diffViewMode);
		contentScroll = 0;
		invalidate();
		tui.requestRender();
	}

	function toggleContext() {
		detailContext = detailContext === "diff" ? "full" : "diff";
		contentScroll = 0;
		void refreshDetail();
	}

	function contentPaneLabel(): string {
		const active = focus === "content";
		const prefix = active ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ");

		let title: string;
		let hint: string;
		if (contentView === "files") {
			title = `Files (${group.paths.length})`;
			hint = theme.fg("dim", "Enter view · Tab actions");
		} else {
			title =
				diffScope === "file" && activeFilePath
					? (activeFilePath.split("/").pop() ?? activeFilePath)
					: "All changes";
			const ctxLabel = detailContext === "full" ? "full file" : "diff";
			const layoutLabel = diffViewMode === "inline" ? "unified" : "old │ new";
			hint = theme.fg("dim", `${ctxLabel} · ${layoutLabel}`);
		}

		return (
			prefix +
			(active ? theme.fg("text", title) : theme.fg("dim", title)) +
			theme.fg("dim", "  ") +
			hint
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
			contentScroll = Math.max(0, contentScroll - Math.max(1, Math.floor(currentContentHeight / 2)));
			return true;
		}
		if (keys.halfPageDown(data)) {
			contentScroll = Math.min(maxScroll, contentScroll + Math.max(1, Math.floor(currentContentHeight / 2)));
			return true;
		}
		return false;
	}

	function handleActionsInput(data: string): void {
		if (keys.left(data)) {
			pendingG = false;
			switchPane("content");
			return;
		}
		const actionIdx = keys.actionIndex(data);
		if (actionIdx !== null && actionIdx < ACTIONS.length) {
			finish(ACTIONS[actionIdx]!.value as ReviewAction);
			return;
		}
		if (keys.up(data)) {
			pendingG = false;
			actionSelectedIndex = actionSelectedIndex === 0 ? ACTIONS.length - 1 : actionSelectedIndex - 1;
			selectList.setSelectedIndex(actionSelectedIndex);
			invalidate();
			tui.requestRender();
			return;
		}
		if (keys.down(data)) {
			pendingG = false;
			actionSelectedIndex = actionSelectedIndex === ACTIONS.length - 1 ? 0 : actionSelectedIndex + 1;
			selectList.setSelectedIndex(actionSelectedIndex);
			invalidate();
			tui.requestRender();
			return;
		}
		if (keys.confirm(data)) {
			pendingG = false;
			finish(ACTIONS[actionSelectedIndex]!.value as ReviewAction);
			return;
		}
		if (data === "q" || keys.cancel(data)) {
			pendingG = false;
			finish("stop");
			return;
		}
		selectList.handleInput(data);
		invalidate();
		tui.requestRender();
	}

	function handleFilesInput(data: string): void {
		const maxIndex = Math.max(0, group.paths.length - 1);
		const maxScroll = Math.max(0, group.paths.length - currentContentHeight);

		if (matchesKey(data, "d") || data === "D") {
			openGroupDetail();
			return;
		}
		if (keys.confirm(data) || keys.right(data)) {
			const path = group.paths[filesSelectedIndex];
			if (path) openFileDetail(path);
			return;
		}
		if (data === "q" || keys.cancel(data)) {
			finish("stop");
			return;
		}

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
			filesSelectedIndex = Math.max(filesSelectedIndex - currentContentHeight, 0);
		} else if (keys.pageDown(data)) {
			contentScroll = Math.min(maxScroll, contentScroll + currentContentHeight);
			filesSelectedIndex = Math.min(maxIndex, filesSelectedIndex + currentContentHeight);
		} else if (keys.goBottom(data)) {
			filesSelectedIndex = maxIndex;
		} else if (keys.goTop(data)) {
			if (pendingG) {
				filesSelectedIndex = 0;
				contentScroll = 0;
				pendingG = false;
			} else {
				pendingG = true;
			}
			invalidate();
			tui.requestRender();
			return;
		} else {
			return;
		}

		pendingG = false;
		invalidate();
		tui.requestRender();
	}

	function handleDetailInput(data: string): void {
		if (matchesKey(data, "v") || data === "V") {
			toggleLayout();
			return;
		}
		if (matchesKey(data, "t") || data === "T") {
			toggleContext();
			return;
		}
		if (matchesKey(data, "f") || data === "F") {
			backToFiles();
			return;
		}
		if (data === "q" || keys.cancel(data) || keys.left(data)) {
			backToFiles();
			return;
		}

		const lines = displayLines(tui.terminal.columns);
		const maxScroll = Math.max(0, lines.length - currentContentHeight);
		if (applyContentScroll(data, maxScroll)) {
			invalidate();
			tui.requestRender();
			return;
		}
		if (keys.confirm(data)) {
			pendingG = false;
			switchPane("actions");
		}
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
		// In the files view, right is handled by handleFilesInput (opens the file).
		if (keys.right(data) && focus === "content" && contentView === "detail") {
			pendingG = false;
			switchPane("actions");
			return;
		}

		if (focus === "actions") {
			handleActionsInput(data);
			return;
		}

		if (contentView === "files") handleFilesInput(data);
		else handleDetailInput(data);
	}

	function render(width: number): string[] {
		const targetH = panelRows(tui);
		if (cachedLines && cachedWidth === width && cachedHeight === targetH) return cachedLines;

		const innerW = Math.max(1, width);
		if (innerW < 20) {
			const lines = [truncateToWidth(theme.bold("Commit review"), innerW, "")];
			while (lines.length < targetH) lines.push(" ".repeat(innerW));
			cachedWidth = width;
			cachedHeight = targetH;
			cachedLines = lines;
			return lines;
		}
		const actionRows = ACTIONS.length;
		const footerRows = 1;
		// Header, content, and actions are the three main components. Add a
		// breathing row between them when the terminal has room.
		const sectionGap = targetH >= 20 ? 1 : 0;

		const headerLines: string[] = [];
		const pushHeaderText = (value: string, maxRows: number) => {
			const wrapped = wrapTextWithAnsi(value, innerW);
			const visible = wrapped.slice(0, maxRows);
			if (wrapped.length > maxRows && visible.length > 0) {
				visible[visible.length - 1] =
					truncateToWidth(visible[visible.length - 1]!, Math.max(1, innerW - 2), "") + theme.fg("dim", " …");
			}
			for (const line of visible) headerLines.push(pad(line, innerW));
		};
		headerLines.push(rule(innerW, theme));
		const titleLine =
			theme.bold(`${index + 1}/${total} `) +
			theme.fg("text", group.title) +
			theme.fg("dim", `  ${group.layer}  ·  `) +
			(dryRun ? theme.fg("warning", "DRY RUN ") : "") +
			theme.fg("dim", dryRun ? "would commit " : "commit ") +
			theme.fg("text", group.commitMessage);
		pushHeaderText(titleLine, targetH >= 20 ? 2 : 1);
		const pathsLine = theme.fg("dim", summarizePaths(group.paths));
		pushHeaderText(pathsLine, 1);
		const descriptionText = descriptionLoading
			? "Generating commit description…"
			: descriptionError
				? `Description unavailable: ${descriptionError}`
				: description;
		const descriptionLine =
			theme.fg("accent", "Description  ") +
			theme.fg(descriptionError ? "warning" : descriptionLoading ? "muted" : "text", descriptionText);
		pushHeaderText(descriptionLine, targetH >= 24 ? 3 : targetH >= 16 ? 2 : 1);

		const allContentLines = displayLines(innerW);
		const contentLabel = contentPaneLabel();

		const actionDividerRows = 1;
		const actionsBlockRows = 1 + actionRows;
		const overhead = headerLines.length + sectionGap * 2 + 1 + actionDividerRows + actionsBlockRows + footerRows;
		const contentH = Math.max(0, targetH - overhead);
		currentContentHeight = contentH;

		const maxScroll = Math.max(0, allContentLines.length - contentH);
		contentScroll = Math.min(contentScroll, maxScroll);
		const visibleContent = allContentLines.slice(contentScroll, contentScroll + contentH);

		const lines: string[] = [...headerLines];
		for (let i = 0; i < sectionGap; i++) lines.push(pad("", innerW));
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
			const scrollIdx = headerLines.length + sectionGap + 1 + contentH - 1;
			if (scrollIdx >= 0 && scrollIdx < lines.length) {
				const hint = theme.fg("dim", ` · ${pos}`);
				const hintW = visibleWidth(hint);
				const base = lines[scrollIdx] ?? "";
				if (hintW < innerW) {
					const leftW = innerW - hintW;
					lines[scrollIdx] = `${pad(truncateToWidth(base, leftW, ""), leftW)}${hint}`;
				}
			}
		}

		for (let i = 0; i < sectionGap; i++) lines.push(pad("", innerW));
		lines.push(rule(innerW, theme));
		selectList.setSelectedIndex(actionSelectedIndex);

		const actionsLabel =
			(focus === "actions" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "actions" ? theme.fg("text", "Actions") : theme.fg("dim", "Actions")) +
			(focus === "actions" ? theme.fg("dim", "  ↑↓ Enter · Tab pane") : "");
		lines.push(pad(actionsLabel, innerW));

		const actionLines = selectList.render(Math.max(1, innerW - 2));
		for (let i = 0; i < actionRows; i++) {
			lines.push(pad(` ${actionLines[i] ?? ""}`, innerW));
		}

		const footerHint =
			contentView === "files"
				? "Tab actions · ↑↓ · Enter view file · d all changes · q stop"
				: "Tab actions · ↑↓ scroll · v unified/split · t diff/full · f/q files";
		lines.push(pad(theme.fg("dim", footerHint), innerW));

		if (lines.length < targetH) {
			const extra = targetH - lines.length;
			const insertAt = headerLines.length + sectionGap + 1 + contentH;
			for (let i = 0; i < extra; i++) lines.splice(insertAt, 0, pad("", innerW));
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

	void refreshDescription();

	return {
		render,
		handleInput,
		invalidate,
		dispose() {
			descriptionController.abort();
		},
	};
}
