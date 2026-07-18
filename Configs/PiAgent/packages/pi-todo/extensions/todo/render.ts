/**
 * render.ts — pure todo-list rendering and validation (unit-tested).
 *
 * The widget mirrors Claude Code's task list (ref IMG_5781): a headerless tree
 * rendered directly above the editor, hanging off the dynamic working header
 * with a `└` tree connector on the first row and follow-up rows indented so
 * the markers align:
 *
 *   ✻ Fixing sandbox/typedefs… (21m 29s · ↓ 62.3k tokens)
 *   └ ✓ Fix store layer          <- completed: green check, dim strikethrough
 *     □ Fix sandbox/typedefs     <- in progress: accent, bold
 *     □ Fix mail                 <- pending: dim box, plain text
 *
 * The header is the FIRST LINE OF THIS WIDGET, not pi's working row (other
 * aboveEditor widgets — e.g. pi-status-line's shared row — would wedge between
 * the two). It is NOT a working indicator clone: the label is custom text the
 * LLM sets via todo_write's optional `header` param (falling back to the
 * active todo's activeForm), dressed with a static ✻, elapsed time, and
 * streamed output tokens (renderHeaderLine below builds the line). pi's
 * built-in working loader row is left untouched and keeps its own spinner.
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

/** `21m 29s`-style elapsed time for the working header. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1_000));
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** `62.3k`-style token count for the working header. */
export function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** The in-progress todo's activeForm (fallback: content), or undefined when none is active. */
export function activeTodoLabel(todos: TodoItem[]): string | undefined {
	const active = todos.find((t) => t.status === "in_progress");
	return active ? active.activeForm || active.content : undefined;
}

/** Static header glyph — deliberately not animated; pi's loader row owns the spinner. */
export const HEADER_MARK = "✻";

/**
 * The dynamic working header, rendered as the widget's first line:
 * `✻ Building pure core modules… (21m 29s · ↓ 62.3k tokens)`.
 * The label is the LLM-set header phrase (or activeForm fallback); the token
 * segment is omitted until the first output tokens arrive.
 */
export function renderHeaderLine(
	label: string,
	elapsedMs: number,
	outputTokens: number,
	theme: TodoRenderTheme,
): string {
	const stats = [formatElapsed(elapsedMs)];
	if (outputTokens > 0) stats.push(`↓ ${formatTokenCount(outputTokens)} tokens`);
	return `${theme.fg("accent", HEADER_MARK)} ${theme.fg("text", `${label}…`)} ${theme.fg("dim", `(${stats.join(" · ")})`)}`;
}

/** Exact output-token count from a message's usage, when the provider reported one. */
export function exactOutputTokens(message: unknown): number | undefined {
	const output = (message as { usage?: { output?: unknown } })?.usage?.output;
	return typeof output === "number" && output > 0 ? output : undefined;
}

/** Rough chars/4 token estimate over a message's text/thinking/toolCall parts. */
export function estimateMessageTokens(message: unknown): number {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return 0;
	let characters = 0;
	for (const part of content) {
		const item = part as { type?: unknown; text?: unknown; thinking?: unknown; arguments?: unknown };
		if (item.type === "text" && typeof item.text === "string") characters += item.text.length;
		else if (item.type === "thinking" && typeof item.thinking === "string") characters += item.thinking.length;
		else if (item.type === "toolCall" && item.arguments !== undefined) {
			try {
				characters += JSON.stringify(item.arguments).length;
			} catch {
				/* best-effort estimate */
			}
		}
	}
	return Math.ceil(characters / 4);
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

export interface TodoState {
	todos: TodoItem[];
	/** LLM-set header phrase from the same call, when one was given. */
	header?: string;
}

/**
 * Pull the most recent todo_write call out of replayed session messages so the
 * list (and its LLM-set header) survives resume/reload. Accepts the loose
 * message shapes the session log actually contains; returns an empty list when
 * none is found.
 */
export function extractLatestTodoState(messages: Iterable<unknown>, toolName: string): TodoState {
	let latest: TodoState = { todos: [] };
	for (const message of messages) {
		const m = message as { role?: string; content?: unknown };
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of m.content) {
			const p = part as { type?: string; name?: string; arguments?: Record<string, unknown> };
			if (p?.type === "toolCall" && p.name === toolName) {
				const todos = coerceTodos(p.arguments?.todos);
				if (todos) {
					const header = p.arguments?.header;
					latest = { todos, ...(typeof header === "string" && header.trim() ? { header: header.trim() } : {}) };
				}
			}
		}
	}
	return latest;
}
