/**
 * render.ts — pure todo-list rendering and validation (unit-tested).
 *
 * The widget mirrors Claude Code's task list (ref IMG_5781): a static title
 * line, then the tree with a `└` connector on the first row and follow-up rows
 * indented so the markers align:
 *
 *   󰝖 Todos · 1/3
 *   └ ✓ Fix store layer          <- completed: green check, dim strikethrough
 *     □ Fix sandbox/typedefs     <- in progress: accent, bold
 *     □ Fix mail                 <- pending: dim box, plain text
 *
 * The title is a plain list header — NOT a working indicator: no spinner, no
 * elapsed time, no tokens, no dynamic label (pi-codex-ui's loader row owns all
 * of that). It renders whenever the list is non-empty, working or idle, so the
 * list always reads as what it is: a todo list.
 *
 * Ordering is the agent's own (todo_write replaces the whole list), never
 * re-sorted here. The widget is hidden entirely when the list is empty.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** Present-continuous form, e.g. "Fixing store layer" — shown for the in-progress item. */
	activeForm?: string;
}

/** Minimal structural slice of the pi Theme, so render stays pure and testable. */
export interface TodoRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

export const MARK_DONE = "✓";
export const MARK_OPEN = "□";

/** One styled row, without tree indentation — shared by the widget and the tool-result view. */
export function renderTodoItem(item: TodoItem, theme: TodoRenderTheme): string {
	switch (item.status) {
		case "completed":
			return `${theme.fg("success", MARK_DONE)} ${theme.fg("dim", theme.strikethrough(item.content))}`;
		case "in_progress":
			return `${theme.fg("accent", MARK_OPEN)} ${theme.bold(theme.fg("accent", item.activeForm || item.content))}`;
		case "pending":
			return `${theme.fg("dim", MARK_OPEN)} ${theme.fg("text", item.content)}`;
	}
}

/** Pure: the widget's lines for one render pass. [] when the list is empty. */
export function renderTodoWidgetLines(todos: TodoItem[], theme: TodoRenderTheme): string[] {
	return todos.map((item, i) => {
		const connector = i === 0 ? theme.fg("dim", "└ ") : "  ";
		return `${connector}${renderTodoItem(item, theme)}`;
	});
}

/**
 * Collapsed one-line summary: the in-progress item (or the next pending one),
 * plus a done-count — `└ □ Fixing sandbox/typedefs · 1/3 done`. Used when the
 * widget is collapsed instead of fully expanded or hidden.
 */
export function renderCollapsedLine(todos: TodoItem[], theme: TodoRenderTheme): string[] {
	if (todos.length === 0) return [];
	const done = todos.filter((t) => t.status === "completed").length;
	const count = theme.fg("dim", ` · ${done}/${todos.length} done`);
	const active = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
	const head = active
		? renderTodoItem(active, theme)
		: `${theme.fg("success", MARK_DONE)} ${theme.fg("dim", "all done")}`;
	return [`${theme.fg("dim", "└ ")}${head}${count}`];
}

/** Static title glyph: a checklist (nf-md-format_list_checks) — reads as "todo list". */
export const TITLE_ICON = "󰝖";

/**
 * The list's title line — a simple, always-on header (working or idle):
 * `󰝖 Todos · 1/3`. Muted title, dim progress count; nothing dynamic.
 */
export function renderTitleLine(todos: TodoItem[], theme: TodoRenderTheme): string {
	const done = todos.filter((t) => t.status === "completed").length;
	return theme.fg("muted", `${TITLE_ICON} Todos`) + theme.fg("dim", ` · ${done}/${todos.length}`);
}

/** Plain-text list for the LLM tool result and /todos notify (no ANSI). */
export function summarizeTodos(todos: TodoItem[]): string {
	if (todos.length === 0) return "Todo list is empty.";
	const lines = todos.map((item) => {
		const mark = item.status === "completed" ? `[${MARK_DONE}]` : item.status === "in_progress" ? "[~]" : "[ ]";
		return `${mark} ${item.content}`;
	});
	const done = todos.filter((t) => t.status === "completed").length;
	return `${lines.join("\n")}\n(${done}/${todos.length} completed)`;
}

/** Returns an error string for an invalid list, or null when valid. */
export function validateTodos(todos: TodoItem[]): string | null {
	for (const item of todos) {
		if (!item.content.trim()) return "Every todo needs non-empty content.";
	}
	const inProgress = todos.filter((t) => t.status === "in_progress").length;
	if (inProgress > 1) {
		return `Only one todo may be in_progress at a time (got ${inProgress}). Finish or demote the others first.`;
	}
	return null;
}

const VALID_STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

/**
 * Coerce an untrusted `arguments.todos` value (from a replayed session entry)
 * into a valid TodoItem[] — null when the shape is wrong. Never throws.
 */
export function coerceTodos(value: unknown): TodoItem[] | null {
	if (!Array.isArray(value)) return null;
	const out: TodoItem[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return null;
		const { content, status, activeForm } = entry as Record<string, unknown>;
		if (typeof content !== "string" || typeof status !== "string" || !VALID_STATUSES.includes(status)) return null;
		out.push({
			content,
			status: status as TodoStatus,
			...(typeof activeForm === "string" ? { activeForm } : {}),
		});
	}
	return validateTodos(out) === null ? out : null;
}

/**
 * Pull the most recent todo_write call's list out of replayed session messages
 * so it survives resume/reload. Accepts the loose message shapes the session
 * log actually contains; returns an empty list when none is found.
 */
export function extractLatestTodos(messages: Iterable<unknown>, toolName: string): TodoItem[] {
	let latest: TodoItem[] = [];
	for (const message of messages) {
		const m = message as { role?: string; content?: unknown };
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of m.content) {
			const p = part as { type?: string; name?: string; arguments?: Record<string, unknown> };
			if (p?.type === "toolCall" && p.name === toolName) {
				const todos = coerceTodos(p.arguments?.todos);
				if (todos) latest = todos;
			}
		}
	}
	return latest;
}
