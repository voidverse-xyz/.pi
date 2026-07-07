/**
 * /browse-files — two-pane file/dir tree browser overlay.
 *
 *  ┌ left: lazy tree (dirs expand/collapse) ─┬ right: preview ─────────────┐
 *  │ selecting a file shows its content       │ a directory shows a listing │
 *  └──────────────────────────────────────────┴─────────────────────────────┘
 *
 * "Add to chat" (a): appends an @-mention for the selected node into the input
 * editor — a file (`@path`), a directory (`@path/`), or, inside the file preview,
 * a selected line range (`@path:12-40`). The overlay stays open so several
 * references can be gathered before closing.
 *
 * Layout/scroll/exact-height machinery is adapted from the plan-commit review
 * panel and the pi-changes panel (closure state, pull-based render).
 */

import { readFile, readdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { appendToEditor, dirMention, fileMention, linesMention } from "./add-to-chat.ts";
import { createNavKeys } from "./keys.ts";
import { createRoot, flatten, loadChildren, type TreeNode } from "./tree.ts";

const MAX_PREVIEW_BYTES = 512 * 1024;

export interface BrowsePanelOptions {
	cwd: string;
	ctx: ExtensionCommandContext;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	onDone: (result: void) => void;
}

type Focus = "tree" | "preview";
type PreviewKind = "file" | "dir" | "binary" | "empty" | "loading";

export function createBrowsePanel(opts: BrowsePanelOptions): Component {
	const { cwd, ctx, tui, theme, keybindings, onDone } = opts;
	const keys = createNavKeys(keybindings);

	const root = createRoot(cwd);
	let rows: TreeNode[] = [];
	let treeSelected = 0;
	let treeScroll = 0;
	let focus: Focus = "tree";
	let pendingG = false;

	// Preview state
	let previewNode: TreeNode | null = null;
	let previewKind: PreviewKind = "empty";
	let fileLines: string[] = [];
	let dirEntries: Array<{ name: string; isDir: boolean }> = [];
	let previewScroll = 0;
	let cursorLine = 0;
	let selAnchor: number | null = null;
	let loadToken = 0;

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

	function rebuildRows() {
		rows = flatten(root);
		if (treeSelected >= rows.length) treeSelected = Math.max(0, rows.length - 1);
	}

	function selectedNode(): TreeNode | undefined {
		return rows[treeSelected];
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

	// ── preview loading ─────────────────────────────────────────────────────────

	async function loadPreview(node: TreeNode | undefined) {
		previewScroll = 0;
		cursorLine = 0;
		selAnchor = null;
		fileLines = [];
		dirEntries = [];

		if (!node) {
			previewNode = null;
			previewKind = "empty";
			rerender();
			return;
		}

		previewNode = node;
		previewKind = "loading";
		const token = ++loadToken;
		rerender();

		if (node.isDir) {
			try {
				const dirents = await readdir(node.abs, { withFileTypes: true });
				const entries: Array<{ name: string; isDir: boolean }> = [];
				for (const d of dirents) {
					let isDir = d.isDirectory();
					if (d.isSymbolicLink()) {
						try {
							isDir = (await stat(`${node.abs}/${d.name}`)).isDirectory();
						} catch {
							isDir = false;
						}
					}
					entries.push({ name: d.name, isDir });
				}
				entries.sort((a, b) =>
					a.isDir !== b.isDir
						? a.isDir
							? -1
							: 1
						: a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
				);
				if (token !== loadToken) return;
				dirEntries = entries;
				previewKind = "dir";
			} catch {
				if (token !== loadToken) return;
				previewKind = "empty";
			}
			rerender();
			return;
		}

		// File
		try {
			const buf = await readFile(node.abs);
			if (token !== loadToken) return;
			if (buf.byteLength > MAX_PREVIEW_BYTES) {
				fileLines = [`(file too large to preview — ${(buf.byteLength / 1024).toFixed(0)} KB)`];
				previewKind = "file";
			} else if (buf.includes(0)) {
				previewKind = "binary";
			} else {
				fileLines = buf.toString("utf8").split("\n");
				previewKind = "file";
			}
		} catch {
			if (token !== loadToken) return;
			previewKind = "empty";
		}
		rerender();
	}

	async function initialLoad() {
		await loadChildren(cwd, root);
		rebuildRows();
		await loadPreview(selectedNode());
	}
	void initialLoad();

	// ── tree navigation ──────────────────────────────────────────────────────────

	function moveTree(delta: number) {
		const max = Math.max(0, rows.length - 1);
		treeSelected = Math.max(0, Math.min(max, treeSelected + delta));
		if (treeSelected < treeScroll) treeScroll = treeSelected;
		if (treeSelected >= treeScroll + contentH) treeScroll = treeSelected - contentH + 1;
		void loadPreview(selectedNode());
	}

	async function toggleExpand(node: TreeNode) {
		if (!node.isDir) return;
		if (node.expanded) {
			node.expanded = false;
		} else {
			if (!node.loaded) await loadChildren(cwd, node);
			node.expanded = true;
		}
		rebuildRows();
		rerender();
	}

	function collapseOrParent(node: TreeNode) {
		if (node.isDir && node.expanded) {
			node.expanded = false;
			rebuildRows();
			rerender();
			return;
		}
		// Jump to parent row.
		const parent = node.parent;
		if (parent && parent.depth > 0) {
			const idx = rows.indexOf(parent);
			if (idx >= 0) {
				treeSelected = idx;
				if (treeSelected < treeScroll) treeScroll = treeSelected;
				void loadPreview(selectedNode());
				rerender();
			}
		}
	}

	function addNodeToChat(node: TreeNode) {
		const mention = node.isDir ? dirMention(node.rel) : fileMention(node.rel);
		appendToEditor(ctx, mention);
		ctx.ui.notify(`Added ${mention} to chat`, "info");
	}

	function handleTreeInput(data: string): void {
		if (keys.cancel(data) || data === "q") {
			onDone();
			return;
		}
		if (keys.tab(data) || keys.right(data)) {
			const node = selectedNode();
			if (keys.right(data) && node?.isDir) {
				pendingG = false;
				void toggleExpand(node);
				return;
			}
			if (node && (previewKind === "file" || previewKind === "dir" || previewKind === "binary")) {
				pendingG = false;
				focus = "preview";
				rerender();
			}
			return;
		}
		if (keys.left(data)) {
			pendingG = false;
			const node = selectedNode();
			if (node) collapseOrParent(node);
			return;
		}
		if (keys.confirm(data)) {
			pendingG = false;
			const node = selectedNode();
			if (!node) return;
			if (node.isDir) void toggleExpand(node);
			else {
				focus = "preview";
				rerender();
			}
			return;
		}
		if (data === "a" || data === "A") {
			pendingG = false;
			const node = selectedNode();
			if (node) addNodeToChat(node);
			return;
		}
		if (keys.goTop(data)) {
			if (pendingG) {
				pendingG = false;
				treeSelected = 0;
				treeScroll = 0;
				void loadPreview(selectedNode());
				rerender();
			} else {
				pendingG = true;
			}
			return;
		}
		pendingG = false;
		if (keys.goBottom(data)) moveTree(rows.length);
		else if (keys.up(data)) moveTree(-1);
		else if (keys.down(data)) moveTree(1);
		else if (keys.pageUp(data)) moveTree(-contentH);
		else if (keys.pageDown(data)) moveTree(contentH);
		else if (keys.halfPageUp(data)) moveTree(-Math.max(1, Math.floor(contentH / 2)));
		else if (keys.halfPageDown(data)) moveTree(Math.max(1, Math.floor(contentH / 2)));
		else return;
		rerender();
	}

	// ── preview navigation ────────────────────────────────────────────────────────

	function keepCursorVisible() {
		if (cursorLine < previewScroll) previewScroll = cursorLine;
		if (cursorLine >= previewScroll + contentH) previewScroll = cursorLine - contentH + 1;
	}

	function moveCursor(delta: number) {
		const max = Math.max(0, fileLines.length - 1);
		cursorLine = Math.max(0, Math.min(max, cursorLine + delta));
		keepCursorVisible();
	}

	function addLinesToChat(node: TreeNode) {
		if (selAnchor !== null) {
			const mention = linesMention(node.rel, selAnchor + 1, cursorLine + 1);
			appendToEditor(ctx, mention);
			ctx.ui.notify(`Added ${mention} to chat`, "info");
			selAnchor = null;
		} else {
			addNodeToChat(node);
		}
	}

	function handlePreviewInput(data: string): void {
		const node = previewNode;
		if (keys.tab(data) || keys.shiftTab(data) || keys.left(data)) {
			pendingG = false;
			focus = "tree";
			rerender();
			return;
		}
		if (keys.cancel(data) || data === "q") {
			pendingG = false;
			if (selAnchor !== null) {
				selAnchor = null;
				rerender();
			} else {
				focus = "tree";
				rerender();
			}
			return;
		}

		if (previewKind === "file") {
			if (data === "s" || data === "v" || data === "V") {
				pendingG = false;
				selAnchor = selAnchor === null ? cursorLine : null;
				rerender();
				return;
			}
			if (data === "a" || data === "A") {
				pendingG = false;
				if (node) addLinesToChat(node);
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
			else if (keys.pageUp(data)) moveCursor(-contentH);
			else if (keys.pageDown(data)) moveCursor(contentH);
			else if (keys.halfPageUp(data)) moveCursor(-Math.max(1, Math.floor(contentH / 2)));
			else if (keys.halfPageDown(data)) moveCursor(Math.max(1, Math.floor(contentH / 2)));
			else return;
			rerender();
			return;
		}

		// dir / binary / empty preview: scroll + add
		if (data === "a" || data === "A") {
			pendingG = false;
			if (node) addNodeToChat(node);
			return;
		}
		const total = previewKind === "dir" ? dirEntries.length : 1;
		const maxScroll = Math.max(0, total - contentH);
		if (keys.up(data)) previewScroll = Math.max(0, previewScroll - 1);
		else if (keys.down(data)) previewScroll = Math.min(maxScroll, previewScroll + 1);
		else if (keys.pageUp(data)) previewScroll = Math.max(0, previewScroll - contentH);
		else if (keys.pageDown(data)) previewScroll = Math.min(maxScroll, previewScroll + contentH);
		else return;
		rerender();
	}

	function handleInput(data: string): void {
		if (focus === "tree") handleTreeInput(data);
		else handlePreviewInput(data);
	}

	// ── rendering ──────────────────────────────────────────────────────────────────

	function treeColumn(width: number): string[] {
		const out: string[] = [];
		const visible = rows.slice(treeScroll, treeScroll + contentH);
		for (let i = 0; i < visible.length; i++) {
			const node = visible[i]!;
			const idx = treeScroll + i;
			const isCursor = idx === treeSelected;
			const indent = "  ".repeat(Math.max(0, node.depth - 1));
			const typeMark = node.isDir ? (node.expanded ? "▾" : "▸") : " ";
			const name = node.isDir ? `${node.name}/` : node.name;
			const label = `${indent}${typeMark} ${name}`;
			const pointer = isCursor
				? focus === "tree"
					? theme.fg("accent", "› ")
					: theme.fg("dim", "› ")
				: "  ";
			const body = isCursor
				? theme.fg(focus === "tree" ? "accent" : "muted", label)
				: node.isDir
					? theme.fg("text", label)
					: theme.fg("dim", label);
			out.push(pad(`${pointer}${truncateToWidth(body, Math.max(1, width - 2), "…")}`, width));
		}
		while (out.length < contentH) out.push(pad("", width));
		return out;
	}

	function previewColumn(width: number): string[] {
		const inner = Math.max(8, width);
		if (previewKind === "loading") return fill([theme.fg("muted", " Loading…")], inner);
		if (previewKind === "empty") return fill([theme.fg("muted", " (nothing to preview)")], inner);
		if (previewKind === "binary") return fill([theme.fg("muted", " (binary file)")], inner);

		if (previewKind === "dir") {
			const visible = dirEntries.slice(previewScroll, previewScroll + contentH);
			const lines = visible.map((e) => {
				const nm = e.isDir ? `${e.name}/` : e.name;
				const mark = e.isDir ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ");
				return ` ${mark}${truncateToWidth(e.isDir ? theme.fg("text", nm) : theme.fg("dim", nm), inner - 3, "…")}`;
			});
			if (lines.length === 0) lines.push(theme.fg("muted", " (empty directory)"));
			return fill(lines.map((l) => pad(l, inner)), inner);
		}

		// file
		const gutterW = Math.max(3, String(fileLines.length).length);
		const lo = selAnchor !== null ? Math.min(selAnchor, cursorLine) : -1;
		const hi = selAnchor !== null ? Math.max(selAnchor, cursorLine) : -1;
		const visible = fileLines.slice(previewScroll, previewScroll + contentH);
		const lines: string[] = [];
		for (let i = 0; i < visible.length; i++) {
			const idx = previewScroll + i;
			const raw = (visible[i] ?? "").replace(/\t/g, "    ");
			const num = String(idx + 1).padStart(gutterW);
			const inSel = idx >= lo && idx <= hi;
			const isCursor = idx === cursorLine && focus === "preview";
			const numStyled = theme.fg(inSel ? "accent" : "muted", num);
			const text = truncateToWidth(raw, Math.max(1, inner - gutterW - 2), "…");
			let textStyled: string;
			if (isCursor) textStyled = theme.fg("accent", text);
			else if (inSel) textStyled = theme.fg("text", text);
			else textStyled = theme.fg("dim", text);
			let row = ` ${numStyled} ${textStyled}`;
			row = pad(row, inner);
			if (inSel) row = theme.bg("selectedBg", row);
			lines.push(row);
		}
		return fill(lines, inner);
	}

	function fill(lines: string[], width: number): string[] {
		const out = lines.slice(0, contentH).map((l) => pad(l, width));
		while (out.length < contentH) out.push(pad("", width));
		return out;
	}

	function render(width: number): string[] {
		const targetH = panelRows();
		if (cachedLines && cachedWidth === width && cachedHeight === targetH) return cachedLines;

		const innerW = Math.max(30, width);
		const leftW = Math.max(20, Math.min(52, Math.floor(innerW * 0.4)));
		const sep = theme.fg("borderMuted", " │ ");
		const sepW = 3;
		const rightW = Math.max(10, innerW - leftW - sepW);

		const header: string[] = [];
		header.push(rule(innerW));
		const homeRel = cwd.replace(process.env.HOME ?? "~", "~");
		const title =
			theme.bold("Browse") + theme.fg("dim", `  ${homeRel}`);
		header.push(pad(truncateToWidth(title, innerW, "…"), innerW));

		// pane labels row
		const treeLabel =
			(focus === "tree" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "tree" ? theme.fg("text", "Tree") : theme.fg("dim", "Tree"));
		const node = previewNode;
		let prevTitle = "Preview";
		if (node) prevTitle = node.rel || node.name;
		const selInfo =
			previewKind === "file" && selAnchor !== null
				? theme.fg("accent", `  sel ${Math.min(selAnchor, cursorLine) + 1}-${Math.max(selAnchor, cursorLine) + 1}`)
				: "";
		const prevLabel =
			(focus === "preview" ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ")) +
			(focus === "preview" ? theme.fg("text", truncateToWidth(prevTitle, rightW - 8, "…")) : theme.fg("dim", truncateToWidth(prevTitle, rightW - 8, "…"))) +
			selInfo;
		const labelRow = pad(treeLabel, leftW) + sep + pad(prevLabel, rightW);

		const footerRows = 2;
		const overhead = header.length + 1 /*labels*/ + footerRows;
		contentH = Math.max(1, targetH - overhead);

		// clamp scroll
		const treeMaxScroll = Math.max(0, rows.length - contentH);
		treeScroll = Math.min(treeScroll, treeMaxScroll);

		const leftCol = treeColumn(leftW);
		const rightCol = previewColumn(rightW);

		const lines: string[] = [...header, labelRow];
		for (let i = 0; i < contentH; i++) {
			lines.push(`${leftCol[i] ?? pad("", leftW)}${sep}${rightCol[i] ?? pad("", rightW)}`);
		}

		lines.push(rule(innerW));
		const hint =
			focus === "tree"
				? "↑↓ move · → expand · ← collapse/parent · Enter open · a add · Tab preview · q close"
				: previewKind === "file"
					? "↑↓ line · s select · a add" + (selAnchor !== null ? " range" : " file") + " · Esc/Tab tree · q close"
					: "↑↓ scroll · a add dir · Esc/Tab tree · q close";
		lines.push(pad(theme.fg("dim", ` ${truncateToWidth(hint, innerW - 2, "…")}`), innerW));

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
