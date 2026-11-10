/**
 * The /browse-edits full-screen overlay component.
 *
 * Views: list (default) → diff / file (per file) → ask-target (main vs subagent)
 * → answer (subagent streaming). Actions that need the overlay closed (a question
 * prompt, spawning a subagent, undo/undo-all confirms, patch export) resolve back
 * to the command loop via onDone(PanelResult); everything else stays inside the panel.
 *
 * Adapted from the plan-commit review-panel: closure-scoped state, pull-based
 * render with tui.requestRender(), exact-height layout, render caching.
 */

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
import type { AnswerState } from "./ask.ts";
import { buildDiffDisplayLines, type DiffViewMode, toggleViewMode } from "./diff-view.ts";
import { clipPad as pad, escapeTerminalControls, rule } from "./display.ts";
import { buildChangesListLines, buildFileContentLines, statusMarker } from "./file-view.ts";
import { createNavKeys } from "./keys.ts";
import { type FileChange, fileDiffText } from "./tracker.ts";

export type PanelResult =
	| { type: "close" }
	| { type: "askMain"; abs: string }
	| { type: "askSub"; abs: string }
	| { type: "undo"; abs: string }
	| { type: "undoAll" }
	| { type: "exportPatch"; abs: string; all: boolean }
	| { type: "answerClose"; abs: string };

type PanelView = "list" | "diff" | "file" | "ask-target" | "answer";

const ASK_ITEMS: SelectItem[] = [
	{ value: "main", label: "Main agent — keeps session context, answers in chat" },
	{ value: "sub", label: "Fresh subagent — isolated, answer streams here" },
];

export interface ChangesPanelOptions {
	changes: FileChange[];
	source?: "session" | "git";
	allowUndo?: boolean;
	allowExport?: boolean;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	onDone: (result: PanelResult) => void;
	initialSelectedAbs?: string;
	initialView?: "list" | "answer";
	answer?: AnswerState;
}

export function createChangesPanel(opts: ChangesPanelOptions): Component {
	const { changes, tui, theme, keybindings, onDone, answer } = opts;
	const source = opts.source ?? "session";
	const allowUndo = opts.allowUndo ?? source === "session";
	const allowExport = opts.allowExport ?? source === "session";
	const keys = createNavKeys(keybindings);

	let selectedIndex = 0;
	if (opts.initialSelectedAbs) {
		const i = changes.findIndex((c) => c.abs === opts.initialSelectedAbs);
		if (i >= 0) selectedIndex = i;
	}

	let view: PanelView = opts.initialView === "answer" && answer ? "answer" : "list";
	let askReturnView: PanelView = "list";
	let contentScroll = 0;
	let diffViewMode: DiffViewMode = "inline";
	let pendingG = false;
	let answerFollow = true;

	let currentContentHeight = 8;
	let cachedWidth: number | undefined;
	let cachedHeight: number | undefined;
	let cachedLines: string[] | undefined;

	// Per-file diff text cache.
	let diffCacheIndex = -1;
	let diffCacheText = "";

	const askList = new SelectList(ASK_ITEMS, ASK_ITEMS.length, {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	});
	askList.onSelect = (item) => resolveAsk(item.value as "main" | "sub");
	askList.onCancel = () => backFromAsk();

	if (answer) {
		answer.onRender = () => {
			invalidate();
			tui.requestRender();
		};
	}

	function invalidate() {
		cachedWidth = undefined;
		cachedHeight = undefined;
		cachedLines = undefined;
		askList.invalidate();
	}

	function selected(): FileChange | undefined {
		return changes[selectedIndex];
	}

	function currentDiffText(): string {
		if (diffCacheIndex !== selectedIndex) {
			const fc = selected();
			diffCacheText = fc ? fileDiffText(fc) : "";
			diffCacheIndex = selectedIndex;
		}
		return diffCacheText;
	}

	function panelRows(): number {
		return Math.max(1, tui.terminal.rows);
	}

	function setView(next: PanelView) {
		view = next;
		contentScroll = 0;
		pendingG = false;
		invalidate();
		tui.requestRender();
	}

	function resolveAsk(target: "main" | "sub") {
		const fc = selected();
		if (!fc) return;
		onDone(target === "main" ? { type: "askMain", abs: fc.abs } : { type: "askSub", abs: fc.abs });
	}

	function backFromAsk() {
		setView(askReturnView);
	}

	// ── content lines per view ────────────────────────────────────────────────

	function answerLines(width: number): string[] {
		const innerW = Math.max(20, width - 2);
		const out: string[] = [];
		if (!answer) return [pad(theme.fg("muted", " (no answer)"), innerW)];

		const fc = selected();
		const title = theme.bold(`Subagent · ${escapeTerminalControls(answer.rel || fc?.rel || "")}`);
		for (const h of wrapTextWithAnsi(title, innerW)) out.push(pad(` ${h}`, innerW));
		out.push(pad(` ${rule(theme, width - 2)}`, innerW));

		if (answer.status === "error") {
			out.push(pad(` ${theme.fg("toolDiffRemoved", "Error:")} ${theme.fg("muted", escapeTerminalControls(answer.error ?? ""))}`, innerW));
			return out;
		}

		const body = escapeTerminalControls(answer.text || (answer.status === "running" ? "…thinking…" : "(no answer)"));
		for (const raw of body.split("\n")) {
			for (const wrapped of wrapTextWithAnsi(theme.fg("text", raw), innerW)) {
				out.push(pad(` ${wrapped}`, innerW));
			}
		}
		if (answer.status === "running") {
			out.push(pad(` ${theme.fg("dim", "󰔟 streaming…")}`, innerW)); // nf-md-loading
		} else if (answer.usageLine) {
			out.push(pad("", innerW));
			out.push(pad(` ${theme.fg("dim", answer.usageLine)}`, innerW));
		}
		return out;
	}

	// ── per-view handlers ─────────────────────────────────────────────────────

	interface ViewHandler {
		/** list/diff/file also react to the shared action keys (a/u/U/e/E/o). */
		sharedActionKeys?: boolean;
		handleInput(data: string): void;
		lines(width: number): string[];
	}

	const viewHandlers: Record<PanelView, ViewHandler> = {
		list: {
			sharedActionKeys: true,
			handleInput: handleListInput,
			lines: (width) => buildChangesListLines(changes, selectedIndex, width, theme),
		},
		diff: {
			sharedActionKeys: true,
			handleInput: handleDiffInput,
			lines: (width) => buildDiffDisplayLines(currentDiffText(), diffViewMode, width, theme),
		},
		file: {
			sharedActionKeys: true,
			handleInput: handleFileInput,
			lines: (width) => {
				const fc = selected();
				return fc ? buildFileContentLines(fc, width, theme) : [];
			},
		},
		"ask-target": {
			handleInput: handleAskTargetInput,
			lines: (width) => askList.render(Math.max(1, width - 4)).map((l) => ` ${l}`),
		},
		answer: {
			handleInput: handleAnswerInput,
			lines: answerLines,
		},
	};

	function displayLines(width: number): string[] {
		return viewHandlers[view].lines(width);
	}

	// ── input ─────────────────────────────────────────────────────────────────

	function openAskTarget() {
		if (!selected()) return;
		askReturnView = view;
		askList.setSelectedIndex(0);
		setView("ask-target");
	}

	function handleInput(data: string): void {
		const handler = viewHandlers[view];
		if (handler.sharedActionKeys && handleSharedActionKeys(data)) return;
		handler.handleInput(data);
	}

	/** Action keys common to the list, diff, and file views. */
	function handleSharedActionKeys(data: string): boolean {
		if (matchesKey(data, "a") || matchesKey(data, "shift+a")) {
			openAskTarget();
			return true;
		}
		if (allowUndo && matchesKey(data, "u")) {
			const fc = selected();
			if (fc) onDone({ type: "undo", abs: fc.abs });
			return true;
		}
		if (allowUndo && matchesKey(data, "shift+u")) {
			onDone({ type: "undoAll" });
			return true;
		}
		if (allowExport && matchesKey(data, "e")) {
			const fc = selected();
			if (fc) onDone({ type: "exportPatch", abs: fc.abs, all: false });
			return true;
		}
		if (allowExport && matchesKey(data, "shift+e")) {
			onDone({ type: "exportPatch", abs: selected()?.abs ?? "", all: true });
			return true;
		}
		if (matchesKey(data, "o") || matchesKey(data, "shift+o")) {
			if (selected()) setView("file");
			return true;
		}
		return false;
	}

	/** Apply scroll keys to the current view's content; re-render if anything moved. */
	function tryScroll(data: string, afterScroll?: (maxScroll: number) => void): void {
		const lines = displayLines(tui.terminal.columns);
		const maxScroll = Math.max(0, lines.length - currentContentHeight);
		if (scrollContent(data, maxScroll)) {
			afterScroll?.(maxScroll);
			invalidate();
			tui.requestRender();
		}
	}

	function handleAskTargetInput(data: string): void {
		if (data === "q" || keys.cancel(data)) {
			backFromAsk();
			return;
		}
		askList.handleInput(data);
		invalidate();
		tui.requestRender();
	}

	function handleAnswerInput(data: string): void {
		if (data === "q" || keys.cancel(data)) {
			onDone({ type: "answerClose", abs: selected()?.abs ?? "" });
			return;
		}
		tryScroll(data, (maxScroll) => {
			answerFollow = contentScroll >= maxScroll;
		});
	}

	function handleDiffInput(data: string): void {
		if (matchesKey(data, "v") || matchesKey(data, "shift+v")) {
			diffViewMode = toggleViewMode(diffViewMode);
			contentScroll = 0;
			invalidate();
			tui.requestRender();
			return;
		}
		if (matchesKey(data, "f") || matchesKey(data, "shift+f") || data === "q" || keys.cancel(data)) {
			setView("list");
			return;
		}
		tryScroll(data);
	}

	function handleFileInput(data: string): void {
		if (matchesKey(data, "f") || matchesKey(data, "shift+f")) {
			setView("diff");
			return;
		}
		if (data === "q" || keys.cancel(data)) {
			setView("list");
			return;
		}
		tryScroll(data);
	}

	function handleListInput(data: string): void {
		if (data === "q" || keys.cancel(data)) {
			onDone({ type: "close" });
			return;
		}
		if (keys.confirm(data)) {
			if (selected()) {
				diffViewMode = "inline";
				setView("diff");
			}
			return;
		}
		const maxIndex = Math.max(0, changes.length - 1);
		if (keys.goTop(data)) {
			if (pendingG) {
				selectedIndex = 0;
				contentScroll = 0;
				pendingG = false;
			} else {
				pendingG = true;
			}
			invalidate();
			tui.requestRender();
			return;
		}
		pendingG = false;
		if (keys.goBottom(data)) {
			selectedIndex = maxIndex;
		} else if (keys.up(data)) {
			selectedIndex = Math.max(0, selectedIndex - 1);
		} else if (keys.down(data)) {
			selectedIndex = Math.min(maxIndex, selectedIndex + 1);
		} else if (keys.pageUp(data)) {
			selectedIndex = Math.max(0, selectedIndex - currentContentHeight);
		} else if (keys.pageDown(data)) {
			selectedIndex = Math.min(maxIndex, selectedIndex + currentContentHeight);
		} else {
			return;
		}
		if (selectedIndex < contentScroll) contentScroll = selectedIndex;
		if (selectedIndex >= contentScroll + currentContentHeight) {
			contentScroll = selectedIndex - currentContentHeight + 1;
		}
		invalidate();
		tui.requestRender();
	}

	function scrollContent(data: string, maxScroll: number): boolean {
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

	// ── header / footer ─────────────────────────────────────────────────────────

	function headerLine(): string {
		const fileCount = changes.length;
		const totalChanges = changes.reduce((n, c) => n + (c.changeCount || 1), 0);
		const title = source === "git" ? "Git changes" : "Session changes";
		const summary = source === "git"
			? ` — ${fileCount} changed file${fileCount === 1 ? "" : "s"}`
			: ` — ${fileCount} file${fileCount === 1 ? "" : "s"} · ${totalChanges} edit${totalChanges === 1 ? "" : "s"}`;
		const left = theme.bold(title) + theme.fg("dim", summary);

		const fc = selected();
		let mid = "";
		const safeRel = fc ? escapeTerminalControls(fc.rel) : "";
		if (view === "diff" && fc) mid = `  ${statusMarker(theme, fc.status)} ${theme.fg("text", safeRel)} ${theme.fg("dim", diffViewMode)}`;
		else if (view === "file" && fc) mid = `  ${theme.fg("text", safeRel)} ${theme.fg("dim", "full file")}`;
		else if (view === "ask-target" && fc) mid = `  ${theme.fg("dim", "Ask about")} ${theme.fg("text", safeRel)}`;
		else if (view === "answer" && fc) mid = `  ${theme.fg("dim", "Subagent answer ·")} ${theme.fg("text", safeRel)}`;
		return left + mid;
	}

	function footerHint(): string {
		switch (view) {
			case "list":
				if (!allowUndo && !allowExport) return "↑↓ move · Enter diff · o file · a ask · q close";
				return "↑↓ move · Enter diff · o file · a ask · u undo · U undo all · e/E patch · q close";
			case "diff":
				if (!allowUndo && !allowExport) return "↑↓ scroll · v split · o file · a ask · f/q back";
				return "↑↓ scroll · v split · o file · a ask · u undo · e/E patch · f/q back";
			case "file":
				if (!allowUndo && !allowExport) return "↑↓ scroll · f diff · a ask · q back";
				return "↑↓ scroll · f diff · a ask · u undo · e/E patch · q back";
			case "ask-target":
				return "↑↓ · Enter choose · q cancel";
			case "answer":
				return answer?.status === "running" ? "↑↓ scroll · q stop & back" : "↑↓ scroll · q back";
		}
	}

	function render(width: number): string[] {
		const targetH = panelRows();
		if (cachedLines && cachedWidth === width && cachedHeight === targetH) return cachedLines;

		const innerW = Math.max(1, width);
		if (innerW < 20) {
			const lines = [truncateToWidth(theme.bold(source === "git" ? "Git changes" : "Session changes"), innerW, "")];
			while (lines.length < targetH) lines.push(" ".repeat(innerW));
			cachedWidth = width;
			cachedHeight = targetH;
			cachedLines = lines;
			return lines;
		}
		const header: string[] = [];
		header.push(rule(theme, innerW));
		for (const h of wrapTextWithAnsi(headerLine(), innerW)) header.push(pad(h, innerW));
		header.push(rule(theme, innerW));

		const footerRows = 2; // rule + hint
		const overhead = header.length + footerRows;
		const contentH = Math.max(1, targetH - overhead);
		currentContentHeight = contentH;

		const allContent = displayLines(innerW);

		// Auto-follow the tail while a subagent answer streams.
		if (view === "answer" && answerFollow) {
			contentScroll = Math.max(0, allContent.length - contentH);
		}
		const maxScroll = Math.max(0, allContent.length - contentH);
		contentScroll = Math.min(Math.max(0, contentScroll), maxScroll);
		const visible = allContent.slice(contentScroll, contentScroll + contentH);

		const lines: string[] = [...header];
		for (let i = 0; i < contentH; i++) {
			const line = visible[i];
			lines.push(line !== undefined ? pad(truncateToWidth(line, innerW, "…"), innerW) : pad("", innerW));
		}

		// scroll position indicator on the last content row
		if (allContent.length > contentH) {
			const pos = `${contentScroll + 1}–${Math.min(contentScroll + contentH, allContent.length)}/${allContent.length}`;
			const idx = header.length + contentH - 1;
			const base = lines[idx] ?? "";
			const hint = theme.fg("dim", ` · ${pos}`);
			const hintW = visibleWidth(hint);
			if (hintW < innerW) {
				const leftW = innerW - hintW;
				const left = truncateToWidth(base, leftW, "");
				lines[idx] = `${pad(left, leftW)}${hint}`;
			}
		}

		lines.push(rule(theme, innerW));
		lines.push(pad(theme.fg("dim", ` ${footerHint()}`), innerW));

		if (lines.length < targetH) {
			const insertAt = header.length + contentH;
			const missing = targetH - lines.length;
			for (let i = 0; i < missing; i++) lines.splice(insertAt, 0, pad("", innerW));
		} else if (lines.length > targetH) {
			lines.length = targetH;
		}

		cachedWidth = width;
		cachedHeight = targetH;
		cachedLines = lines;
		return lines;
	}

	return { render, handleInput, invalidate };
}
