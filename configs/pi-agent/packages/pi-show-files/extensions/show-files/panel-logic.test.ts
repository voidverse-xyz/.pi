/**
 * Unit tests for panel-logic.ts. Run:
 *   node --experimental-strip-types --test extensions/show-files/panel-logic.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresentedFile, Region } from "./files.ts";
import {
	browseRelPath,
	buildRows,
	classifyContent,
	clampVisible,
	computeMatchLines,
	firstMatchFrom,
	formatBytes,
	nextMatchLine,
	nextRegionStart,
	regionIndexAt,
	sortDirEntries,
	stepSelection,
} from "./panel-logic.ts";

function file(rel: string, group?: string): PresentedFile {
	return { rel, abs: `/root/${rel}`, kind: "file", title: rel, regions: [], ...(group ? { group } : {}) };
}

test("buildRows interleaves group headings, once per contiguous run", () => {
	const rows = buildRows([file("a"), file("b", "g1"), file("c", "g1"), file("d", "g2")]);
	assert.deepEqual(
		rows.map((r) => (r.kind === "group" ? `#${r.label}` : r.file.rel)),
		["a", "#g1", "b", "c", "#g2", "d"],
	);
});

test("buildRows re-emits a heading when a group recurs after another", () => {
	const rows = buildRows([file("a", "g1"), file("b", "g2"), file("c", "g1")]);
	assert.deepEqual(
		rows.filter((r) => r.kind === "group").map((r) => (r as { label: string }).label),
		["g1", "g2", "g1"],
	);
});

test("buildRows of an empty list is empty", () => {
	assert.deepEqual(buildRows([]), []);
});

test("formatBytes picks the right unit and precision", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(1023), "1023 B");
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatBytes(1536), "1.5 KB");
	assert.equal(formatBytes(1024 * 1024), "1.0 MB");
	assert.equal(formatBytes(3 * 1024 * 1024 + 512 * 1024), "3.5 MB");
});

test("classifyContent precedence: image > toolarge > binary > text", () => {
	const base = { size: 10, hasNul: false, maxBytes: 100 };
	assert.equal(classifyContent({ ...base, isImage: true }), "image");
	assert.equal(classifyContent({ ...base, isImage: true, size: 999, hasNul: true }), "image");
	assert.equal(classifyContent({ ...base, isImage: false, size: 101 }), "toolarge");
	assert.equal(classifyContent({ ...base, isImage: false, size: 101, hasNul: true }), "toolarge");
	assert.equal(classifyContent({ ...base, isImage: false, hasNul: true }), "binary");
	assert.equal(classifyContent({ ...base, isImage: false }), "text");
	// Exactly at the limit is NOT too large (strict >).
	assert.equal(classifyContent({ isImage: false, size: 100, hasNul: false, maxBytes: 100 }), "text");
});

test("sortDirEntries: dirs first, then case-insensitive name order", () => {
	const sorted = sortDirEntries([
		{ name: "Zebra", isDir: false },
		{ name: "apple", isDir: false },
		{ name: "beta", isDir: true },
		{ name: "Alpha", isDir: true },
	]);
	assert.deepEqual(sorted.map((e) => e.name), ["Alpha", "beta", "apple", "Zebra"]);
});

test("browseRelPath maps under the root, honoring relative vs absolute base", () => {
	assert.equal(browseRelPath("/root/dir/x.ts", "/root/dir", "src/dir"), "src/dir/x.ts");
	assert.equal(browseRelPath("/root/dir", "/root/dir", "src/dir"), "src/dir");
	// No root context → pass the absolute path through unchanged.
	assert.equal(browseRelPath("/root/dir/x.ts", null, null), "/root/dir/x.ts");
	assert.equal(browseRelPath("/root/dir/x.ts", "/root/dir", null), "/root/dir/x.ts");
	// Absolute base keeps the leading separator via slice.
	assert.equal(browseRelPath("/a/b/c", "/a/b", "/a/b"), "/a/b/c");
});

test("computeMatchLines finds case-insensitive substrings; empty query → none", () => {
	const lines = ["Alpha", "beta line", "gamma BETA", "delta"];
	assert.deepEqual(computeMatchLines(lines, "beta"), [1, 2]);
	assert.deepEqual(computeMatchLines(lines, ""), []);
	assert.deepEqual(computeMatchLines(lines, "zzz"), []);
});

test("firstMatchFrom returns first at/after origin, wrapping to the first", () => {
	assert.equal(firstMatchFrom([2, 5, 9], 0), 2);
	assert.equal(firstMatchFrom([2, 5, 9], 5), 5);
	assert.equal(firstMatchFrom([2, 5, 9], 6), 9);
	assert.equal(firstMatchFrom([2, 5, 9], 10), 2); // wrap
	assert.equal(firstMatchFrom([], 0), undefined);
});

test("nextMatchLine steps past the cursor and wraps both directions", () => {
	assert.equal(nextMatchLine([2, 5, 9], 5, 1), 9);
	assert.equal(nextMatchLine([2, 5, 9], 9, 1), 2); // wrap forward
	assert.equal(nextMatchLine([2, 5, 9], 5, -1), 2);
	assert.equal(nextMatchLine([2, 5, 9], 2, -1), 9); // wrap backward
	assert.equal(nextMatchLine([], 0, 1), undefined);
});

test("regionIndexAt matches 1-based inclusive ranges and returns the note", () => {
	const regions: Region[] = [
		{ start: 3, end: 5, note: "first" },
		{ start: 10, end: 10 },
	];
	assert.deepEqual(regionIndexAt(regions, 2), { idx: 0, note: "first" }); // line 3
	assert.deepEqual(regionIndexAt(regions, 4), { idx: 0, note: "first" }); // line 5 (inclusive)
	assert.deepEqual(regionIndexAt(regions, 9), { idx: 1, note: undefined }); // line 10
	assert.equal(regionIndexAt(regions, 5), null); // line 6, between regions
	assert.equal(regionIndexAt([], 0), null);
});

test("nextRegionStart returns clamped 0-based starts, wrapping", () => {
	const regions: Region[] = [{ start: 3, end: 4 }, { start: 8, end: 9 }];
	assert.equal(nextRegionStart(regions, 100, 0, 1), 2); // first start-1
	assert.equal(nextRegionStart(regions, 100, 2, 1), 7); // next after cursor 2
	assert.equal(nextRegionStart(regions, 100, 7, 1), 2); // wrap forward
	assert.equal(nextRegionStart(regions, 100, 7, -1), 2);
	assert.equal(nextRegionStart(regions, 100, 2, -1), 7); // wrap backward
	// Clamp into a short file: start 8 → min(7, fileLen-1=3) = 3.
	assert.equal(nextRegionStart([{ start: 8, end: 8 }], 4, 0, 1), 3);
	assert.equal(nextRegionStart([], 100, 0, 1), undefined);
});

test("stepSelection skips group rows and stops at the ends", () => {
	// index:  0(file) 1(group) 2(file) 3(file) 4(group) 5(file)
	const rows = [
		{ kind: "file" },
		{ kind: "group" },
		{ kind: "file" },
		{ kind: "file" },
		{ kind: "group" },
		{ kind: "file" },
	];
	assert.equal(stepSelection(rows, 0, 1), 2); // skip the group at 1
	assert.equal(stepSelection(rows, 2, 1), 3);
	assert.equal(stepSelection(rows, 3, 1), 5); // skip the group at 4
	assert.equal(stepSelection(rows, 5, 1), 5); // already at the last file
	assert.equal(stepSelection(rows, 2, -1), 0); // skip the group at 1
	assert.equal(stepSelection(rows, 0, -1), 0); // already at the first
	assert.equal(stepSelection(rows, 0, 2), 3); // multi-step across a group
	assert.equal(stepSelection([], 0, 1), 0);
});

test("clampVisible scrolls only when the cursor leaves the window", () => {
	assert.equal(clampVisible(5, 3, 4), 3); // 5 within [3,6]
	assert.equal(clampVisible(2, 3, 4), 2); // above window → scroll up to cursor
	assert.equal(clampVisible(9, 3, 4), 6); // below → 9 - 4 + 1
	assert.equal(clampVisible(6, 3, 4), 3); // last visible row (3+4-1) stays
	assert.equal(clampVisible(7, 3, 4), 4); // one past → scroll by one
});
