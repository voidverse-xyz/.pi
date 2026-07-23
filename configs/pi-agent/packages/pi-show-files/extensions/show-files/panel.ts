/**
 * show_files — the full-screen presentation overlay.
 *
 *  ┌ header: agent's title + summary ──────────────────────────────────────────┐
 *  │ left: grouped, annotated file list  │ right: description + content preview │
 *  └─────────────────────────────────────┴───────────────────────────────────────┘
 *
 * Left pane lists the agent-curated files in the agent's order, under optional
 * group headings, each with the agent's short title (path shown in the right
 * pane's label). Right pane shows the agent's per-file description above the
 * file content; the agent's highlight regions get a background tint, the preview
 * opens on the first region, and n/p jump between regions (a region's note shows
 * in the label row while the cursor is inside it).
 *
 * User actions fed back into the tool result (the two-way part):
 *   - which files were opened in the preview (including files opened by browsing
 *     into a curated directory),
 *   - `a` add-to-chat @-mentions gathered (de-duplicated — a repeated `a` on the
 *     same mention is a no-op with an "Already added" notice). In the raw preview
 *     `a` adds the most specific mention available: an `s`/`v` selection →
 *     `@path:start-end`, else the highlighted region under the cursor → its range,
 *     else the cursor line → `@path:line`. A directory is a *constrained browser*
 *     (↑↓ select, Enter/→ descend into a subdir or open a child file, h/←/⌫/Esc go
 *     up — never above the curated root); `a` there adds the selected entry's
 *     mention (`@dir/` for directories). Rendered previews add `@path`.
 *   - `m` a free-text note typed in an embedded editor (always `m` — never `n`/`p`,
 *     which are region/search navigation).
 *
 * Further keys: `/` opens a search input — fuzzy-filters the file list when the
 * list has focus, substring-searches the file content when the preview has focus
 * (`n`/`p` jump matches while a search is active); `r` toggles rendered↔raw for
 * markdown/HTML previews (rendered by default unless the spec has regions, which
 * reference raw line numbers). For HTML, the rendered view kicks off a local
 * headless-Chromium snapshot (see browser.ts — file:// only, network blocked) and
 * `o` opens the page in the system browser; the snapshot can't paint inline in a
 * terminal overlay, so the rendered view stays best-effort text with a banner that
 * reports the snapshot and points at `o`. Two clipboard keys: `c` copies a
 * *mention* (the selection's range @-mention, else the accumulated added mentions),
 * `y` yanks the actual *text* (selected lines, else the region under the cursor,
 * else the current line). When a headless subagent forwards a presentation here over ipc, a header
 * names the asking subagent chain (`opts.from`).
 *
 * Layout/scroll/exact-height machinery follows pi-browse's panel (closure state,
 * pull-based render); the note editor follows pi-ask-user's embedded Editor.
 *
 * The preview/browse state record lives in preview-state.ts; content loading
 * lives in preview-loader.ts; directory-browse navigation lives in dir-browser.ts.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	Editor,
	type EditorTheme,
	fuzzyMatch,
	getCapabilities,
	Markdown,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { appendToEditor, dirMention, type EditorUi, fileMention, linesMention } from "./add-to-chat.ts";
import { createDirBrowser } from "./dir-browser.ts";
import { createNavKeys } from "./keys.ts";
import { applyScrollKeys, handleGG } from "./scroll-keys.ts";
import type { PresentedFile } from "./files.ts";
import {
	buildRows,
	clampVisible,
	computeMatchLines,
	firstMatchFrom,
	formatBytes,
	nextMatchLine,
	nextRegionStart,
	regionIndexAt,
	type Row,
	stepSelection,
} from "./panel-logic.ts";
import { createPreviewLoader } from "./preview-loader.ts";
import { createPreviewState } from "./preview-state.ts";
import { htmlToText } from "./rendered.ts";

const ICON_LOADING = ""; // nf-fa-spinner
const ICON_SUCCESS = ""; // nf-fa-check
const ICON_WARNING = ""; // nf-fa-warning

export interface ShowFilesOutcome {
	/** rel paths whose preview the user deliberately entered. */
	opened: string[];
	/** @-mentions the user appended to the chat editor. */
	added: string[];
	/** Free-text note typed in the panel, if any. */
	note?: string;
}

export interface ShowFilesPanelOptions {
	title: string;
	summary?: string;
	files: PresentedFile[];
	/** Asking subagent chain when the presentation was forwarded here over ipc. */
	from?: string[];
	ctx: EditorUi;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	onDone: (result: ShowFilesOutcome) => void;
}

type Focus = "list" | "preview";

export function createShowFilesPanel(opts: ShowFilesPanelOptions): Component {
	const { title, summary, files, from, ctx, tui, theme, keybindings, onDone } = opts;
	const keys = createNavKeys(keybindings);

	const rows = buildRows(files);
	let listSelected = rows.findIndex((r) => r.kind === "file");
	if (listSelected < 0) listSelected = 0;
	let listScroll = 0;
	let focus: Focus = "list";
	let pendingG = false;

	// Preview / directory drill-in / rendered-preview / HTML-snapshot / in-file
	// search state — the record shared with the preview loader and the directory
	// browser (see preview-state.ts for the field-by-field documentation).
	const state = createPreviewState();

	// Search state — a list filter and an in-file search coexist independently
	// (the in-file previewSearch/matchLines live in `state`).
	let viewRows: Row[] = rows; // effective (possibly filtered) list
	let listFilter = "";
	let editingSearch: false | "list" | "preview" = false;
	let searchPrev = ""; // restored on Esc
	let searchOrigin = 0; // cursor line when the search input opened

	// Outcome tracking
	const opened = new Set<string>();
	const added: string[] = [];
	let note = "";

	// Note editor
	let editingNote = false;
	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const noteEditor = new Editor(tui, editorTheme);
	noteEditor.onSubmit = (value) => {
		note = value.trim();
		editingNote = false;
		rerender();
	};

	// Search input (same embedded-editor idiom as the note editor). onChange
	// live-applies; Enter keeps the query and closes; Esc restores searchPrev.
	// Note: Editor.submitValue clears its text and fires onChange("") BEFORE
	// onSubmit, so onSubmit must re-apply the submitted value to keep the query.
	const searchEditor = new Editor(tui, editorTheme);
	searchEditor.onChange = (text) => {
		if (editingSearch === "list") applyListFilter(text);
		else if (editingSearch === "preview") applyPreviewSearch(text, searchOrigin);
		rerender();
	};
	searchEditor.onSubmit = (value) => {
		const scope = editingSearch;
		editingSearch = false;
		if (scope === "list") applyListFilter(value);
		else if (scope === "preview") {
			applyPreviewSearch(value, searchOrigin);
			if (value && state.matchLines.length === 0) ctx.ui.notify("No matches", "info");
		}
		rerender();
	};

	let contentH = 8;
	let cachedWidth: number | undefined;
	let cachedHeight: number | undefined;
	let cachedLines: string[] | undefined;

	function clearRenderCache() {
		cachedWidth = undefined;
		cachedHeight = undefined;
		cachedLines = undefined;
	}

	function invalidate() {
		clearRenderCache();
		// highlightCode and Markdown bake the current theme's ANSI colors into
		// cached output, so rebuild those caches when the TUI invalidates us.
		loader.rebuildSyntaxHighlighting();
		state.mdComp?.invalidate();
	}

	function rerender() {
		clearRenderCache();
		tui.requestRender();
	}

	function selectedFile(): PresentedFile | undefined {
		const row = viewRows[listSelected];
		return row?.kind === "file" ? row.file : undefined;
	}

	function panelRows(): number {
		return Math.max(1, tui.terminal.rows);
	}

	function rule(width: number): string {
		const border = new DynamicBorder((s: string) => theme.fg("borderMuted", s));
		return border.render(Math.max(1, width))[0] ?? "";
	}

	function pad(content: string, width: number): string {
		const vis = visibleWidth(content);
		return content + " ".repeat(Math.max(0, width - vis));
	}

	function finish() {
		onDone({ opened: [...opened], added: [...added], note: note || undefined });
	}

	// ── preview loading + directory browsing (extracted modules) ────────────────

	const loader = createPreviewLoader(state, {
		rerender,
		notify: (msg, level) => ctx.ui.notify(msg, level),
		browseRows: () => browser.browseRows(),
		keepDirCursorVisible: () => browser.keepDirCursorVisible(),
	});
	const browser = createDirBrowser(state, {
		previewContentH,
		rerender,
		loadDir: (abs, cursorTo) => loader.loadDir(abs, cursorTo),
		loadChildFile: (abs, rel) => loader.loadChildFile(abs, rel),
		addMention,
		opened,
		setFocusList: () => { focus = "list"; },
	});

	void loader.loadPreview(selectedFile());

	// ── list navigation ──────────────────────────────────────────────────────────

	function keepListVisible() {
		listScroll = clampVisible(listSelected, listScroll, contentH);
	}

	function moveList(delta: number) {
		if (viewRows.length === 0) return;
		const idx = stepSelection(viewRows, listSelected, delta);
		if (idx !== listSelected) {
			listSelected = idx;
			keepListVisible();
			void loader.loadPreview(selectedFile());
		}
	}

	function jumpList(toEnd: boolean) {
		const idxs = viewRows.map((r, i) => (r.kind === "file" ? i : -1)).filter((i) => i >= 0);
		if (idxs.length === 0) return;
		listSelected = toEnd ? idxs[idxs.length - 1]! : idxs[0]!;
		keepListVisible();
		void loader.loadPreview(selectedFile());
	}

	// ── search / filter ─────────────────────────────────────────────────────────

	// Fuzzy-filter the file list (order-preserving — the agent's most-important-first
	// order is a documented contract, so no score re-sort). Rebuilding through
	// buildRows keeps only group headings that still have members.
	function applyListFilter(q: string) {
		listFilter = q;
		const prev = selectedFile();
		viewRows = q ? buildRows(files.filter((f) => fuzzyMatch(q, `${f.title} ${f.rel}`).matches)) : rows;
		let idx = prev ? viewRows.findIndex((r) => r.kind === "file" && r.file === prev) : -1;
		if (idx < 0) idx = viewRows.findIndex((r) => r.kind === "file");
		listSelected = Math.max(0, idx);
		listScroll = 0;
		const cur = selectedFile();
		if (cur !== prev) void loader.loadPreview(cur);
	}

	// Case-insensitive substring search over the raw file lines; jumps to the
	// first match at/after `origin` (wrapping to the first overall).
	function applyPreviewSearch(q: string, origin: number) {
		state.previewSearch = q;
		state.matchLines = [];
		if (!q || state.previewKind !== "file" || state.rendered) return;
		state.matchLines = computeMatchLines(state.fileLines, q);
		const first = firstMatchFrom(state.matchLines, origin);
		if (first !== undefined) {
			state.cursorLine = first;
			state.previewScroll = Math.max(0, state.cursorLine - 3);
			keepCursorVisible();
		}
	}

	function jumpMatch(dir: 1 | -1) {
		const target = nextMatchLine(state.matchLines, state.cursorLine, dir);
		if (target === undefined) return;
		state.cursorLine = target;
		state.previewScroll = Math.max(0, state.cursorLine - 3);
		keepCursorVisible();
		rerender();
	}

	function openSearch(scope: "list" | "preview") {
		editingSearch = scope;
		searchPrev = scope === "list" ? listFilter : state.previewSearch;
		searchOrigin = state.cursorLine;
		searchEditor.setText(searchPrev);
		rerender();
	}

	function enterPreview() {
		const file = selectedFile();
		if (!file) return;
		if (state.previewKind === "loading" || state.previewKind === "empty") return;
		focus = "preview";
		opened.add(file.rel);
		rerender();
	}

	// Single funnel for adding an @-mention to the chat editor + the result. Guards
	// against duplicates: a repeated `a` on the same mention neither appends to the
	// editor nor double-reports it — it just says so.
	function addMention(mention: string): void {
		if (added.includes(mention)) {
			ctx.ui.notify(`Already added ${mention}`, "info");
			return;
		}
		appendToEditor(ctx, mention);
		added.push(mention);
		ctx.ui.notify(`Added ${mention} to chat`, "info");
	}

	function addFileToChat(file: PresentedFile) {
		addMention(file.kind === "dir" ? dirMention(file.rel) : fileMention(file.rel));
	}

	function copyText(text: string, describe: string) {
		copyToClipboard(text).then(
			() => ctx.ui.notify(describe, "info"),
			(err) => ctx.ui.notify(`Copy failed: ${err instanceof Error ? err.message : String(err)}`, "error"),
		);
	}

	// Copy the accumulated mentions (space-joined) to the clipboard. Mentions
	// only, not the note — the note reaches the agent via the tool result, and
	// mixing it in would corrupt the paste payload.
	function copyMentions() {
		if (added.length === 0) {
			ctx.ui.notify("Nothing added yet — press a to add mentions first", "warning");
			return;
		}
		copyText(added.join(" "), `Copied ${added.length} mention${added.length !== 1 ? "s" : ""}`);
	}

	// `c` copies a *mention* (a reference): the active `s`/`v` selection's range
	// mention when there is one, otherwise the accumulated added mentions. Text
	// itself is `y` (yank) — see yankFromPreview.
	function copyFromPreview() {
		const file = state.previewFile;
		if (state.previewKind === "file" && !state.rendered && state.selAnchor !== null && file) {
			const mention = linesMention(file.rel, state.selAnchor + 1, state.cursorLine + 1);
			copyText(mention, `Copied mention: ${mention}`);
			return;
		}
		copyMentions();
	}

	// `y` (yank) copies actual file *text* to the host clipboard: the selected
	// lines if a selection is active, else the highlighted region under the cursor,
	// else the current line. Rendered previews yank the file's source text.
	function yankFromPreview(): void {
		const file = state.previewFile;
		if (state.previewKind === "file" && state.rendered) {
			copyText(state.fileText, `Copied ${file?.rel ?? "file"} text`);
			return;
		}
		if (state.previewKind !== "file" || state.fileLines.length === 0) {
			ctx.ui.notify("Nothing to yank here", "info");
			return;
		}
		let lo: number;
		let hi: number;
		if (state.selAnchor !== null) {
			lo = Math.min(state.selAnchor, state.cursorLine);
			hi = Math.max(state.selAnchor, state.cursorLine);
		} else {
			const here = regionAt(state.cursorLine);
			if (here) {
				const r = file!.regions[here.idx]!;
				lo = r.start - 1;
				hi = r.end - 1;
			} else {
				lo = state.cursorLine;
				hi = state.cursorLine;
			}
		}
		lo = Math.max(0, lo);
		hi = Math.min(state.fileLines.length - 1, hi);
		const n = hi - lo + 1;
		copyText(state.fileLines.slice(lo, hi + 1).join("\n"), `Copied ${n} line${n !== 1 ? "s" : ""} of text`);
	}

	function handleListInput(data: string): void {
		if (data === "q") {
			finish();
			return;
		}
		if (keys.cancel(data)) {
			pendingG = false;
			// Esc clears an active filter before it closes the panel (q always closes).
			if (listFilter) applyListFilter("");
			else {
				finish();
				return;
			}
			rerender();
			return;
		}
		// Notes are `m` everywhere (never `n` — n/p are region/search navigation).
		if (data === "m" || data === "M") {
			pendingG = false;
			openNoteEditor();
			return;
		}
		if (data === "/") {
			pendingG = false;
			openSearch("list");
			return;
		}
		if (data === "c") {
			pendingG = false;
			copyMentions();
			return;
		}
		if (keys.tab(data) || keys.right(data) || keys.confirm(data)) {
			pendingG = false;
			enterPreview();
			return;
		}
		if (data === "a" || data === "A") {
			pendingG = false;
			const file = selectedFile();
			if (file) addFileToChat(file);
			return;
		}
		const gg = handleGG(keys.goTop(data), pendingG, () => {
			jumpList(false);
			rerender();
		});
		pendingG = gg.pendingG;
		if (gg.handled) return;
		const scrolled = applyScrollKeys(keys, data, {
			toBottom: () => jumpList(true),
			move: moveList,
			page: () => contentH,
		});
		if (scrolled) rerender();
	}

	// ── preview navigation ────────────────────────────────────────────────────────

	function previewContentH(): number {
		// Rows of the right pane actually holding file content (description block
		// + its rule are laid out above the content inside the same contentH).
		return Math.max(1, contentH - descBlockRows());
	}

	function descBlockRows(): number {
		return descLinesCache.length > 0 ? descLinesCache.length + 1 : 0;
	}

	// Fixed rows the rendered HTML view spends on its snapshot banner. Derived from
	// htmlBannerLines() itself (width-independent count) so the two never drift.
	function renderedBannerRows(): number {
		if (!(state.previewKind === "file" && state.rendered && state.renderableAs === "html")) return 0;
		return htmlBannerLines(9999).length;
	}

	function keepCursorVisible() {
		state.previewScroll = clampVisible(state.cursorLine, state.previewScroll, previewContentH());
	}

	function moveCursor(delta: number) {
		const max = Math.max(0, state.fileLines.length - 1);
		state.cursorLine = Math.max(0, Math.min(max, state.cursorLine + delta));
		keepCursorVisible();
	}

	function regionAt(line0: number): { idx: number; note?: string } | null {
		const file = state.previewFile;
		if (!file) return null;
		return regionIndexAt(file.regions, line0);
	}

	function jumpRegion(dir: 1 | -1) {
		const file = state.previewFile;
		if (!file) return;
		const target = nextRegionStart(file.regions, state.fileLines.length, state.cursorLine, dir);
		if (target === undefined) return;
		state.cursorLine = target;
		state.previewScroll = Math.max(0, state.cursorLine - 3);
		keepCursorVisible();
		rerender();
	}

	// `a` in the raw preview adds the most specific mention available: an active
	// `s`/`v` selection wins, else the highlighted region under the cursor, else
	// the single cursor line (`@path:line`). A bare `@path` is never useful here —
	// the user is looking at a specific spot, so the mention should point at it.
	function addLinesToChat(file: PresentedFile) {
		let mention: string;
		if (state.selAnchor !== null) {
			mention = linesMention(file.rel, state.selAnchor + 1, state.cursorLine + 1);
			state.selAnchor = null;
		} else {
			const here = regionAt(state.cursorLine);
			const r = here ? file.regions[here.idx]! : null;
			mention = r ? linesMention(file.rel, r.start, r.end) : linesMention(file.rel, state.cursorLine + 1, state.cursorLine + 1);
		}
		addMention(mention);
	}

	function handlePreviewInput(data: string): void {
		const file = state.previewFile;
		// Tab always leaves to the curated list.
		if (keys.tab(data) || keys.shiftTab(data)) {
			pendingG = false;
			focus = "list";
			rerender();
			return;
		}
		if (data === "q") {
			finish();
			return;
		}
		if (data === "m" || data === "M") {
			pendingG = false;
			openNoteEditor();
			return;
		}
		// A directory preview is a constrained browser — it owns Enter / arrows /
		// up-navigation. (q, m, tab above still apply.)
		if (state.previewKind === "dir") {
			handleDirInput(data);
			return;
		}
		if (data === "c") {
			pendingG = false;
			copyFromPreview();
			return;
		}
		if (data === "y" || data === "Y") {
			pendingG = false;
			yankFromPreview();
			return;
		}
		// h / ← / Backspace: a file opened while browsing steps back up to its
		// listing; an ordinary preview returns to the curated list.
		if (keys.left(data) || data === "\x7f" || data === "\b") {
			pendingG = false;
			if (state.browsedChild && state.currentDir) {
				state.browsedChild = false;
				void loader.loadDir(state.currentDir, state.browseReturnCursor);
			} else {
				focus = "list";
			}
			rerender();
			return;
		}
		if (keys.cancel(data)) {
			pendingG = false;
			// Esc cascade: clear search → clear selection → (browsed child: back to
			// its listing) → back to the curated list.
			if (state.previewSearch) applyPreviewSearch("", 0);
			else if (state.selAnchor !== null) state.selAnchor = null;
			else if (state.browsedChild && state.currentDir) {
				state.browsedChild = false;
				void loader.loadDir(state.currentDir, state.browseReturnCursor);
			} else focus = "list";
			rerender();
			return;
		}

		// Rendered markdown/HTML: display-line scrolling, no line-level actions.
		if (state.previewKind === "file" && state.rendered) {
			if (data === "r") {
				pendingG = false;
				state.rendered = false;
				state.previewScroll = 0;
				state.cursorLine = 0;
				state.selAnchor = null;
				rerender();
				return;
			}
			if (data === "o" || data === "O") {
				pendingG = false;
				loader.openInBrowser();
				return;
			}
			if (data === "a" || data === "A") {
				pendingG = false;
				if (file) addFileToChat(file);
				return;
			}
			if (data === "/") {
				pendingG = false;
				ctx.ui.notify("Search works in the raw view — press r", "info");
				return;
			}
			if (data === "s" || data === "v" || data === "V" || data === "n" || data === "N" || data === "p" || data === "P") {
				pendingG = false;
				ctx.ui.notify("Line actions work in the raw view — press r", "info");
				return;
			}
			const gg = handleGG(keys.goTop(data), pendingG, () => {
				state.previewScroll = 0;
				rerender();
			});
			pendingG = gg.pendingG;
			if (gg.handled) return;
			// The HTML banner occupies fixed rows, so the scrollable text area is smaller.
			const textH = Math.max(1, previewContentH() - renderedBannerRows());
			const maxScroll = Math.max(0, state.renderedCount - textH);
			const scrolled = applyScrollKeys(keys, data, {
				toBottom: () => {
					state.previewScroll = maxScroll;
				},
				move: (d) => {
					state.previewScroll = Math.max(0, Math.min(maxScroll, state.previewScroll + d));
				},
				page: () => textH,
				// Kept from the original ladder: half-page steps by previewContentH()/2, not textH/2.
				halfPage: () => Math.max(1, Math.floor(previewContentH() / 2)),
			});
			if (scrolled) rerender();
			return;
		}

		if (state.previewKind === "file") {
			if (data === "r") {
				pendingG = false;
				if (state.renderableAs) {
					state.rendered = true;
					state.previewScroll = 0;
					state.cursorLine = 0;
					state.selAnchor = null;
					// Raw line indices are meaningless when rendered — drop the search.
					state.previewSearch = "";
					state.matchLines = [];
					rerender();
				}
				return;
			}
			if (state.renderableAs === "html" && (data === "o" || data === "O")) {
				pendingG = false;
				loader.openInBrowser();
				return;
			}
			if (data === "/") {
				pendingG = false;
				openSearch("preview");
				return;
			}
			if (data === "n" || data === "N") {
				pendingG = false;
				if (state.previewSearch) jumpMatch(data === "n" ? 1 : -1);
				else jumpRegion(data === "n" ? 1 : -1);
				return;
			}
			if (data === "p" || data === "P") {
				pendingG = false;
				if (state.previewSearch) jumpMatch(-1);
				else jumpRegion(-1);
				return;
			}
			if (data === "s" || data === "v" || data === "V") {
				pendingG = false;
				state.selAnchor = state.selAnchor === null ? state.cursorLine : null;
				rerender();
				return;
			}
			if (data === "a" || data === "A") {
				pendingG = false;
				if (file) addLinesToChat(file);
				rerender();
				return;
			}
			const gg = handleGG(keys.goTop(data), pendingG, () => {
				state.cursorLine = 0;
				keepCursorVisible();
				rerender();
			});
			pendingG = gg.pendingG;
			if (gg.handled) return;
			const scrolled = applyScrollKeys(keys, data, {
				toBottom: () => {
					state.cursorLine = Math.max(0, state.fileLines.length - 1);
					keepCursorVisible();
				},
				move: moveCursor,
				page: previewContentH,
			});
			if (scrolled) rerender();
			return;
		}

		// binary / missing / image preview: add only (nothing to scroll or search).
		if (data === "/") {
			pendingG = false;
			ctx.ui.notify("Nothing to search here", "info");
			return;
		}
		if (data === "a" || data === "A") {
			pendingG = false;
			if (file) addFileToChat(file);
			return;
		}
	}

	// Directory browser input (dispatched from handlePreviewInput while a listing
	// is on screen). ↑↓ select, Enter/→ open/descend, h/←/Backspace/Esc go up
	// (never above the curated root), a adds the selected entry's mention.
	function handleDirInput(data: string): void {
		const rows = browser.browseRows();
		if (data === "c") {
			pendingG = false;
			copyMentions();
			return;
		}
		if (data === "y" || data === "Y") {
			pendingG = false;
			ctx.ui.notify("Nothing to yank here", "info");
			return;
		}
		if (data === "a" || data === "A") {
			pendingG = false;
			const row = rows[state.dirCursor];
			if (row?.kind === "entry") browser.addBrowseEntryToChat(row);
			else if (state.previewFile) addFileToChat(state.previewFile); // ".." selected or empty → the current dir
			return;
		}
		if (data === "/") {
			pendingG = false;
			ctx.ui.notify("Nothing to search here", "info");
			return;
		}
		if (keys.confirm(data) || keys.right(data)) {
			pendingG = false;
			void browser.openBrowseRow(rows[state.dirCursor]);
			return;
		}
		if (keys.left(data) || keys.cancel(data) || data === "\x7f" || data === "\b") {
			pendingG = false;
			browser.browseUp();
			return;
		}
		const gg = handleGG(keys.goTop(data), pendingG, () => {
			state.dirCursor = 0;
			browser.keepDirCursorVisible();
			rerender();
		});
		pendingG = gg.pendingG;
		if (gg.handled) return;
		const scrolled = applyScrollKeys(keys, data, {
			toBottom: () => {
				state.dirCursor = Math.max(0, rows.length - 1);
				browser.keepDirCursorVisible();
			},
			move: browser.moveDirCursor,
			page: previewContentH,
		});
		if (scrolled) rerender();
	}

	// ── note editor ────────────────────────────────────────────────────────────────

	function openNoteEditor() {
		editingNote = true;
		noteEditor.setText(note);
		rerender();
	}

	function handleNoteInput(data: string): void {
		if (keys.cancel(data)) {
			editingNote = false;
			rerender();
			return;
		}
		noteEditor.handleInput(data);
		rerender();
	}

	// ── search input ────────────────────────────────────────────────────────────

	function handleSearchInput(data: string): void {
		if (keys.cancel(data)) {
			const scope = editingSearch;
			editingSearch = false;
			// Esc restores whatever was active before the input opened.
			if (scope === "list") applyListFilter(searchPrev);
			else if (scope === "preview") applyPreviewSearch(searchPrev, searchOrigin);
			rerender();
			return;
		}
		searchEditor.handleInput(data);
		rerender();
	}

	function handleInput(data: string): void {
		if (editingNote) handleNoteInput(data);
		else if (editingSearch) handleSearchInput(data);
		else if (focus === "list") handleListInput(data);
		else handlePreviewInput(data);
	}

	// ── rendering ──────────────────────────────────────────────────────────────────

	function listColumn(width: number): string[] {
		const out: string[] = [];
		if (viewRows.length === 0 && listFilter) {
			out.push(pad(theme.fg("dim", truncateToWidth(`  (no matches for "${listFilter}")`, Math.max(1, width), "…")), width));
		}
		const visible = viewRows.slice(listScroll, listScroll + contentH);
		for (let i = 0; i < visible.length; i++) {
			const row = visible[i]!;
			const idx = listScroll + i;
			if (row.kind === "group") {
				// A heading reads as a divider, not another option: outdented to
				// column 0 (its files indent under it), bold, and trailed by a rule
				// that runs to the pane edge so it can't be mistaken for a file row.
				const label = truncateToWidth(row.label.toUpperCase(), Math.max(1, width - 4), "…");
				const styled = theme.fg("muted", theme.bold(label));
				const dashes = Math.max(0, width - visibleWidth(label) - 1);
				out.push(pad(`${styled} ${theme.fg("borderMuted", "─".repeat(dashes))}`, width));
				continue;
			}
			const file = row.file;
			const isCursor = idx === listSelected;
			const wasOpened = opened.has(file.rel);
			// Files that live under a group heading indent one notch, so the list
			// visibly nests: heading at the margin, its files stepped in beneath it.
			const indent = file.group ? "  " : "";
			const pointer = isCursor
				? focus === "list"
					? theme.fg("accent", "› ")
					: theme.fg("dim", "› ")
				: "  ";
			let label = file.kind === "dir" && !file.title.endsWith("/") ? `${file.title}/` : file.title;
			if (file.kind === "missing") label += " (missing)";
			const markW = wasOpened ? 2 : 0;
			const text = truncateToWidth(label, Math.max(1, width - 4 - markW - indent.length), "…");
			let body: string;
			if (file.kind === "missing") body = theme.fg("dim", text);
			else if (isCursor) body = theme.fg(focus === "list" ? "accent" : "text", text);
			else body = theme.fg("text", text);
			const mark = wasOpened ? theme.fg("dim", " ·") : "";
			out.push(pad(`${indent}${pointer}${body}${mark}`, width));
		}
		while (out.length < contentH) out.push(pad("", width));
		return out;
	}

	// The image "card": path, type, dimensions, and size, plus an honest line about
	// why no pixels appear here (overlay compositing corrupts graphics escapes — see
	// the note by IMAGE_MIME). Never blank; every field the user asked for is shown.
	function imageCardLines(inner: number): string[] {
		const info = state.imageInfo;
		const lines: string[] = [];
		const push = (s: string) => lines.push(truncateToWidth(s, inner, "…"));
		push(theme.fg("accent", theme.bold(" Image")));
		push("");
		push(` ${theme.fg("text", state.previewFile?.rel ?? "")}`);
		const dims = info?.dims ? `${info.dims.widthPx}×${info.dims.heightPx} px` : "dimensions unknown";
		const meta = [info?.mime ?? "image", dims, info ? formatBytes(info.bytes) : ""].filter(Boolean).join("  ·  ");
		push(` ${theme.fg("muted", meta)}`);
		push("");
		let proto: string | null = null;
		try {
			proto = getCapabilities().images;
		} catch {
			proto = null;
		}
		push(` ${theme.fg("warning", "Terminal image preview unavailable.")}`);
		if (proto) {
			// The terminal *could* draw it, but not inside this overlay panel.
			push(` ${theme.fg("dim", `Your terminal supports ${proto} graphics, but this panel`)}`);
			push(` ${theme.fg("dim", "is an overlay and can't host inline images.")}`);
		} else {
			push(` ${theme.fg("dim", "No kitty or iTerm2 graphics support detected in this")}`);
			push(` ${theme.fg("dim", "terminal. Showing metadata only.")}`);
		}
		push("");
		push(` ${theme.fg("dim", "Press a to add it to chat, or open the path above in")}`);
		push(` ${theme.fg("dim", "an image viewer.")}`);
		return lines;
	}

	// Banner above the best-effort text in the rendered HTML view: reports the
	// browser-snapshot status and the `o` (open in browser) / `r` (raw) actions.
	// The snapshot can't paint inline (overlay), so this is how the user learns a
	// faithful render exists and how to see it.
	function htmlBannerLines(inner: number): string[] {
		const lines: string[] = [];
		const push = (s: string) => lines.push(truncateToWidth(s, inner, "…"));
		const s = state.htmlSnap;
		if (s.status === "pending") {
			push(` ${theme.fg("muted", `${ICON_LOADING} Rendering browser snapshot…`)}`);
		} else if (s.status === "done") {
			push(` ${theme.fg("success", `${ICON_SUCCESS} Rendered`)}${theme.fg("dim", "  ·  o open in browser  ·  r raw source")}`);
			const dim = s.width && s.height ? `${s.width}×${s.height}px  ·  ` : "";
			push(` ${theme.fg("dim", `snapshot (can't show inline): ${dim}${s.path}`)}`);
		} else if (s.status === "unavailable") {
			push(` ${theme.fg("warning", `${ICON_WARNING} No headless browser — best-effort text.`)}${theme.fg("dim", "  ·  o open in browser")}`);
		} else if (s.status === "failed") {
			push(` ${theme.fg("warning", `${ICON_WARNING} Browser render failed — best-effort text.`)}${theme.fg("dim", "  ·  o open in browser")}`);
			push(` ${theme.fg("dim", truncateToWidth(s.error, Math.max(10, inner - 2), "…"))}`);
		}
		if (lines.length > 0) push(theme.fg("borderMuted", ` ${"·".repeat(Math.max(1, Math.min(inner - 2, 40)))}`));
		return lines;
	}

	// Wrapped description lines for the currently previewed file, recomputed in render.
	let descLinesCache: string[] = [];

	function previewColumn(width: number): string[] {
		const inner = Math.max(8, width);
		const out: string[] = [];

		// Agent's per-file description block above the content — rendered as a
		// callout with a leading accent bar so it reads distinctly from the header
		// summary (which is muted with a "Summary" label) and from the content.
		if (descLinesCache.length > 0) {
			for (const l of descLinesCache) out.push(pad(`${theme.fg("accent", "▏")} ${theme.fg("muted", l)}`, inner));
			out.push(pad(theme.fg("borderMuted", ` ${"·".repeat(Math.max(1, Math.min(inner - 2, 30)))}`), inner));
		}
		const bodyH = Math.max(1, contentH - out.length);

		const fillBody = (lines: string[]): string[] => {
			const body = lines.slice(0, bodyH).map((l) => pad(l, inner));
			while (body.length < bodyH) body.push(pad("", inner));
			return [...out, ...body].slice(0, contentH);
		};

		if (state.previewKind === "image") return fillBody(imageCardLines(inner));
		if (state.previewKind === "loading") return fillBody([theme.fg("muted", " Loading…")]);
		if (state.previewKind === "empty") return fillBody([theme.fg("muted", " (nothing to preview)")]);
		if (state.previewKind === "binary") return fillBody([theme.fg("muted", " (binary file)")]);
		if (state.previewKind === "missing")
			return fillBody([theme.fg("warning", " This path does not exist on disk."), pad("", inner), theme.fg("dim", " The agent may have mistyped it; ask it to double-check.")]);

		if (state.previewKind === "dir") {
			// Constrained browser: a cursor selects entries; ".." (when descended)
			// leads back up; ↑↓ move, Enter/→ open, h/←/Esc go up.
			const browse = browser.browseRows();
			const visible = browse.slice(state.previewScroll, state.previewScroll + bodyH);
			const lines = visible.map((r, i) => {
				const idx = state.previewScroll + i;
				const isCursor = idx === state.dirCursor && focus === "preview";
				// isCursor already implies focus === "preview", so the pointer is always accent.
				const pointer = isCursor ? theme.fg("accent", "› ") : "  ";
				if (r.kind === "up") {
					return ` ${pointer}${theme.fg("muted", "../")}${theme.fg("dim", "  up")}`;
				}
				const nm = r.isDir ? `${r.name}/` : r.name;
				const icon = r.isDir ? theme.fg("accent", "▸ ") : theme.fg("dim", "· ");
				const styled = truncateToWidth(
					r.isDir ? theme.fg(isCursor ? "accent" : "text", nm) : theme.fg(isCursor ? "accent" : "dim", nm),
					Math.max(1, inner - 5),
					"…",
				);
				return ` ${pointer}${icon}${styled}`;
			});
			if (browse.length === 0) lines.push(theme.fg("muted", " (empty directory)"));
			return fillBody(lines);
		}

		// rendered markdown/HTML — display lines, no gutter, no cursor/selection.
		// HTML reserves a fixed banner at the top (snapshot status + o/r actions).
		if (state.previewKind === "file" && state.rendered && state.renderableAs) {
			const w = Math.max(8, inner - 2);
			let all: string[];
			let banner: string[] = [];
			if (state.renderableAs === "md") {
				state.mdComp ??= new Markdown(state.fileText.trim(), 0, 0, getMarkdownTheme());
				all = state.mdComp.render(w);
			} else {
				banner = htmlBannerLines(inner);
				if (!state.renderedCache || state.renderedCache.width !== w)
					state.renderedCache = { width: w, lines: wrapTextWithAnsi(htmlToText(state.fileText), w) };
				all = state.renderedCache.lines;
			}
			const avail = Math.max(1, bodyH - banner.length);
			state.renderedCount = all.length;
			state.previewScroll = Math.max(0, Math.min(state.previewScroll, Math.max(0, all.length - avail)));
			const text = all.slice(state.previewScroll, state.previewScroll + avail).map((l) => ` ${l}`);
			return fillBody([...banner, ...text]);
		}

		// file (raw)
		const file = state.previewFile;
		const gutterW = Math.max(3, String(state.fileLines.length).length);
		const lo = state.selAnchor !== null ? Math.min(state.selAnchor, state.cursorLine) : -1;
		const hi = state.selAnchor !== null ? Math.max(state.selAnchor, state.cursorLine) : -1;
		const matchSet = state.previewSearch ? new Set(state.matchLines) : null;
		const visible = state.fileLines.slice(state.previewScroll, state.previewScroll + bodyH);
		const lines: string[] = [];
		for (let i = 0; i < visible.length; i++) {
			const idx = state.previewScroll + i;
			const raw = (visible[i] ?? "").replace(/\t/g, "    ");
			const num = String(idx + 1).padStart(gutterW);
			const inSel = idx >= lo && idx <= hi;
			const inRegion = file ? file.regions.some((r) => idx + 1 >= r.start && idx + 1 <= r.end) : false;
			// Search matches read like regions but keep no background, so the two stay distinguishable.
			const inMatch = matchSet !== null && matchSet.has(idx);
			const isCursor = idx === state.cursorLine && focus === "preview";
			const numStyled = theme.fg(inSel || inRegion || inMatch || isCursor ? "accent" : "muted", num);
			const highlighted = state.highlightedLines[idx];
			const text = truncateToWidth(highlighted ?? raw, Math.max(1, inner - gutterW - 2), "…");
			let textStyled: string;
			if (highlighted !== undefined) {
				// Preserve token foreground colors. Search matches use an underline;
				// cursor, selection, and region states use row backgrounds below.
				textStyled = inMatch ? theme.underline(text) : text;
			} else if (isCursor || inSel || inRegion || inMatch) textStyled = theme.fg("text", text);
			else textStyled = theme.fg("dim", text);
			let rowStr = ` ${numStyled} ${textStyled}`;
			rowStr = pad(rowStr, inner);
			if (inSel || isCursor) rowStr = theme.bg("selectedBg", rowStr);
			else if (inRegion) rowStr = theme.bg("customMessageBg", rowStr);
			lines.push(rowStr);
		}
		return fillBody(lines);
	}

	// Header block: rule, title row (+ optional forwarding chain), optional summary.
	function buildHeader(innerW: number): string[] {
		const fileCount = files.length;
		const missingCount = files.filter((f) => f.kind === "missing").length;
		const header: string[] = [];
		header.push(rule(innerW));
		header.push(pad("", innerW)); // top padding above the title
		let counts = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		if (missingCount > 0) counts += `, ${missingCount} missing`;
		// Title indented one space, so it lines up with the padded body below.
		header.push(pad(truncateToWidth(` ${theme.bold(title)}${theme.fg("dim", `  ${counts}`)}`, innerW, "…"), innerW));
		// Who's showing — only when a subagent forwarded the presentation here.
		if (from && from.length > 0) {
			header.push(
				pad(truncateToWidth(` ${theme.fg("warning", from.join(" → "))}${theme.fg("dim", " is showing files:")}`, innerW, "…"), innerW),
			);
		}
		if (summary) {
			// A separated, labelled intro block — visually distinct from the
			// per-file description that appears in the right pane. The "Summary"
			// label sits on the first wrapped line; continuation lines align under it.
			header.push(pad("", innerW)); // blank line between title and summary
			const label = " Summary  ";
			const indent = " ".repeat(visibleWidth(label));
			const wrapped = wrapTextWithAnsi(summary, Math.max(10, innerW - visibleWidth(label) - 1)).slice(0, 3);
			wrapped.forEach((l, i) => {
				const styled = i === 0 ? theme.fg("dim", label) + theme.fg("muted", l) : theme.fg("muted", indent + l);
				header.push(pad(truncateToWidth(styled, innerW, "…"), innerW));
			});
		}
		header.push(pad("", innerW)); // bottom padding below the header block
		return header;
	}

	// Pane-labels row: list label (an active filter stays visible after the input
	// closes) │ preview label with selection / search / region / browse info.
	function buildLabelRow(leftW: number, rightW: number, sep: string): string {
		const filterInfo = listFilter ? theme.fg("accent", ` /${listFilter}`) : "";
		const listLabel =
			(focus === "list" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "list" ? theme.fg("text", "Files") : theme.fg("dim", "Files")) +
			truncateToWidth(filterInfo, Math.max(0, leftW - 8), "…");
		const file = state.previewFile;
		const prevTitle = file ? file.rel : "Preview";
		const selInfo =
			state.previewKind === "file" && state.selAnchor !== null
				? theme.fg("accent", `  sel ${Math.min(state.selAnchor, state.cursorLine) + 1}-${Math.max(state.selAnchor, state.cursorLine) + 1}`)
				: "";
		let regionInfo = "";
		if (state.previewKind === "file" && !state.rendered && state.previewSearch) {
			// Active in-file search takes over the info slot: query + position.
			const pos = state.matchLines.filter((l) => l <= state.cursorLine).length;
			regionInfo = theme.fg("accent", `  /${state.previewSearch}  [${pos}/${state.matchLines.length}]`);
		} else if (state.previewKind === "file" && !state.rendered && file && file.regions.length > 0) {
			const cur = regionAt(state.cursorLine);
			if (cur) {
				regionInfo = theme.fg("accent", `  [${cur.idx + 1}/${file.regions.length}]`);
				if (cur.note) regionInfo += theme.fg("muted", ` ${cur.note}`);
			} else {
				regionInfo = theme.fg("dim", `  ${file.regions.length} region${file.regions.length !== 1 ? "s" : ""} (n/p)`);
			}
		}
		if (state.previewKind === "file" && state.renderableAs)
			regionInfo += theme.fg("dim", state.rendered ? "  · rendered (r: raw)" : "  · raw (r: rendered)");
		// A directory is a constrained browser — show the cursor position within it.
		if (state.previewKind === "dir") {
			const n = browser.browseRows().length;
			regionInfo += theme.fg("dim", `  · browse  [${Math.min(state.dirCursor + 1, n)}/${n}]`);
		}
		const prevLabelText = truncateToWidth(prevTitle, Math.max(4, rightW - 8), "…");
		const prevLabel =
			(focus === "preview" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "preview" ? theme.fg("text", prevLabelText) : theme.fg("dim", prevLabelText)) +
			selInfo +
			truncateToWidth(regionInfo, Math.max(0, rightW - visibleWidth(prevLabelText) - visibleWidth(selInfo) - 2), "…");
		return pad(truncateToWidth(listLabel, leftW, ""), leftW) + sep + pad(truncateToWidth(prevLabel, rightW, ""), rightW);
	}

	// Footer hint line — one branch per surface (list, rendered file, raw file,
	// dir browser, image, binary/missing), spelling out the keys that work there.
	function footerHint(): string {
		const noteInfo = note ? ` · ${ICON_SUCCESS} note` : "";
		const hasSel = state.previewKind === "file" && !state.rendered && state.selAnchor !== null;
		// What `a` will add at the cursor's current spot, so the hint isn't a lie.
		const inRegion = state.previewKind === "file" && !state.rendered && regionAt(state.cursorLine) !== null;
		const addLabel = hasSel ? "a add range" : inRegion ? "a add region" : "a add line";
		// A curated dir adds its `@dir/` mention from either focus — say so.
		const listAdd = selectedFile()?.kind === "dir" ? "a add @dir/" : "a add mention";
		const openHtml = state.renderableAs === "html" ? " · o open browser" : "";
		if (focus === "list")
			return `↑↓ move · Enter open · / filter · ${listAdd} · c copy mention · m note${noteInfo} · q close`;
		if (state.previewKind === "file" && state.rendered)
			return `↑↓ scroll · r raw${openHtml} · a add file · c copy mention · y copy text · m note${noteInfo} · Tab back · q close`;
		if (state.previewKind === "file")
			return `↑↓ line · n/p ${state.previewSearch ? "match" : "region"} · / search${state.renderableAs ? " · r rendered" : ""}${openHtml} · s select · ${addLabel} · c copy mention · y copy text · m note${noteInfo} · Tab back · q close`;
		if (state.previewKind === "dir")
			return `↑↓ select · Enter open · h/⌫ up · a add mention · c copy mention · m note${noteInfo} · q close`;
		if (state.previewKind === "image") return `a add file · c copy mention · m note${noteInfo} · Tab back · q close`;
		return `↑↓ scroll · a add · c copy mention · m note${noteInfo} · Tab back · q close`;
	}

	function render(width: number): string[] {
		const targetH = panelRows();
		if (cachedLines && cachedWidth === width && cachedHeight === targetH) return cachedLines;

		// TUI components must not render beyond the supplied width.
		const innerW = Math.max(1, width);
		if (innerW < 10) {
			const lines = [truncateToWidth(theme.bold("Show files"), innerW, "")];
			while (lines.length < targetH) lines.push(" ".repeat(innerW));
			cachedWidth = width;
			cachedHeight = targetH;
			cachedLines = lines;
			return lines;
		}
		const sepW = innerW >= 24 ? 3 : 1;
		const sep = theme.fg("borderMuted", sepW === 3 ? " │ " : "│");
		const available = Math.max(0, innerW - sepW);
		const leftW = Math.max(0, Math.min(52, Math.floor(available * 0.38)));
		const rightW = Math.max(0, available - leftW);

		const header = buildHeader(innerW);
		const labelRow = buildLabelRow(leftW, rightW, sep);
		const file = state.previewFile;

		// Description block for the previewed file (used by previewColumn via cache).
		descLinesCache =
			file?.description &&
			(state.previewKind === "file" || state.previewKind === "dir" || state.previewKind === "image" || state.previewKind === "binary" || state.previewKind === "missing")
				? wrapTextWithAnsi(file.description, Math.max(10, rightW - 2)).slice(0, 4)
				: [];

		// Footer: the hint row, the note editor block, or the search input block.
		const footer: string[] = [rule(innerW)];
		if (editingNote) {
			footer.push(pad(theme.fg("accent", " Note to agent") + theme.fg("dim", "  (Enter to save, Esc to cancel — sent with the tool result)"), innerW));
			for (const l of noteEditor.render(Math.max(10, innerW - 2))) footer.push(pad(` ${l}`, innerW));
		} else if (editingSearch) {
			const searchLabel = editingSearch === "list" ? "Search files (fuzzy)" : `Search in ${file?.rel ?? "file"}`;
			footer.push(pad(theme.fg("accent", ` ${searchLabel}`) + theme.fg("dim", "  (Enter keep, Esc cancel)"), innerW));
			for (const l of searchEditor.render(Math.max(10, innerW - 2))) footer.push(pad(` ${l}`, innerW));
		} else {
			footer.push(pad(theme.fg("dim", ` ${truncateToWidth(footerHint(), innerW - 2, "…")}`), innerW));
		}

		const overhead = header.length + 1 /*labels*/ + footer.length;
		contentH = Math.max(1, targetH - overhead);

		// clamp scrolls
		listScroll = Math.min(listScroll, Math.max(0, viewRows.length - contentH));
		keepListVisible();

		const leftCol = listColumn(leftW);
		const rightCol = previewColumn(rightW);

		const lines: string[] = [...header, labelRow];
		for (let i = 0; i < contentH; i++) {
			lines.push(`${leftCol[i] ?? pad("", leftW)}${sep}${rightCol[i] ?? pad("", rightW)}`);
		}
		lines.push(...footer);

		if (lines.length < targetH) {
			const insertAt = header.length + 1 + contentH;
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
