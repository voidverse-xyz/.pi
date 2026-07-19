/**
 * dir-browser.ts — cursor movement and navigation inside a directory preview.
 *
 * Extracted verbatim from panel.ts: the browse-row model (".." + entries), the
 * dir cursor, descend/open (Enter/→), go-up (h/←/⌫/Esc — never above the
 * curated root), and adding a selected entry's @-mention. State lives in the
 * shared PreviewState record; panel.ts supplies the loader hooks, layout
 * height, focus hand-off, and outcome tracking through DirBrowserDeps.
 */

import { join } from "node:path";
import { dirMention, fileMention } from "./add-to-chat.ts";
import { browseRelPath, clampVisible } from "./panel-logic.ts";
import type { BrowseRow, PreviewState } from "./preview-state.ts";

export interface DirBrowserDeps {
	previewContentH: () => number;
	rerender: () => void;
	loadDir: (abs: string, cursorTo?: number) => Promise<void>;
	loadChildFile: (abs: string, rel: string) => Promise<void>;
	addMention: (mention: string) => void;
	opened: Set<string>;
	setFocusList: () => void;
}

export function createDirBrowser(state: PreviewState, deps: DirBrowserDeps) {
	// The rows shown in a directory preview: a synthetic ".." when we've descended
	// below the curated root, followed by the entries.
	function browseRows(): BrowseRow[] {
		const out: BrowseRow[] = [];
		if (state.currentDir && state.browseRoot && state.currentDir !== state.browseRoot) out.push({ kind: "up" });
		for (const e of state.dirEntries) out.push({ kind: "entry", name: e.name, isDir: e.isDir });
		return out;
	}

	function keepDirCursorVisible() {
		state.previewScroll = clampVisible(state.dirCursor, state.previewScroll, deps.previewContentH());
	}

	function moveDirCursor(delta: number) {
		const n = browseRows().length;
		if (n === 0) return;
		state.dirCursor = Math.max(0, Math.min(n - 1, state.dirCursor + delta));
		keepDirCursorVisible();
	}

	// Enter/→ on a browse row: descend into a subdir, or preview a child file.
	async function openBrowseRow(row: BrowseRow | undefined) {
		if (!row || !state.currentDir) return;
		if (row.kind === "up") {
			browseUp();
			return;
		}
		const childAbs = join(state.currentDir, row.name);
		if (row.isDir) {
			state.browseStack.push({ dir: state.currentDir, cursor: state.dirCursor });
			await deps.loadDir(childAbs);
		} else {
			const rel = browseRelPath(childAbs, state.browseRoot, state.browseRootRel);
			deps.opened.add(rel);
			state.browsedChild = true;
			state.browseReturnCursor = state.dirCursor;
			await deps.loadChildFile(childAbs, rel);
		}
	}

	// Go up one level — but never above the curated root: at the root, Esc/h/⌫
	// simply returns focus to the left list.
	function browseUp() {
		if (state.browseStack.length > 0) {
			const prev = state.browseStack.pop()!;
			void deps.loadDir(prev.dir, prev.cursor);
		} else {
			deps.setFocusList();
			deps.rerender();
		}
	}

	function addBrowseEntryToChat(row: Extract<BrowseRow, { kind: "entry" }>) {
		if (!state.currentDir) return;
		const rel = browseRelPath(join(state.currentDir, row.name), state.browseRoot, state.browseRootRel);
		deps.addMention(row.isDir ? dirMention(rel) : fileMention(rel));
	}

	return { browseRows, keepDirCursorVisible, moveDirCursor, openBrowseRow, browseUp, addBrowseEntryToChat };
}
