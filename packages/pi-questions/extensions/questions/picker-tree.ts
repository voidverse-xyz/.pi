/**
 * Lazy filesystem tree model for the ask_user file-picker input.
 *
 * Nodes are loaded on demand: a directory's children are read only when it is
 * first expanded, so opening the picker never walks the whole tree up front.
 * "Show everything" — no gitignore/dotfile filtering; unreadable directories
 * simply expand to an empty child list. The tree is rooted at the asking
 * agent's cwd.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export interface TreeNode {
	name: string;
	abs: string;
	/** Path relative to the picker root (cwd). "" for the root itself. */
	rel: string;
	isDir: boolean;
	depth: number;
	expanded: boolean;
	loaded: boolean;
	children: TreeNode[];
	parent: TreeNode | null;
}

/** Directories first, then files; case-insensitive alphabetical within each. */
function compareEntries(a: { name: string; isDir: boolean }, b: { name: string; isDir: boolean }): number {
	if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
	return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

export function createRoot(cwd: string): TreeNode {
	return {
		name: cwd.split("/").pop() || cwd,
		abs: cwd,
		rel: "",
		isDir: true,
		depth: 0,
		expanded: true,
		loaded: false,
		children: [],
		parent: null,
	};
}

/** Read (or re-read) a directory node's immediate children. */
export async function loadChildren(root: string, node: TreeNode): Promise<void> {
	if (!node.isDir) return;
	let entries: Array<{ name: string; isDir: boolean }> = [];
	try {
		const dirents = await readdir(node.abs, { withFileTypes: true });
		for (const d of dirents) {
			let isDir = d.isDirectory();
			// Resolve symlinks so a link to a directory expands correctly.
			if (d.isSymbolicLink()) {
				try {
					isDir = (await stat(join(node.abs, d.name))).isDirectory();
				} catch {
					isDir = false;
				}
			}
			entries.push({ name: d.name, isDir });
		}
	} catch {
		entries = [];
	}

	entries.sort(compareEntries);
	node.children = entries.map((e) => {
		const abs = join(node.abs, e.name);
		return {
			name: e.name,
			abs,
			rel: relative(root, abs).replace(/\\/g, "/"),
			isDir: e.isDir,
			depth: node.depth + 1,
			expanded: false,
			loaded: false,
			children: [],
			parent: node,
		} satisfies TreeNode;
	});
	node.loaded = true;
}

/** Flatten the tree into the currently-visible rows (respecting `expanded`). */
export function flatten(root: TreeNode): TreeNode[] {
	const out: TreeNode[] = [];
	const walk = (node: TreeNode) => {
		// The root is a container; its children are the top-level rows.
		if (node.depth > 0) out.push(node);
		if (node.isDir && node.expanded) {
			for (const c of node.children) walk(c);
		}
	};
	walk(root);
	return out;
}
