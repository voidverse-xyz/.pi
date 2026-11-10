/**
 * panel-logic.ts — pure, state-free helpers for the show_files overlay.
 *
 * Everything here is deterministic (inputs → output, no closure state, no I/O,
 * no theme), which is exactly why it lives apart from panel.ts's stateful render
 * closure: it can be unit-tested directly (see panel-logic.test.ts). panel.ts
 * keeps the mutable UI state and calls into these for the underlying math.
 */

import type { PresentedFile, Region } from "./files.ts";

/** A left-list row: a group heading or a curated file. */
export type Row = { kind: "group"; label: string } | { kind: "file"; file: PresentedFile };

/**
 * Interleave group headings with their files, in the agent's order. A heading is
 * emitted the first time a new non-empty group is seen; consecutive files in the
 * same group share it. Order is preserved (the agent's most-important-first order
 * is a documented contract).
 */
export function buildRows(files: PresentedFile[]): Row[] {
	const rows: Row[] = [];
	let lastGroup: string | undefined;
	for (const f of files) {
		if (f.group && f.group !== lastGroup) rows.push({ kind: "group", label: f.group });
		if (f.group) lastGroup = f.group;
		rows.push({ kind: "file", file: f });
	}
	return rows;
}

/** Human-readable byte size: B under 1 KiB, one decimal KB/MB above. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Classify a file preview from cheap, already-known facts. `image` wins outright
 * (decided by extension/mime); otherwise an over-limit file is `toolarge`, a file
 * containing a NUL byte is `binary`, and the rest is `text`.
 */
export function classifyContent(opts: { isImage: boolean; size: number; hasNul: boolean; maxBytes: number }): "image" | "toolarge" | "binary" | "text" {
	if (opts.isImage) return "image";
	if (opts.size > opts.maxBytes) return "toolarge";
	if (opts.hasNul) return "binary";
	return "text";
}

/**
 * Neutralize terminal controls while preserving tabs and line feeds used for
 * layout. Normalize CRLF first so source line numbers remain stable; stray CR,
 * C0, DEL, and C1 controls become visible replacement glyphs.
 */
export function sanitizePreviewText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�");
}

/** Split source text into terminal-safe preview lines, preserving line numbers. */
export function previewLines(text: string): string[] {
	return sanitizePreviewText(text).split("\n");
}

/**
 * Sort directory entries in place: directories first, then case-insensitive name
 * order. Returns the same array for chaining.
 */
export function sortDirEntries<T extends { name: string; isDir: boolean }>(entries: T[]): T[] {
	return entries.sort((a, b) =>
		a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
	);
}

/**
 * Map an absolute path under the browse root to the mention/display path that
 * matches the curated dir's rel (relative when it was relative, else absolute).
 * The `slice` keeps the leading separator from `abs`.
 */
export function browseRelPath(abs: string, root: string | null, rootRel: string | null): string {
	if (!root || rootRel === null) return abs;
	if (abs === root) return rootRel;
	return `${rootRel}${abs.slice(root.length)}`;
}

/** 0-based raw line indices containing `q` (case-insensitive substring). */
export function computeMatchLines(fileLines: string[], q: string): number[] {
	const out: number[] = [];
	if (!q) return out;
	const needle = q.toLowerCase();
	for (let i = 0; i < fileLines.length; i++) {
		if (fileLines[i]!.toLowerCase().includes(needle)) out.push(i);
	}
	return out;
}

/** First match at/after `origin`, wrapping to the first overall; undefined if none. */
export function firstMatchFrom(matchLines: number[], origin: number): number | undefined {
	if (matchLines.length === 0) return undefined;
	return matchLines.find((l) => l >= origin) ?? matchLines[0];
}

/**
 * Next match line strictly past the cursor in `dir`, wrapping around the ends.
 * undefined when there are no matches.
 */
export function nextMatchLine(matchLines: number[], cursorLine: number, dir: 1 | -1): number | undefined {
	if (matchLines.length === 0) return undefined;
	if (dir > 0) return matchLines.find((l) => l > cursorLine) ?? matchLines[0];
	return [...matchLines].reverse().find((l) => l < cursorLine) ?? matchLines[matchLines.length - 1];
}

/** The region containing 1-based-inclusive line `line0 + 1`, else null. */
export function regionIndexAt(regions: Region[], line0: number): { idx: number; note?: string } | null {
	for (let i = 0; i < regions.length; i++) {
		const r = regions[i]!;
		if (line0 + 1 >= r.start && line0 + 1 <= r.end) return { idx: i, note: r.note };
	}
	return null;
}

/**
 * Next region start (0-based, clamped into the file) strictly past the cursor in
 * `dir`, wrapping around the ends. undefined when there are no regions.
 */
export function nextRegionStart(regions: Region[], fileLen: number, cursorLine: number, dir: 1 | -1): number | undefined {
	if (regions.length === 0) return undefined;
	const starts = regions.map((r) => Math.min(r.start - 1, Math.max(0, fileLen - 1)));
	if (dir > 0) return starts.find((s) => s > cursorLine) ?? starts[0];
	return [...starts].reverse().find((s) => s < cursorLine) ?? starts[starts.length - 1];
}

/**
 * Move the list selection by `delta`, skipping group headings (which are never
 * selectable). Returns the new index; unchanged when the move would run off the
 * ends. `rows` only needs its `kind` discriminator, so any row shape works.
 */
export function stepSelection(rows: ReadonlyArray<{ kind: string }>, from: number, delta: number): number {
	if (rows.length === 0) return from;
	const dir = delta < 0 ? -1 : 1;
	let idx = from;
	let remaining = Math.abs(delta);
	while (remaining > 0) {
		let next = idx + dir;
		while (next >= 0 && next < rows.length && rows[next]!.kind === "group") next += dir;
		if (next < 0 || next >= rows.length) break;
		idx = next;
		remaining--;
	}
	return idx;
}

/**
 * New scroll offset that keeps `cursor` visible within a `height`-row window:
 * scroll up to the cursor when it's above the window, down by just enough when
 * it's below. Unchanged when already visible.
 */
export function clampVisible(cursor: number, scroll: number, height: number): number {
	if (cursor < scroll) return cursor;
	if (cursor >= scroll + height) return cursor - height + 1;
	return scroll;
}
