/**
 * File-input machinery for the ask_user panel: typed-path normalization, async
 * path/kind validation (token-guarded stat calls), and the state machine for
 * the lazy tree picker built on picker-tree.ts.
 *
 * ask.ts owns the per-input state and passes in the FileInputState slice plus
 * a `refresh` callback; everything here mutates that slice and asks the panel
 * to redraw. Keyboard dispatch and rendering stay with the panel.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createRoot, flatten, loadChildren, type TreeNode } from "./picker-tree.ts";
import type { FileKind } from "./schema.ts";

export interface FileStatCache {
	raw: string;
	abs: string;
	status: "checking" | "ok" | "wrong-kind";
	message?: string;
}

// The slice of per-input UI state this module reads and mutates.
export interface FileInputState {
	textValue: string;
	pickerRoot?: TreeNode;
	pickerRows: TreeNode[];
	pickerSelected: number;
	pickerScroll: number;
	pickerLoading: boolean;
	pickerLoadToken: number;
	fileStatToken: number;
	fileStat?: FileStatCache;
}

export const PICKER_ROW_CAP = 10;

export function typedPath(root: string, raw: string): { raw: string; abs: string; rel: string; display: string } {
	const clean = raw.trim().replace(/^@/, "");
	const abs = isAbsolute(clean) ? clean : resolve(root, clean);
	const rel = relative(root, abs).replace(/\\/g, "/");
	const display = rel && !rel.startsWith("..") && rel !== "" ? rel : abs;
	return { raw: clean, abs, rel, display };
}

function fileKindError(fileKind: FileKind, isDirectory: boolean): string | null {
	if (fileKind === "file" && isDirectory) return "Pick a file";
	if (fileKind === "directory" && !isDirectory) return "Pick a directory";
	return null;
}

// ----- picker state machine -----

// Keep the picker scroll window over the selected row and within the row list.
function clampPickerScroll(s: FileInputState) {
	if (s.pickerSelected < s.pickerScroll) s.pickerScroll = s.pickerSelected;
	if (s.pickerSelected >= s.pickerScroll + PICKER_ROW_CAP) {
		s.pickerScroll = s.pickerSelected - PICKER_ROW_CAP + 1;
	}
	s.pickerScroll = Math.max(0, Math.min(Math.max(0, s.pickerRows.length - PICKER_ROW_CAP), s.pickerScroll));
}

function rebuildPickerRows(s: FileInputState) {
	s.pickerRows = s.pickerRoot ? flatten(s.pickerRoot) : [];
	const max = Math.max(0, s.pickerRows.length - 1);
	s.pickerSelected = Math.max(0, Math.min(max, s.pickerSelected));
	clampPickerScroll(s);
}

export function ensurePickerLoaded(rootDir: string, s: FileInputState, refresh: () => void) {
	if (!s.pickerRoot) {
		s.pickerRoot = createRoot(rootDir);
		rebuildPickerRows(s);
	}
	if (s.pickerRoot.loaded || s.pickerLoading) return;
	const token = ++s.pickerLoadToken;
	s.pickerLoading = true;
	void loadChildren(rootDir, s.pickerRoot).then(() => {
		if (token !== s.pickerLoadToken) return;
		s.pickerLoading = false;
		rebuildPickerRows(s);
		refresh();
	});
}

export function selectedPickerNode(s: FileInputState): TreeNode | undefined {
	return s.pickerRows[s.pickerSelected];
}

export function movePicker(s: FileInputState, delta: number, refresh: () => void) {
	const max = Math.max(0, s.pickerRows.length - 1);
	s.pickerSelected = Math.max(0, Math.min(max, s.pickerSelected + delta));
	clampPickerScroll(s);
	refresh();
}

export async function expandPickerNode(rootDir: string, s: FileInputState, node: TreeNode, refresh: () => void) {
	if (!node.isDir) return;
	if (!node.loaded) {
		const token = ++s.pickerLoadToken;
		s.pickerLoading = true;
		refresh();
		await loadChildren(rootDir, node);
		if (token !== s.pickerLoadToken) return;
		s.pickerLoading = false;
	}
	node.expanded = true;
	rebuildPickerRows(s);
	refresh();
}

export function collapseOrParentPickerNode(s: FileInputState, node: TreeNode, refresh: () => void) {
	if (node.isDir && node.expanded) {
		node.expanded = false;
		rebuildPickerRows(s);
		refresh();
		return;
	}
	if (node.parent) {
		const parentIdx = s.pickerRows.indexOf(node.parent);
		if (parentIdx >= 0) {
			s.pickerSelected = parentIdx;
			rebuildPickerRows(s);
			refresh();
		}
	}
}

// ----- typed-path validation -----

export function checkFilePath(
	rootDir: string,
	fileKind: FileKind,
	s: FileInputState,
	refresh: () => void,
): FileStatCache | undefined {
	const raw = s.textValue.trim();
	if (!raw) return undefined;
	if (s.fileStat?.raw === raw) return s.fileStat;
	const pathInfo = typedPath(rootDir, raw);
	const token = ++s.fileStatToken;
	s.fileStat = { raw, abs: pathInfo.abs, status: "checking" };
	void stat(pathInfo.abs).then(
		(info) => {
			if (token !== s.fileStatToken) return;
			const kindError = fileKindError(fileKind, info.isDirectory());
			s.fileStat = kindError
				? { raw, abs: pathInfo.abs, status: "wrong-kind", message: kindError }
				: { raw, abs: pathInfo.abs, status: "ok" };
			refresh();
		},
		() => {
			if (token !== s.fileStatToken) return;
			// Nonexistent paths are valid: callers may be asking where to create
			// a new file or directory. fileKind can only be checked when the path
			// already exists and its kind can be inspected.
			s.fileStat = { raw, abs: pathInfo.abs, status: "ok" };
			refresh();
		},
	);
	return s.fileStat;
}
