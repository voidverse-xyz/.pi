/**
 * preview-loader.ts — loads content into the shared preview state.
 *
 * Extracted verbatim from panel.ts: curated-item loading (loadPreview), the
 * constrained directory listing (loadDir), child-file previews (loadChildFile /
 * loadFileContent), syntax highlighting, the headless-Chromium HTML snapshot,
 * and the external-browser opener. All mutable state lives in the PreviewState
 * record; panel.ts supplies rerender/notify and the directory-browser hooks
 * through PreviewLoaderDeps.
 */

import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { findChromium, openExternally, renderHtmlSnapshot, snapshotPathFor } from "./browser.ts";
import type { PresentedFile } from "./files.ts";
import { browseRelPath, classifyContent, sortDirEntries } from "./panel-logic.ts";
import type { BrowseRow, PreviewState } from "./preview-state.ts";
import { renderableKind } from "./rendered.ts";

const MAX_PREVIEW_BYTES = 512 * 1024;
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

export interface PreviewLoaderDeps {
	rerender: () => void;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	browseRows: () => BrowseRow[];
	keepDirCursorVisible: () => void;
}

export function createPreviewLoader(state: PreviewState, deps: PreviewLoaderDeps) {
	function rebuildSyntaxHighlighting() {
		state.highlightedLines = [];
		const file = state.previewFile;
		if (!file || state.previewKind !== "file") return;
		const lang = getLanguageFromPath(file.abs);
		if (!lang) return;
		try {
			const highlighted = highlightCode(state.fileText.replace(/\t/g, "    "), lang);
			// A mismatch would break the raw-line cursor, gutter, and region mapping.
			// Fall back to the existing plain rendering rather than misaligning them.
			if (highlighted.length === state.fileLines.length) state.highlightedLines = highlighted;
		} catch {
			// Syntax coloring is presentation-only; raw preview must always remain usable.
			state.highlightedLines = [];
		}
	}

	// Clears the per-preview render state. Deliberately does NOT touch the browse
	// context (browseRoot/currentDir/stack) — loadDir/loadChildFile reuse it while
	// staying inside a directory; only loadPreview resets the browse context.
	function resetPreviewState() {
		state.previewScroll = 0;
		state.cursorLine = 0;
		state.selAnchor = null;
		state.fileLines = [];
		state.dirEntries = [];
		state.imageInfo = null;
		state.fileText = "";
		state.highlightedLines = [];
		state.renderableAs = null;
		state.rendered = false;
		state.mdComp = null;
		state.renderedCache = null;
		state.renderedCount = 0;
		state.previewSearch = ""; // in-file search is per-file (the list filter persists)
		state.matchLines = [];
		state.htmlSnap = { status: "idle" };
		state.snapToken++; // invalidate any in-flight snapshot for the previous file
	}

	// Load a curated item (from the left list). Resets the browse context; a
	// directory becomes the browse root, a file loads its content.
	async function loadPreview(file: PresentedFile | undefined) {
		resetPreviewState();
		state.browseRoot = null;
		state.browseRootRel = null;
		state.curatedDir = null;
		state.currentDir = null;
		state.dirCursor = 0;
		state.browseStack = [];
		state.browsedChild = false;

		if (!file) {
			state.previewFile = null;
			state.previewKind = "empty";
			deps.rerender();
			return;
		}
		state.previewFile = file;
		if (file.kind === "missing") {
			state.previewKind = "missing";
			deps.rerender();
			return;
		}
		if (file.kind === "dir") {
			state.browseRoot = file.abs;
			state.browseRootRel = file.rel;
			state.curatedDir = file;
			await loadDir(file.abs);
			return;
		}
		await loadFileContent(file);
	}

	// List a directory (the curated root or a descendant). Keeps the browse
	// context; only resets render state. `cursorTo` lands the selection (used when
	// popping back up so we return to the entry we descended from).
	async function loadDir(abs: string, cursorTo = 0) {
		resetPreviewState();
		state.browsedChild = false;
		state.currentDir = abs;
		state.previewKind = "loading";
		state.previewFile =
			abs === state.browseRoot && state.curatedDir
				? state.curatedDir
				: { rel: browseRelPath(abs, state.browseRoot, state.browseRootRel), abs, kind: "dir", title: basename(abs), regions: [] };
		const token = ++state.loadToken;
		deps.rerender();
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
			sortDirEntries(entries);
			if (token !== state.loadToken) return;
			state.dirEntries = entries;
			state.previewKind = "dir";
		} catch {
			if (token !== state.loadToken) return;
			state.dirEntries = [];
			state.previewKind = "missing";
		}
		state.dirCursor = Math.max(0, Math.min(cursorTo, deps.browseRows().length - 1));
		deps.keepDirCursorVisible();
		deps.rerender();
	}

	// Preview a file discovered by browsing — reuses the raw-file machinery via a
	// synthetic PresentedFile, without disturbing the browse context.
	async function loadChildFile(abs: string, rel: string) {
		await loadFileContent({ rel, abs, kind: "file", title: basename(abs), regions: [] });
	}

	async function loadFileContent(file: PresentedFile) {
		resetPreviewState();
		state.previewFile = file;
		state.previewKind = "loading";
		const token = ++state.loadToken;
		deps.rerender();
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
			if (token !== state.loadToken) return;
			const kind = classifyContent({ isImage: mime !== undefined, size, hasNul: buf.includes(0), maxBytes: MAX_PREVIEW_BYTES });
			if (kind === "image") {
				// Parse dimensions from the header only (cheap); the card shows path,
				// type, dimensions, and size — see the image branch in previewColumn.
				// A dimension-parse failure must NOT drop us to "missing" — the card is
				// still useful with dims unknown, so it's guarded independently.
				let dims: { widthPx: number; heightPx: number } | null = null;
				try {
					dims = getImageDimensions(buf.toString("base64"), mime!) ?? null;
				} catch {
					dims = null;
				}
				state.imageInfo = { mime: mime!, bytes: size, dims };
				state.previewKind = "image";
			} else if (kind === "toolarge") {
				state.fileLines = [`(file too large to preview — ${(size / 1024).toFixed(0)} KB)`];
				state.previewKind = "file";
			} else if (kind === "binary") {
				state.previewKind = "binary";
			} else {
				state.fileText = buf.toString("utf8");
				state.fileLines = state.fileText.split("\n");
				state.previewKind = "file";
				rebuildSyntaxHighlighting();
				// Markdown/HTML render by default — but regions reference raw line
				// numbers, so a spec with regions opens raw.
				state.renderableAs = renderableKind(file.abs);
				state.rendered = state.renderableAs !== null && file.regions.length === 0;
				// Open on the agent's first highlight region, a few lines of breathing room above.
				const first = file.regions[0];
				if (first) {
					state.cursorLine = Math.min(first.start - 1, Math.max(0, state.fileLines.length - 1));
					state.previewScroll = Math.max(0, state.cursorLine - 3);
				}
				// Kick off a headless browser snapshot for HTML (best-effort, async).
				if (state.renderableAs === "html") void startHtmlSnapshot(file);
			}
		} catch {
			if (token !== state.loadToken) return;
			state.previewKind = "missing";
		}
		deps.rerender();
	}

	// Render the HTML file to a PNG with a local headless Chromium so the user can
	// `o`-open a faithful view. Best-effort + cached by mtime (so arrowing back to
	// the same file doesn't relaunch a browser). The result never paints inline —
	// it drives the banner in the rendered HTML view. Guarded by snapToken so a
	// stale in-flight snapshot for a previous file can't overwrite current state.
	async function startHtmlSnapshot(file: PresentedFile) {
		const token = ++state.snapToken;
		state.htmlSnap = { status: "pending" };
		deps.rerender();
		if (state.chromiumProbe === undefined) state.chromiumProbe = await findChromium();
		if (token !== state.snapToken) return;
		if (!state.chromiumProbe) {
			state.htmlSnap = { status: "unavailable" };
			deps.rerender();
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
			if (token !== state.snapToken) return;
			state.htmlSnap = { status: "done", path: out, width: dims?.widthPx, height: dims?.heightPx };
			deps.rerender();
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
		if (token !== state.snapToken) return;
		const res = await renderHtmlSnapshot(state.chromiumProbe, file.abs, out);
		if (token !== state.snapToken) return;
		if (!res.ok) {
			state.htmlSnap = { status: "failed", error: res.error };
			deps.rerender();
			return;
		}
		await finishDone();
	}

	function openInBrowser() {
		const f = state.previewFile;
		if (!f || state.renderableAs !== "html") {
			deps.notify("Open in browser is for HTML files", "info");
			return;
		}
		deps.notify(`Opening ${f.rel} in your browser…`, "info");
		openExternally(f.abs).then((r) => {
			if (!r.ok) deps.notify(`Couldn't open externally: ${r.error ?? "no opener found"}`, "error");
		});
	}

	return { loadPreview, loadDir, loadChildFile, openInBrowser, rebuildSyntaxHighlighting };
}
