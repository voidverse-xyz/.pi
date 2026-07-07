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
 *   - which files were opened in the preview,
 *   - `a` add-to-chat @-mentions gathered (file, dir, or `s`-selected line range),
 *   - `m` a free-text note typed in an embedded editor.
 *
 * Layout/scroll/exact-height machinery follows pi-browse's panel (closure state,
 * pull-based render); the note editor follows pi-ask-user's embedded Editor.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Editor, type EditorTheme, Image, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { appendToEditor, dirMention, type EditorUi, fileMention, linesMention } from "./add-to-chat.ts";
import { createNavKeys } from "./keys.ts";
import type { PresentedFile } from "./files.ts";

const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Images preview natively (kitty/iTerm2 graphics via pi-tui's Image, with a
// text fallback on terminals without image support).
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
	const { title, summary, files, ctx, tui, theme, keybindings, onDone } = opts;
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
	let imageComp: Image | null = null;

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

	let contentH = 8;
	let cachedWidth: number | undefined;
	let cachedHeight: number | undefined;
	let cachedLines: string[] | undefined;

	function invalidate() {
		cachedWidth = undefined;
		cachedHeight = undefined;
		cachedLines = undefined;
	}

	function rerender() {
		invalidate();
		tui.requestRender();
	}

	function selectedFile(): PresentedFile | undefined {
		const row = rows[listSelected];
		return row?.kind === "file" ? row.file : undefined;
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

	function finish() {
		onDone({ opened: [...opened], added: [...added], note: note || undefined });
	}

	// ── preview loading ─────────────────────────────────────────────────────────

	async function loadPreview(file: PresentedFile | undefined) {
		previewScroll = 0;
		cursorLine = 0;
		selAnchor = null;
		fileLines = [];
		dirEntries = [];
		imageComp = null;

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
		previewKind = "loading";
		const token = ++loadToken;
		rerender();

		if (file.kind === "dir") {
			try {
				const dirents = await readdir(file.abs, { withFileTypes: true });
				const entries: Array<{ name: string; isDir: boolean }> = [];
				for (const d of dirents) {
					let isDir = d.isDirectory();
					if (d.isSymbolicLink()) {
						try {
							isDir = (await stat(`${file.abs}/${d.name}`)).isDirectory();
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
				previewKind = "missing";
			}
			rerender();
			return;
		}

		try {
			const buf = await readFile(file.abs);
			if (token !== loadToken) return;
			const ext = file.abs.slice(file.abs.lastIndexOf(".") + 1).toLowerCase();
			const mime = IMAGE_MIME[ext];
			if (mime && buf.byteLength <= MAX_IMAGE_BYTES) {
				imageComp = new Image(
					buf.toString("base64"),
					mime,
					{ fallbackColor: (s) => theme.fg("muted", s) },
					{ maxHeightCells: Math.max(6, contentH - 2), filename: file.rel },
				);
				previewKind = "image";
			} else if (buf.byteLength > MAX_PREVIEW_BYTES) {
				fileLines = [`(file too large to preview — ${(buf.byteLength / 1024).toFixed(0)} KB)`];
				previewKind = "file";
			} else if (buf.includes(0)) {
				previewKind = "binary";
			} else {
				fileLines = buf.toString("utf8").split("\n");
				previewKind = "file";
				// Open on the agent's first highlight region, a few lines of breathing room above.
				const first = file.regions[0];
				if (first) {
					cursorLine = Math.min(first.start - 1, Math.max(0, fileLines.length - 1));
					previewScroll = Math.max(0, cursorLine - 3);
				}
			}
		} catch {
			if (token !== loadToken) return;
			previewKind = "missing";
		}
		rerender();
	}

	void loadPreview(selectedFile());

	// ── list navigation ──────────────────────────────────────────────────────────

	function keepListVisible() {
		if (listSelected < listScroll) listScroll = listSelected;
		if (listSelected >= listScroll + contentH) listScroll = listSelected - contentH + 1;
	}

	function moveList(delta: number) {
		if (rows.length === 0) return;
		const dir = delta < 0 ? -1 : 1;
		let idx = listSelected;
		let remaining = Math.abs(delta);
		while (remaining > 0) {
			let next = idx + dir;
			while (next >= 0 && next < rows.length && rows[next]!.kind === "group") next += dir;
			if (next < 0 || next >= rows.length) break;
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
		const idxs = rows.map((r, i) => (r.kind === "file" ? i : -1)).filter((i) => i >= 0);
		if (idxs.length === 0) return;
		listSelected = toEnd ? idxs[idxs.length - 1]! : idxs[0]!;
		keepListVisible();
		void loadPreview(selectedFile());
	}

	function enterPreview() {
		const file = selectedFile();
		if (!file) return;
		if (previewKind === "loading" || previewKind === "empty") return;
		focus = "preview";
		opened.add(file.rel);
		rerender();
	}

	function addFileToChat(file: PresentedFile) {
		const mention = file.kind === "dir" ? dirMention(file.rel) : fileMention(file.rel);
		appendToEditor(ctx, mention);
		added.push(mention);
		ctx.ui.notify(`Added ${mention} to chat`, "info");
	}

	function handleListInput(data: string): void {
		if (keys.cancel(data) || data === "q") {
			finish();
			return;
		}
		if (data === "m" || data === "M") {
			pendingG = false;
			openNoteEditor();
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

	function addLinesToChat(file: PresentedFile) {
		if (selAnchor !== null) {
			const mention = linesMention(file.rel, selAnchor + 1, cursorLine + 1);
			appendToEditor(ctx, mention);
			added.push(mention);
			ctx.ui.notify(`Added ${mention} to chat`, "info");
			selAnchor = null;
		} else {
			addFileToChat(file);
		}
	}

	function handlePreviewInput(data: string): void {
		const file = previewFile;
		if (keys.tab(data) || keys.shiftTab(data) || keys.left(data)) {
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
		if (keys.cancel(data)) {
			pendingG = false;
			if (selAnchor !== null) selAnchor = null;
			else focus = "list";
			rerender();
			return;
		}

		if (previewKind === "file") {
			if (data === "n" || data === "N") {
				pendingG = false;
				jumpRegion(data === "n" ? 1 : -1);
				return;
			}
			if (data === "p" || data === "P") {
				pendingG = false;
				jumpRegion(-1);
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

		// dir / binary / missing preview: scroll + add
		if (data === "a" || data === "A") {
			pendingG = false;
			if (file) addFileToChat(file);
			return;
		}
		const total = previewKind === "dir" ? dirEntries.length : 1;
		const maxScroll = Math.max(0, total - previewContentH());
		if (keys.up(data)) previewScroll = Math.max(0, previewScroll - 1);
		else if (keys.down(data)) previewScroll = Math.min(maxScroll, previewScroll + 1);
		else if (keys.pageUp(data)) previewScroll = Math.max(0, previewScroll - previewContentH());
		else if (keys.pageDown(data)) previewScroll = Math.min(maxScroll, previewScroll + previewContentH());
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

	function handleInput(data: string): void {
		if (editingNote) handleNoteInput(data);
		else if (focus === "list") handleListInput(data);
		else handlePreviewInput(data);
	}

	// ── rendering ──────────────────────────────────────────────────────────────────

	function listColumn(width: number): string[] {
		const out: string[] = [];
		const visible = rows.slice(listScroll, listScroll + contentH);
		for (let i = 0; i < visible.length; i++) {
			const row = visible[i]!;
			const idx = listScroll + i;
			if (row.kind === "group") {
				const label = truncateToWidth(row.label, Math.max(1, width - 3), "…");
				out.push(pad(`  ${theme.fg("muted", theme.bold(label))}`, width));
				continue;
			}
			const file = row.file;
			const isCursor = idx === listSelected;
			const wasOpened = opened.has(file.rel);
			const pointer = isCursor
				? focus === "list"
					? theme.fg("accent", "› ")
					: theme.fg("dim", "› ")
				: "  ";
			let label = file.kind === "dir" && !file.title.endsWith("/") ? `${file.title}/` : file.title;
			if (file.kind === "missing") label += " (missing)";
			const markW = wasOpened ? 2 : 0;
			const text = truncateToWidth(label, Math.max(1, width - 4 - markW), "…");
			let body: string;
			if (file.kind === "missing") body = theme.fg("dim", text);
			else if (isCursor) body = theme.fg(focus === "list" ? "accent" : "text", text);
			else body = theme.fg("text", text);
			const mark = wasOpened ? theme.fg("dim", " ·") : "";
			out.push(pad(`${pointer}${body}${mark}`, width));
		}
		while (out.length < contentH) out.push(pad("", width));
		return out;
	}

	// Wrapped description lines for the currently previewed file, recomputed in render.
	let descLinesCache: string[] = [];

	function previewColumn(width: number): string[] {
		const inner = Math.max(8, width);
		const out: string[] = [];

		// Agent's per-file description block above the content.
		if (descLinesCache.length > 0) {
			for (const l of descLinesCache) out.push(pad(` ${theme.fg("muted", l)}`, inner));
			out.push(pad(theme.fg("borderMuted", ` ${"·".repeat(Math.max(1, Math.min(inner - 2, 30)))}`), inner));
		}
		const bodyH = Math.max(1, contentH - out.length);

		const fillBody = (lines: string[]): string[] => {
			const body = lines.slice(0, bodyH).map((l) => pad(l, inner));
			while (body.length < bodyH) body.push(pad("", inner));
			return [...out, ...body].slice(0, contentH);
		};

		if (previewKind === "image") {
			// Raw image lines (kitty/iTerm2 escapes or the text fallback) — pass
			// through unpadded so the escape sequences aren't disturbed.
			const imgLines = imageComp ? imageComp.render(Math.max(8, inner - 2)).map((l) => ` ${l}`) : [];
			const body = imgLines.slice(0, Math.max(1, contentH - out.length));
			const res = [...out, ...body];
			while (res.length < contentH) res.push(pad("", inner));
			return res.slice(0, contentH);
		}
		if (previewKind === "loading") return fillBody([theme.fg("muted", " Loading…")]);
		if (previewKind === "empty") return fillBody([theme.fg("muted", " (nothing to preview)")]);
		if (previewKind === "binary") return fillBody([theme.fg("muted", " (binary file)")]);
		if (previewKind === "missing")
			return fillBody([theme.fg("warning", " This path does not exist on disk."), pad("", inner), theme.fg("dim", " The agent may have mistyped it; ask it to double-check.")]);

		if (previewKind === "dir") {
			const visible = dirEntries.slice(previewScroll, previewScroll + bodyH);
			const lines = visible.map((e) => {
				const nm = e.isDir ? `${e.name}/` : e.name;
				const mark = e.isDir ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ");
				return ` ${mark}${truncateToWidth(e.isDir ? theme.fg("text", nm) : theme.fg("dim", nm), inner - 3, "…")}`;
			});
			if (lines.length === 0) lines.push(theme.fg("muted", " (empty directory)"));
			return fillBody(lines);
		}

		// file
		const file = previewFile;
		const gutterW = Math.max(3, String(fileLines.length).length);
		const lo = selAnchor !== null ? Math.min(selAnchor, cursorLine) : -1;
		const hi = selAnchor !== null ? Math.max(selAnchor, cursorLine) : -1;
		const visible = fileLines.slice(previewScroll, previewScroll + bodyH);
		const lines: string[] = [];
		for (let i = 0; i < visible.length; i++) {
			const idx = previewScroll + i;
			const raw = (visible[i] ?? "").replace(/\t/g, "    ");
			const num = String(idx + 1).padStart(gutterW);
			const inSel = idx >= lo && idx <= hi;
			const inRegion = file ? file.regions.some((r) => idx + 1 >= r.start && idx + 1 <= r.end) : false;
			const isCursor = idx === cursorLine && focus === "preview";
			const numStyled = theme.fg(inSel || inRegion ? "accent" : "muted", num);
			const text = truncateToWidth(raw, Math.max(1, inner - gutterW - 2), "…");
			let textStyled: string;
			if (isCursor) textStyled = theme.fg("accent", text);
			else if (inSel || inRegion) textStyled = theme.fg("text", text);
			else textStyled = theme.fg("dim", text);
			let rowStr = ` ${numStyled} ${textStyled}`;
			rowStr = pad(rowStr, inner);
			if (inSel) rowStr = theme.bg("selectedBg", rowStr);
			else if (inRegion) rowStr = theme.bg("customMessageBg", rowStr);
			lines.push(rowStr);
		}
		return fillBody(lines);
	}

	function render(width: number): string[] {
		const targetH = panelRows();
		if (cachedLines && cachedWidth === width && cachedHeight === targetH) return cachedLines;

		const innerW = Math.max(30, width);
		const leftW = Math.max(20, Math.min(52, Math.floor(innerW * 0.38)));
		const sep = theme.fg("borderMuted", " │ ");
		const sepW = 3;
		const rightW = Math.max(10, innerW - leftW - sepW);

		const fileCount = files.length;
		const missingCount = files.filter((f) => f.kind === "missing").length;

		const header: string[] = [];
		header.push(rule(innerW));
		let counts = `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
		if (missingCount > 0) counts += `, ${missingCount} missing`;
		header.push(pad(truncateToWidth(theme.bold(title) + theme.fg("dim", `  ${counts}`), innerW, "…"), innerW));
		if (summary) {
			const wrapped = wrapTextWithAnsi(summary, Math.max(10, innerW - 2)).slice(0, 3);
			for (const l of wrapped) header.push(pad(theme.fg("muted", ` ${l}`), innerW));
		}

		// pane labels row
		const listLabel =
			(focus === "list" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "list" ? theme.fg("text", "Files") : theme.fg("dim", "Files"));
		const file = previewFile;
		let prevTitle = file ? file.rel : "Preview";
		const selInfo =
			previewKind === "file" && selAnchor !== null
				? theme.fg("accent", `  sel ${Math.min(selAnchor, cursorLine) + 1}-${Math.max(selAnchor, cursorLine) + 1}`)
				: "";
		let regionInfo = "";
		if (previewKind === "file" && file && file.regions.length > 0) {
			const cur = regionAt(cursorLine);
			if (cur) {
				regionInfo = theme.fg("accent", `  [${cur.idx + 1}/${file.regions.length}]`);
				if (cur.note) regionInfo += theme.fg("muted", ` ${cur.note}`);
			} else {
				regionInfo = theme.fg("dim", `  ${file.regions.length} region${file.regions.length !== 1 ? "s" : ""} (n/p)`);
			}
		}
		const prevLabelText = truncateToWidth(prevTitle, Math.max(4, rightW - 8), "…");
		const prevLabel =
			(focus === "preview" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "preview" ? theme.fg("text", prevLabelText) : theme.fg("dim", prevLabelText)) +
			selInfo +
			truncateToWidth(regionInfo, Math.max(0, rightW - visibleWidth(prevLabelText) - visibleWidth(selInfo) - 2), "…");
		const labelRow = pad(listLabel, leftW) + sep + pad(truncateToWidth(prevLabel, rightW, "…"), rightW);

		// Description block for the previewed file (used by previewColumn via cache).
		descLinesCache =
			file?.description &&
			(previewKind === "file" || previewKind === "dir" || previewKind === "image" || previewKind === "binary" || previewKind === "missing")
				? wrapTextWithAnsi(file.description, Math.max(10, rightW - 2)).slice(0, 4)
				: [];

		// Footer: either the hint row or the note editor block.
		const footer: string[] = [rule(innerW)];
		if (editingNote) {
			footer.push(pad(theme.fg("accent", " Note to agent") + theme.fg("dim", "  (Enter to save, Esc to cancel — sent with the tool result)"), innerW));
			for (const l of noteEditor.render(Math.max(10, innerW - 2))) footer.push(pad(` ${l}`, innerW));
		} else {
			const noteInfo = note ? ` · note ✓` : "";
			const hint =
				focus === "list"
					? `↑↓ move · Enter open · a add to chat · m note${noteInfo} · q close`
					: previewKind === "file"
						? `↑↓ line · n/p region · s select · a add${selAnchor !== null ? " range" : ""} · m note${noteInfo} · Esc back · q close`
						: `↑↓ scroll · a add · m note${noteInfo} · Esc back · q close`;
			footer.push(pad(theme.fg("dim", ` ${truncateToWidth(hint, innerW - 2, "…")}`), innerW));
		}

		const overhead = header.length + 1 /*labels*/ + footer.length;
		contentH = Math.max(1, targetH - overhead);

		// clamp scrolls
		listScroll = Math.min(listScroll, Math.max(0, rows.length - contentH));
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
