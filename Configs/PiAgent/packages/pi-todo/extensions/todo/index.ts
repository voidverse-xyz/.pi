/**
 * Todo list — Claude Code-style task tracking for Pi.
 *
 * The *agent* calls the todo_write tool (modeled on Claude Code's TodoWrite)
 * with the complete list each time: statuses are pending / in_progress /
 * completed, at most one item in_progress. The live checklist renders in a
 * plain aboveEditor widget with a simple, static title line:
 *
 *   󰝖 Todos · 1/3
 *   └ ✓ Fix store layer          <- green check, dim strikethrough
 *     □ Fix sandbox/typedefs     <- in progress: accent, bold
 *     □ Fix mail
 *
 * The title is a list header, not a working indicator: no spinner, elapsed
 * time, token count, or dynamic label (pi's loader row owns those). It shows
 * whenever the list is non-empty — working or idle — so the checklist is
 * always identifiable at a glance.
 *
 * alt+d cycles the widget between expanded (full list), collapsed (title +
 * one-line summary with the active item and a done-count), and hidden. /todos
 * shows the list ("/todos clear" wipes it).
 * On session start/resume the list is restored from the most recent
 * todo_write call in the replayed session messages, so it survives /reload
 * and resume without any extra persistence.
 *
 * Install as a package: packages/pi-todo/extensions/todo/index.ts
 * Reload: /reload
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	extractLatestTodos,
	renderCollapsedLine,
	renderTitleLine,
	renderTodoItem,
	renderTodoWidgetLines,
	summarizeTodos,
	type TodoItem,
	validateTodos,
} from "./render.ts";

const TOOL_NAME = "todo_write";
const WIDGET_KEY = "todo-list";
const PLACEMENT = { placement: "aboveEditor" as const };
// Claude Code uses ctrl+t, but pi core owns that (toggle thinking blocks).
// alt+d is free across pi core and the installed extensions (alt+s teams stop,
// alt+a subagents stop, alt+q/alt+x queue, alt+t thinking cycle, alt+m model cycle).
const TOGGLE_KEY = "alt+d";
const MAX_TODOS = 50;

const TodoSchema = Type.Object(
	{
		content: Type.String({ description: "Imperative description of the task, e.g. 'Fix the auth bug'" }),
		status: StringEnum(["pending", "in_progress", "completed"] as const, {
			description: "Task state. Exactly one task should be in_progress at a time.",
		}),
		activeForm: Type.Optional(
			Type.String({ description: "Present-continuous form shown while in progress, e.g. 'Fixing the auth bug'" }),
		),
	},
	{ additionalProperties: false },
);

const TodoWriteParams = Type.Object(
	{
		todos: Type.Array(TodoSchema, {
			maxItems: MAX_TODOS,
			description: "The complete todo list. This REPLACES the previous list, so always send every item, not just the changed one.",
		}),
	},
	{ additionalProperties: false },
);

// The alt+d cycle: full list -> one-line summary -> gone -> full list again.
type ViewMode = "expanded" | "collapsed" | "hidden";
const NEXT_MODE: Record<ViewMode, ViewMode> = { expanded: "collapsed", collapsed: "hidden", hidden: "expanded" };

export default function todoList(pi: ExtensionAPI) {
	let todos: TodoItem[] = [];
	let viewMode: ViewMode = "expanded";

	const refreshWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		if (todos.length === 0 || viewMode === "hidden") {
			ctx.ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
			return;
		}
		const theme = ctx.ui.theme;
		const tree = viewMode === "collapsed" ? renderCollapsedLine(todos, theme, TOGGLE_KEY) : renderTodoWidgetLines(todos, theme);
		// Trailing blank line: breathing room between the list and whatever renders
		// below it (other widgets / the status row / the editor).
		ctx.ui.setWidget(WIDGET_KEY, [renderTitleLine(todos, theme), ...tree, ""], PLACEMENT);
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo List",
		description:
			"Create and manage a structured task list for the current session. Call it with the COMPLETE list every time — " +
			"it replaces the previous list. Use it to plan multi-step work and to give the user visibility into progress. " +
			"Mark a task in_progress BEFORE starting it (only one at a time), and completed IMMEDIATELY after finishing it; " +
			"do not batch up completions. Skip the todo list entirely for trivial single-step tasks.",
		promptSnippet: "todo_write — plan and track multi-step work as a visible todo list (replaces the whole list each call)",
		promptGuidelines: [
			"For any task with 3+ steps (or multiple distinct deliverables), call todo_write up front to plan the work, then keep it current as you go.",
			"todo_write replaces the entire list: resend every item each call, changing only the statuses/content that moved.",
			"Keep exactly one todo in_progress at a time; mark it completed as soon as it is actually done (tests pass, verified), never in advance.",
			"Give each todo an imperative `content` ('Fix store layer') and an `activeForm` ('Fixing store layer') for the in-progress display.",
			"If new work surfaces mid-task, add it to the list rather than silently expanding scope.",
		],
		parameters: TodoWriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const err = validateTodos(params.todos as TodoItem[]);
			if (err) throw new Error(err);
			todos = params.todos as TodoItem[];
			refreshWidget(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							"Todo list updated.\n" +
							`${summarizeTodos(todos)}\n` +
							"Continue tracking your progress: mark tasks in_progress when you start them and completed when done.",
					},
				],
				details: { todos },
			};
		},

		renderCall(args, theme) {
			const list = Array.isArray(args.todos) ? (args.todos as TodoItem[]) : [];
			const done = list.filter((t) => t.status === "completed").length;
			let text = theme.fg("toolTitle", theme.bold("todo_write "));
			text += theme.fg("muted", `${done}/${list.length} done`);
			const active = list.find((t) => t.status === "in_progress");
			if (active) text += theme.fg("dim", ` · ${active.activeForm || active.content}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { todos?: TodoItem[] } | undefined;
			if (!details?.todos) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			return new Text(details.todos.map((item) => renderTodoItem(item, theme)).join("\n"), 0, 0);
		},
	});

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Cycle the todo widget: expanded / collapsed / hidden",
		handler: (ctx) => {
			viewMode = NEXT_MODE[viewMode];
			refreshWidget(ctx);
			if (viewMode === "hidden" && todos.length > 0) {
				ctx.ui.notify(`Todo list hidden (${TOGGLE_KEY} to show)`, "info");
			}
		},
	});

	pi.registerCommand("todos", {
		description: `Show the current todo list; "clear" wipes it (${TOGGLE_KEY} cycles the widget: expanded/collapsed/hidden)`,
		getArgumentCompletions: (prefix) =>
			"clear".startsWith(prefix.trim()) && prefix.trim().length > 0 ? [{ value: "clear", label: "clear" }] : null,
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				todos = [];
				refreshWidget(ctx);
				ctx.ui.notify("Todo list cleared", "info");
				return;
			}
			ctx.ui.notify(summarizeTodos(todos), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// Rebuild from the replayed session log so the list survives resume,
		// /reload, and fork — the last todo_write call wins.
		const messages: unknown[] = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message") messages.push(entry.message);
		}
		todos = extractLatestTodos(messages, TOOL_NAME);
		viewMode = "expanded";
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
	});
}
