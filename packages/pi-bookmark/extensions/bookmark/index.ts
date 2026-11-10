/**
 * Entry bookmarking.
 *
 * Uses setLabel to mark entries with labels for easy navigation in /tree.
 * Labels appear in the tree view and help you find important points.
 *
 * Usage:
 *   /bookmark [label]  - bookmark the last assistant message
 *   /unbookmark        - remove the most recent bookmark
 *   /bookmarks         - manage bookmarks: list (label + excerpt), Enter jumps
 *                        to the entry (navigateTree), r renames, d/x deletes,
 *                        q closes.
 *
 * Bookmarks are stored as label entries in the session file (setLabel appends
 * a LabelEntry; sessionManager.getLabel resolves the current label per entry).
 * The manager enumerates them by walking getEntries() and asking getLabel for
 * each — the same source /bookmark writes to.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

interface BookmarkItem {
	id: string;
	label: string;
	excerpt: string;
}

type ManagerAction =
	| { type: "jump"; id: string }
	| { type: "rename"; id: string }
	| { type: "delete"; id: string };

const EXCERPT_MAX = 80;

// ---- bookmark enumeration --------------------------------------------------

// Flatten message content (string or content-block array) to plain text.
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "toolCall" && typeof block.name === "string") parts.push(`[tool: ${block.name}]`);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join(" ");
}

// One-line excerpt of an entry for the manager list.
function entryExcerpt(entry: SessionEntry): string {
	let text = "";
	if (entry.type === "message") {
		const message = entry.message as { role?: string; content?: unknown };
		const body = contentToText(message.content);
		text = message.role ? `${message.role}: ${body}` : body;
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		text = entry.summary;
	} else if (entry.type === "custom_message") {
		text = contentToText(entry.content);
	}
	const single = text.replace(/\s+/g, " ").trim() || `(${entry.type})`;
	return single.length > EXCERPT_MAX ? `${single.slice(0, EXCERPT_MAX - 1)}…` : single;
}

// All currently-labeled entries, in session (chronological) order. Labels are
// resolved via getLabel so cleared/renamed labels reflect their latest state.
function collectBookmarks(ctx: ExtensionCommandContext): BookmarkItem[] {
	const bookmarks: BookmarkItem[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		const label = ctx.sessionManager.getLabel(entry.id);
		if (!label) continue;
		bookmarks.push({ id: entry.id, label, excerpt: entryExcerpt(entry) });
	}
	return bookmarks;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bookmark", {
		description: "Bookmark last message (usage: /bookmark [label])",
		handler: async (args, ctx) => {
			const label = args.trim() || `bookmark-${Date.now()}`;

			// Only inspect the active branch. getEntries() also includes abandoned
			// branches, whose newer messages must not steal the bookmark target.
			const entries = ctx.sessionManager.getBranch();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					pi.setLabel(entry.id, label);
					ctx.ui.notify(`Bookmarked as: ${label}`, "info");
					return;
				}
			}

			ctx.ui.notify("No assistant message to bookmark", "warning");
		},
	});

	// Remove bookmark
	pi.registerCommand("unbookmark", {
		description: "Remove bookmark from last labeled entry",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			// Label changes are append-only. Walk those changes backwards rather
			// than walking target entries, so "most recent" means the bookmark
			// most recently created or renamed.
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type !== "label" || !entry.label) continue;
				if (ctx.sessionManager.getLabel(entry.targetId) !== entry.label) continue;

				pi.setLabel(entry.targetId, undefined);
				ctx.ui.notify(`Removed bookmark: ${entry.label}`, "info");
				return;
			}
			ctx.ui.notify("No bookmarked entry found", "warning");
		},
	});

	// ---- /bookmarks manager -------------------------------------------------

	// SelectList overlay showing label + excerpt. Enter resolves a jump, r a
	// rename, d/x a delete, and q closes. Action keys are intercepted before
	// the list so SelectList only sees navigation input.
	function openManager(ctx: ExtensionCommandContext, bookmarks: BookmarkItem[]): Promise<ManagerAction | null> {
		const items: SelectItem[] = bookmarks.map((b) => ({
			value: b.id,
			label: b.label,
			description: b.excerpt,
		}));

		return ctx.ui.custom<ManagerAction | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			const title = new Text("");
			container.addChild(title);
			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done({ type: "jump", id: item.value });
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			const help = new Text("");
			container.addChild(help);
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			const refreshThemedText = () => {
				title.setText(theme.fg("accent", theme.bold(`Bookmarks (${bookmarks.length})`)));
				help.setText(theme.fg("dim", "↑↓ navigate • enter jump • r rename • d/x delete • q close"));
			};
			refreshThemedText();

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
					refreshThemedText();
				},
				handleInput(data: string) {
					if (data === "q") {
						done(null);
						return;
					}
					const selected = selectList.getSelectedItem();
					if (selected && (matchesKey(data, "r") || matchesKey(data, "shift+r"))) {
						done({ type: "rename", id: selected.value });
						return;
					}
					if (selected && (matchesKey(data, "d") || matchesKey(data, "shift+d") || matchesKey(data, "x") || matchesKey(data, "shift+x"))) {
						done({ type: "delete", id: selected.value });
						return;
					}
					selectList.handleInput(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data);
					tui.requestRender();
				},
			};
		});
	}

	pi.registerCommand("bookmarks", {
		description: "Manage bookmarks — jump to (Enter), rename (r), delete (d/x)",
		handler: async (_args, ctx) => {
			// Rename/delete reopen the manager with fresh data; jump and q leave.
			while (true) {
				const bookmarks = collectBookmarks(ctx);
				if (bookmarks.length === 0) {
					ctx.ui.notify("No bookmarks in this session (use /bookmark [label])", "warning");
					return;
				}

				const action = await openManager(ctx, bookmarks);
				if (!action) return;

				if (action.type === "jump") {
					const label = ctx.sessionManager.getLabel(action.id);
					const result = await ctx.navigateTree(action.id);
					if (!result.cancelled) ctx.ui.notify(`Jumped to bookmark: ${label}`, "info");
					return;
				}

				if (action.type === "rename") {
					const current = ctx.sessionManager.getLabel(action.id) ?? "";
					const next = await ctx.ui.input(`Rename bookmark "${current}"`, current);
					const trimmed = next?.trim();
					if (trimmed && trimmed !== current) {
						pi.setLabel(action.id, trimmed);
						ctx.ui.notify(`Renamed bookmark: ${current} → ${trimmed}`, "info");
					}
					continue;
				}

				if (action.type === "delete") {
					const label = ctx.sessionManager.getLabel(action.id);
					pi.setLabel(action.id, undefined);
					ctx.ui.notify(`Removed bookmark: ${label}`, "info");
				}
			}
		},
	});
}
