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
 */

import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	copyToClipboard,
	DynamicBorder,
	getLanguageFromPath,
	getMarkdownTheme,
	highlightCode,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	Editor,
	type EditorTheme,
	fuzzyMatch,
	getCapabilities,
	getImageDimensions,
	Markdown,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { appendToEditor, dirMention, type EditorUi, fileMention, linesMention } from "./add-to-chat.ts";
import { findChromium, openExternally, renderHtmlSnapshot, snapshotPathFor } from "./browser.ts";
import { createNavKeys } from "./keys.ts";
import type { PresentedFile } from "./files.ts";
import { htmlToText, renderableKind, type RenderableKind } from "./rendered.ts";

const MAX_PREVIEW_BYTES = 512 * 1024;
const ICON_LOADING = ""; // nf-fa-spinner
const ICON_SUCCESS = ""; // nf-fa-check
const ICON_WARNING = ""; // nf-fa-warning
// Only the file header is needed to read image dimensions — avoid base64-ing a
// whole (possibly multi-MB) image just to show a metadata card.
const IMAGE_HEADER_BYTES = 128 * 1024;

// Images are presented as a metadata card (path · type · dimensions · size), not
// inline pixels: this panel is a full-screen TUI *overlay*, and the overlay
// compositor rewrites each line's segments (padding + resets), which corrupts
// the kitty/iTerm2 graphics escape sequences. Inline terminal images only
// survive in the base transcript, not here. See the image branch in previewColumn.
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

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
type PreviewKind = "file" | "dir" | "image" | "binary" | "missing" | "empty" | "loading";
type Row = { kind: "group"; label: string } | { kind: "file"; file: PresentedFile };

function buildRows(files: PresentedFile[]): Row[] {
	const rows: Row[] = [];
	let lastGroup: string | undefined;
	for (const f of files) {
		if (f.group && f.group !== lastGroup) rows.push({ kind: "group", label: f.group });
		if (f.group) lastGroup = f.group;
		rows.push({ kind: "file", file: f });
	}
	return rows;
}

export function createShowFilesPanel(opts: ShowFilesPanelOptions): Component {
	const { title, summary, files, from, ctx, tui, theme, keybindings, onDone } = opts;
	const keys = createNavKeys(keybindings);

	const rows = buildRows(files);
	let listSelected = rows.findIndex((r) => r.kind === "file");
	if (listSelected < 0) listSelected = 0;
	let listScroll = 0;
	let focus: Focus = "list";
	let pendingG = false;

	// Preview state
	let previewFile: PresentedFile | null = null;
	let previewKind: PreviewKind = "empty";
	let fileLines: string[] = [];
	let dirEntries: Array<{ name: string; isDir: boolean }> = [];
	let previewScroll = 0;
	let cursorLine = 0;
	let selAnchor: number | null = null;
	let loadToken = 0;
	// Metadata for the image card (dimensions may be null if the header is unreadable).
	let imageInfo: { mime: string; bytes: number; dims: { widthPx: number; heightPx: number } | null } | null = null;

	// Directory drill-in. A curated directory is a *constrained* browse root: you
	// can descend into it and pop back up, but never above it. browseRoot/­RootRel
	// pin the boundary + mention base; currentDir is the listing on screen; the
	// stack remembers where to land on the way back up. A child file opened while
	// browsing sets browsedChild so Esc/h returns to the listing (not the curated
	// list). curatedDir keeps the agent's original dir item (title/description) for
	// the root; descended dirs use a synthetic PresentedFile.
	let browseRoot: string | null = null;
	let browseRootRel: string | null = null;
	let curatedDir: PresentedFile | null = null;
	let currentDir: string | null = null;
	let dirCursor = 0;
	let browseStack: Array<{ dir: string; cursor: number }> = [];
	let browsedChild = false;
	let browseReturnCursor = 0;

	type BrowseRow = { kind: "up" } | { kind: "entry"; name: string; isDir: boolean };

	// Rendered-preview state (markdown/HTML, `r` toggles rendered↔raw)
	let fileText = "";
	// ANSI-colored source lines for raw previews. This uses the same Pi
	// highlighter as fenced code in chat, while fileLines stays untouched for
	// searching, selections, yanking, and line-number accuracy.
	let highlightedLines: string[] = [];
	let renderableAs: RenderableKind | null = null;
	let rendered = false;
	let mdComp: Markdown | null = null; // lazy; caches per width internally
	let renderedCache: { width: number; lines: string[] } | null = null; // html path
	let renderedCount = 0; // display lines at the last rendered paint (for scroll clamp)

	// HTML browser-snapshot state. A rendered HTML preview kicks off a headless
	// Chromium screenshot (local-only, network blocked) so the user can `o`-open a
	// faithful render; the snapshot itself can't paint inline (overlay), so the
	// rendered view stays the best-effort text with a banner about the snapshot.
	// chromiumProbe: undefined = not looked up yet, null = none found, string = path.
	let chromiumProbe: string | null | undefined;
	let snapToken = 0;
	type HtmlSnap =
		| { status: "idle" }
		| { status: "pending" }
		| { status: "unavailable" }
		| { status: "failed"; error: string }
		| { status: "done"; path: string; width?: number; height?: number };
	let htmlSnap: HtmlSnap = { status: "idle" };

	// Search state — a list filter and an in-file search coexist independently.
	let viewRows: Row[] = rows; // effective (possibly filtered) list
	let listFilter = "";
	let previewSearch = "";
	let matchLines: number[] = []; // 0-based raw lines containing previewSearch
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
			if (value && matchLines.length === 0) ctx.ui.notify("No matches", "info");
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

	function rebuildSyntaxHighlighting() {
		highlightedLines = [];
		const file = previewFile;
		if (!file || previewKind !== "file") return;
		const lang = getLanguageFromPath(file.abs);
		if (!lang) return;
		try {
			const highlighted = highlightCode(fileText.replace(/\t/g, "    "), lang);
			// A mismatch would break the raw-line cursor, gutter, and region mapping.
			// Fall back to the existing plain rendering rather than misaligning them.
			if (highlighted.length === fileLines.length) highlightedLines = highlighted;
		} catch {
			// Syntax coloring is presentation-only; raw preview must always remain usable.
			highlightedLines = [];
		}
	}

	function invalidate() {
		clearRenderCache();
		// highlightCode and Markdown bake the current theme's ANSI colors into
		// cached output, so rebuild those caches when the TUI invalidates us.
		rebuildSyntaxHighlighting();
		mdComp?.invalidate();
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

	// ── preview loading ─────────────────────────────────────────────────────────

	// Clears the per-preview render state. Deliberately does NOT touch the browse
	// context (browseRoot/currentDir/stack) — loadDir/loadChildFile reuse it while
	// staying inside a directory; only loadPreview resets the browse context.
	function resetPreviewState() {
		previewScroll = 0;
		cursorLine = 0;
		selAnchor = null;
		fileLines = [];
		dirEntries = [];
		imageInfo = null;
		fileText = "";
		highlightedLines = [];
		renderableAs = null;
		rendered = false;
		mdComp = null;
		renderedCache = null;
		renderedCount = 0;
		previewSearch = ""; // in-file search is per-file (the list filter persists)
		matchLines = [];
		htmlSnap = { status: "idle" };
		snapToken++; // invalidate any in-flight snapshot for the previous file
	}

	// Load a curated item (from the left list). Resets the browse context; a
	// directory becomes the browse root, a file loads its content.
	async function loadPreview(file: PresentedFile | undefined) {
		resetPreviewState();
		browseRoot = null;
		browseRootRel = null;
		curatedDir = null;
		currentDir = null;
		dirCursor = 0;
		browseStack = [];
		browsedChild = false;

		if (!file) {
			previewFile = null;
			previewKind = "empty";
			rerender();
			return;
		}
		previewFile = file;
		if (file.kind === "missing") {
			previewKind = "missing";
			rerender();
			return;
		}
		if (file.kind === "dir") {
			browseRoot = file.abs;
			browseRootRel = file.rel;
			curatedDir = file;
			await loadDir(file.abs);
			return;
		}
		await loadFileContent(file);
	}

	// Map an absolute path under the browse root to a mention/display path that
	// matches the curated dir's rel (relative when it was relative, else absolute).
	function browseRel(abs: string): string {
		if (!browseRoot || browseRootRel === null) return abs;
		if (abs === browseRoot) return browseRootRel;
		return `${browseRootRel}${abs.slice(browseRoot.length)}`; // slice keeps the leading "/"
	}

	// List a directory (the curated root or a descendant). Keeps the browse
	// context; only resets render state. `cursorTo` lands the selection (used when
	// popping back up so we return to the entry we descended from).
	async function loadDir(abs: string, cursorTo = 0) {
		resetPreviewState();
		browsedChild = false;
		currentDir = abs;
		previewKind = "loading";
		previewFile =
			abs === browseRoot && curatedDir
				? curatedDir
				: { rel: browseRel(abs), abs, kind: "dir", title: basename(abs), regions: [] };
		const token = ++loadToken;
		rerender();
		try {
			const dirents = await readdir(abs, { withFileTypes: true });
			const entries: Array<{ name: string; isDir: boolean }> = [];
			for (const d of dirents) {
				let isDir = d.isDirectory();
				if (d.isSymbolicLink()) {
					try {
						isDir = (await stat(join(abs, d.name))).isDirectory();
					} catch {
						isDir = false;
					}
				}
				entries.push({ name: d.name, isDir });
			}
			entries.sort((a, b) =>
				a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
			);
			if (token !== loadToken) return;
			dirEntries = entries;
			previewKind = "dir";
		} catch {
			if (token !== loadToken) return;
			dirEntries = [];
			previewKind = "missing";
		}
		dirCursor = Math.max(0, Math.min(cursorTo, browseRows().length - 1));
		keepDirCursorVisible();
		rerender();
	}

	// Preview a file discovered by browsing — reuses the raw-file machinery via a
	// synthetic PresentedFile, without disturbing the browse context.
	async function loadChildFile(abs: string, rel: string) {
		await loadFileContent({ rel, abs, kind: "file", title: basename(abs), regions: [] });
	}

	async function loadFileContent(file: PresentedFile) {
		resetPreviewState();
		previewFile = file;
		previewKind = "loading";
		const token = ++loadToken;
		rerender();
		try {
			const ext = file.abs.slice(file.abs.lastIndexOf(".") + 1).toLowerCase();
			const mime = IMAGE_MIME[ext];
			// Never read an arbitrarily large file merely to decide it is too large.
			// Images need only their header; text/binary previews need at most the
			// configured limit plus one byte to detect truncation.
			const handle = await open(file.abs, "r");
			let size = 0;
			let buf: Buffer;
			try {
				const info = await handle.stat();
				size = info.size;
				const limit = mime ? IMAGE_HEADER_BYTES : MAX_PREVIEW_BYTES + 1;
				const length = Math.min(size, limit);
				buf = Buffer.alloc(length);
				if (length > 0) await handle.read(buf, 0, length, 0);
			} finally {
				await handle.close();
			}
			if (token !== loadToken) return;
			if (mime) {
				// Parse dimensions from the header only (cheap); the card shows path,
				// type, dimensions, and size — see the image branch in previewColumn.
				// A dimension-parse failure must NOT drop us to "missing" — the card is
				// still useful with dims unknown, so it's guarded independently.
				let dims: { widthPx: number; heightPx: number } | null = null;
				try {
					dims = getImageDimensions(buf.toString("base64"), mime) ?? null;
				} catch {
					dims = null;
				}
				imageInfo = { mime, bytes: size, dims };
				previewKind = "image";
			} else if (size > MAX_PREVIEW_BYTES) {
				fileLines = [`(file too large to preview — ${(size / 1024).toFixed(0)} KB)`];
				previewKind = "file";
			} else if (buf.includes(0)) {
				previewKind = "binary";
			} else {
				fileText = buf.toString("utf8");
				fileLines = fileText.split("\n");
				previewKind = "file";
				rebuildSyntaxHighlighting();
				// Markdown/HTML render by default — but regions reference raw line
				// numbers, so a spec with regions opens raw.
				renderableAs = renderableKind(file.abs);
				rendered = renderableAs !== null && file.regions.length === 0;
				// Open on the agent's first highlight region, a few lines of breathing room above.
				const first = file.regions[0];
				if (first) {
					cursorLine = Math.min(first.start - 1, Math.max(0, fileLines.length - 1));
					previewScroll = Math.max(0, cursorLine - 3);
				}
				// Kick off a headless browser snapshot for HTML (best-effort, async).
				if (renderableAs === "html") void startHtmlSnapshot(file);
			}
		} catch {
			if (token !== loadToken) return;
			previewKind = "missing";
		}
		rerender();
	}

	// Render the HTML file to a PNG with a local headless Chromium so the user can
	// `o`-open a faithful view. Best-effort + cached by mtime (so arrowing back to
	// the same file doesn't relaunch a browser). The result never paints inline —
	// it drives the banner in the rendered HTML view. Guarded by snapToken so a
	// stale in-flight snapshot for a previous file can't overwrite current state.
	async function startHtmlSnapshot(file: PresentedFile) {
		const token = ++snapToken;
		htmlSnap = { status: "pending" };
		rerender();
		if (chromiumProbe === undefined) chromiumProbe = await findChromium();
		if (token !== snapToken) return;
		if (!chromiumProbe) {
			htmlSnap = { status: "unavailable" };
			rerender();
			return;
		}
		const out = snapshotPathFor(file.abs);
		const finishDone = async () => {
			let dims: { widthPx: number; heightPx: number } | null = null;
			try {
				const buf = await readFile(out);
				dims = getImageDimensions(buf.subarray(0, IMAGE_HEADER_BYTES).toString("base64"), "image/png") ?? null;
			} catch {
				dims = null;
			}
			if (token !== snapToken) return;
			htmlSnap = { status: "done", path: out, width: dims?.widthPx, height: dims?.heightPx };
			rerender();
		};
		// Reuse a fresh cached snapshot (newer than the source) instead of relaunching.
		try {
			const [png, src] = await Promise.all([stat(out), stat(file.abs)]);
			if (png.mtimeMs >= src.mtimeMs) {
				await finishDone();
				return;
			}
		} catch {
			// no cached snapshot yet — fall through and render one
		}
		if (token !== snapToken) return;
		const res = await renderHtmlSnapshot(chromiumProbe, file.abs, out);
		if (token !== snapToken) return;
		if (!res.ok) {
			htmlSnap = { status: "failed", error: res.error };
			rerender();
			return;
		}
		await finishDone();
	}

	function openInBrowser() {
		const f = previewFile;
		if (!f || renderableAs !== "html") {
			ctx.ui.notify("Open in browser is for HTML files", "info");
			return;
		}
		ctx.ui.notify(`Opening ${f.rel} in your browser…`, "info");
		openExternally(f.abs).then((r) => {
			if (!r.ok) ctx.ui.notify(`Couldn't open externally: ${r.error ?? "no opener found"}`, "error");
		});
	}

	// The rows shown in a directory preview: a synthetic ".." when we've descended
	// below the curated root, followed by the entries.
	function browseRows(): BrowseRow[] {
		const out: BrowseRow[] = [];
		if (currentDir && browseRoot && currentDir !== browseRoot) out.push({ kind: "up" });
		for (const e of dirEntries) out.push({ kind: "entry", name: e.name, isDir: e.isDir });
		return out;
	}

	function keepDirCursorVisible() {
		const h = previewContentH();
		if (dirCursor < previewScroll) previewScroll = dirCursor;
		if (dirCursor >= previewScroll + h) previewScroll = dirCursor - h + 1;
	}

	function moveDirCursor(delta: number) {
		const n = browseRows().length;
		if (n === 0) return;
		dirCursor = Math.max(0, Math.min(n - 1, dirCursor + delta));
		keepDirCursorVisible();
	}

	// Enter/→ on a browse row: descend into a subdir, or preview a child file.
	async function openBrowseRow(row: BrowseRow | undefined) {
		if (!row || !currentDir) return;
		if (row.kind === "up") {
			browseUp();
			return;
		}
		const childAbs = join(currentDir, row.name);
		if (row.isDir) {
			browseStack.push({ dir: currentDir, cursor: dirCursor });
			await loadDir(childAbs);
		} else {
			const rel = browseRel(childAbs);
			opened.add(rel);
			browsedChild = true;
			browseReturnCursor = dirCursor;
			await loadChildFile(childAbs, rel);
		}
	}

	// Go up one level — but never above the curated root: at the root, Esc/h/⌫
	// simply returns focus to the left list.
	function browseUp() {
		if (browseStack.length > 0) {
			const prev = browseStack.pop()!;
			void loadDir(prev.dir, prev.cursor);
		} else {
			focus = "list";
			rerender();
		}
	}

	function addBrowseEntryToChat(row: Extract<BrowseRow, { kind: "entry" }>) {
		if (!currentDir) return;
		const rel = browseRel(join(currentDir, row.name));
		addMention(row.isDir ? dirMention(rel) : fileMention(rel));
	}

	void loadPreview(selectedFile());

	// ── list navigation ──────────────────────────────────────────────────────────

	function keepListVisible() {
		if (listSelected < listScroll) listScroll = listSelected;
		if (listSelected >= listScroll + contentH) listScroll = listSelected - contentH + 1;
	}

	function moveList(delta: number) {
		if (viewRows.length === 0) return;
		const dir = delta < 0 ? -1 : 1;
		let idx = listSelected;
		let remaining = Math.abs(delta);
		while (remaining > 0) {
			let next = idx + dir;
			while (next >= 0 && next < viewRows.length && viewRows[next]!.kind === "group") next += dir;
			if (next < 0 || next >= viewRows.length) break;
			idx = next;
			remaining--;
		}
		if (idx !== listSelected) {
			listSelected = idx;
			keepListVisible();
			void loadPreview(selectedFile());
		}
	}

	function jumpList(toEnd: boolean) {
		const idxs = viewRows.map((r, i) => (r.kind === "file" ? i : -1)).filter((i) => i >= 0);
		if (idxs.length === 0) return;
		listSelected = toEnd ? idxs[idxs.length - 1]! : idxs[0]!;
		keepListVisible();
		void loadPreview(selectedFile());
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
		if (cur !== prev) void loadPreview(cur);
	}

	// Case-insensitive substring search over the raw file lines; jumps to the
	// first match at/after `origin` (wrapping to the first overall).
	function applyPreviewSearch(q: string, origin: number) {
		previewSearch = q;
		matchLines = [];
		if (!q || previewKind !== "file" || rendered) return;
		const needle = q.toLowerCase();
		for (let i = 0; i < fileLines.length; i++) {
			if (fileLines[i]!.toLowerCase().includes(needle)) matchLines.push(i);
		}
		if (matchLines.length > 0) {
			cursorLine = matchLines.find((l) => l >= origin) ?? matchLines[0]!;
			previewScroll = Math.max(0, cursorLine - 3);
			keepCursorVisible();
		}
	}

	function jumpMatch(dir: 1 | -1) {
		if (matchLines.length === 0) return;
		let target: number | undefined;
		if (dir > 0) target = matchLines.find((l) => l > cursorLine) ?? matchLines[0];
		else target = [...matchLines].reverse().find((l) => l < cursorLine) ?? matchLines[matchLines.length - 1];
		if (target === undefined) return;
		cursorLine = target;
		previewScroll = Math.max(0, cursorLine - 3);
		keepCursorVisible();
		rerender();
	}

	function openSearch(scope: "list" | "preview") {
		editingSearch = scope;
		searchPrev = scope === "list" ? listFilter : previewSearch;
		searchOrigin = cursorLine;
		searchEditor.setText(searchPrev);
		rerender();
	}

	function enterPreview() {
		const file = selectedFile();
		if (!file) return;
		if (previewKind === "loading" || previewKind === "empty") return;
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
		const file = previewFile;
		if (previewKind === "file" && !rendered && selAnchor !== null && file) {
			const mention = linesMention(file.rel, selAnchor + 1, cursorLine + 1);
			copyText(mention, `Copied mention: ${mention}`);
			return;
		}
		copyMentions();
	}

	// `y` (yank) copies actual file *text* to the host clipboard: the selected
	// lines if a selection is active, else the highlighted region under the cursor,
	// else the current line. Rendered previews yank the file's source text.
	function yankFromPreview(): void {
		const file = previewFile;
		if (previewKind === "file" && rendered) {
			copyText(fileText, `Copied ${file?.rel ?? "file"} text`);
			return;
		}
		if (previewKind !== "file" || fileLines.length === 0) {
			ctx.ui.notify("Nothing to yank here", "info");
			return;
		}
		let lo: number;
		let hi: number;
		if (selAnchor !== null) {
			lo = Math.min(selAnchor, cursorLine);
			hi = Math.max(selAnchor, cursorLine);
		} else {
			const here = regionAt(cursorLine);
			if (here) {
				const r = file!.regions[here.idx]!;
				lo = r.start - 1;
				hi = r.end - 1;
			} else {
				lo = cursorLine;
				hi = cursorLine;
			}
		}
		lo = Math.max(0, lo);
		hi = Math.min(fileLines.length - 1, hi);
		const n = hi - lo + 1;
		copyText(fileLines.slice(lo, hi + 1).join("\n"), `Copied ${n} line${n !== 1 ? "s" : ""} of text`);
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
		if (keys.goTop(data)) {
			if (pendingG) {
				pendingG = false;
				jumpList(false);
				rerender();
			} else {
				pendingG = true;
			}
			return;
		}
		pendingG = false;
		if (keys.goBottom(data)) jumpList(true);
		else if (keys.up(data)) moveList(-1);
		else if (keys.down(data)) moveList(1);
		else if (keys.pageUp(data)) moveList(-contentH);
		else if (keys.pageDown(data)) moveList(contentH);
		else if (keys.halfPageUp(data)) moveList(-Math.max(1, Math.floor(contentH / 2)));
		else if (keys.halfPageDown(data)) moveList(Math.max(1, Math.floor(contentH / 2)));
		else return;
		rerender();
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
		if (!(previewKind === "file" && rendered && renderableAs === "html")) return 0;
		return htmlBannerLines(9999).length;
	}

	function keepCursorVisible() {
		const h = previewContentH();
		if (cursorLine < previewScroll) previewScroll = cursorLine;
		if (cursorLine >= previewScroll + h) previewScroll = cursorLine - h + 1;
	}

	function moveCursor(delta: number) {
		const max = Math.max(0, fileLines.length - 1);
		cursorLine = Math.max(0, Math.min(max, cursorLine + delta));
		keepCursorVisible();
	}

	function regionAt(line0: number): { idx: number; note?: string } | null {
		const file = previewFile;
		if (!file) return null;
		for (let i = 0; i < file.regions.length; i++) {
			const r = file.regions[i]!;
			if (line0 + 1 >= r.start && line0 + 1 <= r.end) return { idx: i, note: r.note };
		}
		return null;
	}

	function jumpRegion(dir: 1 | -1) {
		const file = previewFile;
		if (!file || file.regions.length === 0) return;
		const starts = file.regions.map((r) => Math.min(r.start - 1, Math.max(0, fileLines.length - 1)));
		let target: number | undefined;
		if (dir > 0) target = starts.find((s) => s > cursorLine) ?? starts[0];
		else target = [...starts].reverse().find((s) => s < cursorLine) ?? starts[starts.length - 1];
		if (target === undefined) return;
		cursorLine = target;
		previewScroll = Math.max(0, cursorLine - 3);
		keepCursorVisible();
		rerender();
	}

	// `a` in the raw preview adds the most specific mention available: an active
	// `s`/`v` selection wins, else the highlighted region under the cursor, else
	// the single cursor line (`@path:line`). A bare `@path` is never useful here —
	// the user is looking at a specific spot, so the mention should point at it.
	function addLinesToChat(file: PresentedFile) {
		let mention: string;
		if (selAnchor !== null) {
			mention = linesMention(file.rel, selAnchor + 1, cursorLine + 1);
			selAnchor = null;
		} else {
			const here = regionAt(cursorLine);
			const r = here ? file.regions[here.idx]! : null;
			mention = r ? linesMention(file.rel, r.start, r.end) : linesMention(file.rel, cursorLine + 1, cursorLine + 1);
		}
		addMention(mention);
	}

	function handlePreviewInput(data: string): void {
		const file = previewFile;
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
		if (previewKind === "dir") {
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
			if (browsedChild && currentDir) {
				browsedChild = false;
				void loadDir(currentDir, browseReturnCursor);
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
			if (previewSearch) applyPreviewSearch("", 0);
			else if (selAnchor !== null) selAnchor = null;
			else if (browsedChild && currentDir) {
				browsedChild = false;
				void loadDir(currentDir, browseReturnCursor);
			} else focus = "list";
			rerender();
			return;
		}

		// Rendered markdown/HTML: display-line scrolling, no line-level actions.
		if (previewKind === "file" && rendered) {
			if (data === "r") {
				pendingG = false;
				rendered = false;
				previewScroll = 0;
				cursorLine = 0;
				selAnchor = null;
				rerender();
				return;
			}
			if (data === "o" || data === "O") {
				pendingG = false;
				openInBrowser();
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
			if (keys.goTop(data)) {
				if (pendingG) {
					pendingG = false;
					previewScroll = 0;
					rerender();
				} else {
					pendingG = true;
				}
				return;
			}
			pendingG = false;
			// The HTML banner occupies fixed rows, so the scrollable text area is smaller.
			const textH = Math.max(1, previewContentH() - renderedBannerRows());
			const maxScroll = Math.max(0, renderedCount - textH);
			if (keys.goBottom(data)) previewScroll = maxScroll;
			else if (keys.up(data)) previewScroll = Math.max(0, previewScroll - 1);
			else if (keys.down(data)) previewScroll = Math.min(maxScroll, previewScroll + 1);
			else if (keys.pageUp(data)) previewScroll = Math.max(0, previewScroll - textH);
			else if (keys.pageDown(data)) previewScroll = Math.min(maxScroll, previewScroll + textH);
			else if (keys.halfPageUp(data)) previewScroll = Math.max(0, previewScroll - Math.max(1, Math.floor(previewContentH() / 2)));
			else if (keys.halfPageDown(data)) previewScroll = Math.min(maxScroll, previewScroll + Math.max(1, Math.floor(previewContentH() / 2)));
			else return;
			rerender();
			return;
		}

		if (previewKind === "file") {
			if (data === "r") {
				pendingG = false;
				if (renderableAs) {
					rendered = true;
					previewScroll = 0;
					cursorLine = 0;
					selAnchor = null;
					// Raw line indices are meaningless when rendered — drop the search.
					previewSearch = "";
					matchLines = [];
					rerender();
				}
				return;
			}
			if (renderableAs === "html" && (data === "o" || data === "O")) {
				pendingG = false;
				openInBrowser();
				return;
			}
			if (data === "/") {
				pendingG = false;
				openSearch("preview");
				return;
			}
			if (data === "n" || data === "N") {
				pendingG = false;
				if (previewSearch) jumpMatch(data === "n" ? 1 : -1);
				else jumpRegion(data === "n" ? 1 : -1);
				return;
			}
			if (data === "p" || data === "P") {
				pendingG = false;
				if (previewSearch) jumpMatch(-1);
				else jumpRegion(-1);
				return;
			}
			if (data === "s" || data === "v" || data === "V") {
				pendingG = false;
				selAnchor = selAnchor === null ? cursorLine : null;
				rerender();
				return;
			}
			if (data === "a" || data === "A") {
				pendingG = false;
				if (file) addLinesToChat(file);
				rerender();
				return;
			}
			if (keys.goTop(data)) {
				if (pendingG) {
					pendingG = false;
					cursorLine = 0;
					keepCursorVisible();
					rerender();
				} else {
					pendingG = true;
				}
				return;
			}
			pendingG = false;
			if (keys.goBottom(data)) {
				cursorLine = Math.max(0, fileLines.length - 1);
				keepCursorVisible();
			} else if (keys.up(data)) moveCursor(-1);
			else if (keys.down(data)) moveCursor(1);
			else if (keys.pageUp(data)) moveCursor(-previewContentH());
			else if (keys.pageDown(data)) moveCursor(previewContentH());
			else if (keys.halfPageUp(data)) moveCursor(-Math.max(1, Math.floor(previewContentH() / 2)));
			else if (keys.halfPageDown(data)) moveCursor(Math.max(1, Math.floor(previewContentH() / 2)));
			else return;
			rerender();
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
		const rows = browseRows();
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
			const row = rows[dirCursor];
			if (row?.kind === "entry") addBrowseEntryToChat(row);
			else if (previewFile) addFileToChat(previewFile); // ".." selected or empty → the current dir
			return;
		}
		if (data === "/") {
			pendingG = false;
			ctx.ui.notify("Nothing to search here", "info");
			return;
		}
		if (keys.confirm(data) || keys.right(data)) {
			pendingG = false;
			void openBrowseRow(rows[dirCursor]);
			return;
		}
		if (keys.left(data) || keys.cancel(data) || data === "\x7f" || data === "\b") {
			pendingG = false;
			browseUp();
			return;
		}
		if (keys.goTop(data)) {
			if (pendingG) {
				pendingG = false;
				dirCursor = 0;
				keepDirCursorVisible();
				rerender();
			} else {
				pendingG = true;
			}
			return;
		}
		pendingG = false;
		if (keys.goBottom(data)) {
			dirCursor = Math.max(0, rows.length - 1);
			keepDirCursorVisible();
		} else if (keys.up(data)) moveDirCursor(-1);
		else if (keys.down(data)) moveDirCursor(1);
		else if (keys.pageUp(data)) moveDirCursor(-previewContentH());
		else if (keys.pageDown(data)) moveDirCursor(previewContentH());
		else if (keys.halfPageUp(data)) moveDirCursor(-Math.max(1, Math.floor(previewContentH() / 2)));
		else if (keys.halfPageDown(data)) moveDirCursor(Math.max(1, Math.floor(previewContentH() / 2)));
		else return;
		rerender();
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

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	// The image "card": path, type, dimensions, and size, plus an honest line about
	// why no pixels appear here (overlay compositing corrupts graphics escapes — see
	// the note by IMAGE_MIME). Never blank; every field the user asked for is shown.
	function imageCardLines(inner: number): string[] {
		const info = imageInfo;
		const lines: string[] = [];
		const push = (s: string) => lines.push(truncateToWidth(s, inner, "…"));
		push(theme.fg("accent", theme.bold(" Image")));
		push("");
		push(` ${theme.fg("text", previewFile?.rel ?? "")}`);
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
		const s = htmlSnap;
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

		if (previewKind === "image") return fillBody(imageCardLines(inner));
		if (previewKind === "loading") return fillBody([theme.fg("muted", " Loading…")]);
		if (previewKind === "empty") return fillBody([theme.fg("muted", " (nothing to preview)")]);
		if (previewKind === "binary") return fillBody([theme.fg("muted", " (binary file)")]);
		if (previewKind === "missing")
			return fillBody([theme.fg("warning", " This path does not exist on disk."), pad("", inner), theme.fg("dim", " The agent may have mistyped it; ask it to double-check.")]);

		if (previewKind === "dir") {
			// Constrained browser: a cursor selects entries; ".." (when descended)
			// leads back up; ↑↓ move, Enter/→ open, h/←/Esc go up.
			const browse = browseRows();
			const visible = browse.slice(previewScroll, previewScroll + bodyH);
			const lines = visible.map((r, i) => {
				const idx = previewScroll + i;
				const isCursor = idx === dirCursor && focus === "preview";
				const pointer = isCursor ? (focus === "preview" ? theme.fg("accent", "› ") : theme.fg("dim", "› ")) : "  ";
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
		if (previewKind === "file" && rendered && renderableAs) {
			const w = Math.max(8, inner - 2);
			let all: string[];
			let banner: string[] = [];
			if (renderableAs === "md") {
				mdComp ??= new Markdown(fileText.trim(), 0, 0, getMarkdownTheme());
				all = mdComp.render(w);
			} else {
				banner = htmlBannerLines(inner);
				if (!renderedCache || renderedCache.width !== w)
					renderedCache = { width: w, lines: wrapTextWithAnsi(htmlToText(fileText), w) };
				all = renderedCache.lines;
			}
			const avail = Math.max(1, bodyH - banner.length);
			renderedCount = all.length;
			previewScroll = Math.max(0, Math.min(previewScroll, Math.max(0, all.length - avail)));
			const text = all.slice(previewScroll, previewScroll + avail).map((l) => ` ${l}`);
			return fillBody([...banner, ...text]);
		}

		// file (raw)
		const file = previewFile;
		const gutterW = Math.max(3, String(fileLines.length).length);
		const lo = selAnchor !== null ? Math.min(selAnchor, cursorLine) : -1;
		const hi = selAnchor !== null ? Math.max(selAnchor, cursorLine) : -1;
		const matchSet = previewSearch ? new Set(matchLines) : null;
		const visible = fileLines.slice(previewScroll, previewScroll + bodyH);
		const lines: string[] = [];
		for (let i = 0; i < visible.length; i++) {
			const idx = previewScroll + i;
			const raw = (visible[i] ?? "").replace(/\t/g, "    ");
			const num = String(idx + 1).padStart(gutterW);
			const inSel = idx >= lo && idx <= hi;
			const inRegion = file ? file.regions.some((r) => idx + 1 >= r.start && idx + 1 <= r.end) : false;
			// Search matches read like regions but keep no background, so the two stay distinguishable.
			const inMatch = matchSet !== null && matchSet.has(idx);
			const isCursor = idx === cursorLine && focus === "preview";
			const numStyled = theme.fg(inSel || inRegion || inMatch || isCursor ? "accent" : "muted", num);
			const highlighted = highlightedLines[idx];
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

		// pane labels row — an active list filter stays visible after the input closes.
		const filterInfo = listFilter ? theme.fg("accent", ` /${listFilter}`) : "";
		const listLabel =
			(focus === "list" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "list" ? theme.fg("text", "Files") : theme.fg("dim", "Files")) +
			truncateToWidth(filterInfo, Math.max(0, leftW - 8), "…");
		const file = previewFile;
		let prevTitle = file ? file.rel : "Preview";
		const selInfo =
			previewKind === "file" && selAnchor !== null
				? theme.fg("accent", `  sel ${Math.min(selAnchor, cursorLine) + 1}-${Math.max(selAnchor, cursorLine) + 1}`)
				: "";
		let regionInfo = "";
		if (previewKind === "file" && !rendered && previewSearch) {
			// Active in-file search takes over the info slot: query + position.
			const pos = matchLines.filter((l) => l <= cursorLine).length;
			regionInfo = theme.fg("accent", `  /${previewSearch}  [${pos}/${matchLines.length}]`);
		} else if (previewKind === "file" && !rendered && file && file.regions.length > 0) {
			const cur = regionAt(cursorLine);
			if (cur) {
				regionInfo = theme.fg("accent", `  [${cur.idx + 1}/${file.regions.length}]`);
				if (cur.note) regionInfo += theme.fg("muted", ` ${cur.note}`);
			} else {
				regionInfo = theme.fg("dim", `  ${file.regions.length} region${file.regions.length !== 1 ? "s" : ""} (n/p)`);
			}
		}
		if (previewKind === "file" && renderableAs)
			regionInfo += theme.fg("dim", rendered ? "  · rendered (r: raw)" : "  · raw (r: rendered)");
		// A directory is a constrained browser — show the cursor position within it.
		if (previewKind === "dir") {
			const n = browseRows().length;
			regionInfo += theme.fg("dim", `  · browse  [${Math.min(dirCursor + 1, n)}/${n}]`);
		}
		const prevLabelText = truncateToWidth(prevTitle, Math.max(4, rightW - 8), "…");
		const prevLabel =
			(focus === "preview" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "preview" ? theme.fg("text", prevLabelText) : theme.fg("dim", prevLabelText)) +
			selInfo +
			truncateToWidth(regionInfo, Math.max(0, rightW - visibleWidth(prevLabelText) - visibleWidth(selInfo) - 2), "…");
		const labelRow =
			pad(truncateToWidth(listLabel, leftW, ""), leftW) +
			sep +
			pad(truncateToWidth(prevLabel, rightW, ""), rightW);

		// Description block for the previewed file (used by previewColumn via cache).
		descLinesCache =
			file?.description &&
			(previewKind === "file" || previewKind === "dir" || previewKind === "image" || previewKind === "binary" || previewKind === "missing")
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
			const noteInfo = note ? ` · ${ICON_SUCCESS} note` : "";
			const hasSel = previewKind === "file" && !rendered && selAnchor !== null;
			// What `a` will add at the cursor's current spot, so the hint isn't a lie.
			const inRegion = previewKind === "file" && !rendered && regionAt(cursorLine) !== null;
			const addLabel = hasSel ? "a add range" : inRegion ? "a add region" : "a add line";
			// A curated dir adds its `@dir/` mention from either focus — say so.
			const listAdd = selectedFile()?.kind === "dir" ? "a add @dir/" : "a add mention";
			const openHtml = renderableAs === "html" ? " · o open browser" : "";
			const hint =
				focus === "list"
					? `↑↓ move · Enter open · / filter · ${listAdd} · c copy mention · m note${noteInfo} · q close`
					: previewKind === "file" && rendered
						? `↑↓ scroll · r raw${openHtml} · a add file · c copy mention · y copy text · m note${noteInfo} · Esc back · q close`
						: previewKind === "file"
							? `↑↓ line · n/p ${previewSearch ? "match" : "region"} · / search${renderableAs ? " · r rendered" : ""}${openHtml} · s select · ${addLabel} · c copy mention · y copy text · m note${noteInfo} · Esc back · q close`
							: previewKind === "dir"
								? `↑↓ select · Enter open · h/⌫ up · a add mention · c copy mention · m note${noteInfo} · Esc up · q close`
								: previewKind === "image"
									? `a add file · c copy mention · m note${noteInfo} · Esc back · q close`
									: `↑↓ scroll · a add · c copy mention · m note${noteInfo} · Esc back · q close`;
			footer.push(pad(theme.fg("dim", ` ${truncateToWidth(hint, innerW - 2, "…")}`), innerW));
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
