/**
 * preview-state.ts — the mutable state shared by the show_files right pane.
 *
 * The preview loader (preview-loader.ts), the directory browser (dir-browser.ts),
 * and panel.ts's render/keyboard code all read and mutate this one record. It is a
 * plain mutable object (not a class) so the render closure can read fields directly
 * and the loader/browser can write them, exactly as the original single-closure
 * code did — the split only relocates the behavior, not the state's shape.
 */

import type { Markdown } from "@earendil-works/pi-tui";
import type { PresentedFile } from "./files.ts";
import type { RenderableKind } from "./rendered.ts";

export type PreviewKind = "file" | "dir" | "image" | "binary" | "missing" | "empty" | "loading";

/** A row in a directory preview: a synthetic ".." (when descended) or an entry. */
export type BrowseRow = { kind: "up" } | { kind: "entry"; name: string; isDir: boolean };

/** Headless-Chromium snapshot status for a rendered HTML preview. */
export type HtmlSnap =
	| { status: "idle" }
	| { status: "pending" }
	| { status: "unavailable" }
	| { status: "failed"; error: string }
	| { status: "done"; path: string; width?: number; height?: number };

export interface PreviewState {
	// Preview core
	previewFile: PresentedFile | null;
	previewKind: PreviewKind;
	fileLines: string[];
	dirEntries: Array<{ name: string; isDir: boolean }>;
	previewScroll: number;
	cursorLine: number;
	selAnchor: number | null;
	loadToken: number;
	imageInfo: { mime: string; bytes: number; dims: { widthPx: number; heightPx: number } | null } | null;

	// Directory drill-in (constrained browse root — see loadPreview/loadDir)
	browseRoot: string | null;
	browseRootRel: string | null;
	curatedDir: PresentedFile | null;
	currentDir: string | null;
	dirCursor: number;
	browseStack: Array<{ dir: string; cursor: number }>;
	browsedChild: boolean;
	browseReturnCursor: number;

	// Rendered-preview state (markdown/HTML, `r` toggles rendered↔raw)
	fileText: string;
	highlightedLines: string[];
	renderableAs: RenderableKind | null;
	rendered: boolean;
	mdComp: Markdown | null;
	renderedCache: { width: number; lines: string[] } | null;
	renderedCount: number;

	// HTML browser-snapshot state
	chromiumProbe: string | null | undefined;
	snapToken: number;
	htmlSnap: HtmlSnap;

	// In-file search (per-file; the list filter lives in panel.ts)
	previewSearch: string;
	matchLines: number[];
}

/** A fresh preview state with the same initial values as the original closure. */
export function createPreviewState(): PreviewState {
	return {
		previewFile: null,
		previewKind: "empty",
		fileLines: [],
		dirEntries: [],
		previewScroll: 0,
		cursorLine: 0,
		selAnchor: null,
		loadToken: 0,
		imageInfo: null,
		browseRoot: null,
		browseRootRel: null,
		curatedDir: null,
		currentDir: null,
		dirCursor: 0,
		browseStack: [],
		browsedChild: false,
		browseReturnCursor: 0,
		fileText: "",
		highlightedLines: [],
		renderableAs: null,
		rendered: false,
		mdComp: null,
		renderedCache: null,
		renderedCount: 0,
		chromiumProbe: undefined,
		snapToken: 0,
		htmlSnap: { status: "idle" },
		previewSearch: "",
		matchLines: [],
	};
}
