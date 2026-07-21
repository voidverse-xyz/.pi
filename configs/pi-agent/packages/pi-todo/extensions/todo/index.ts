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
 * alt+o cycles the widget between expanded (full list), collapsed (title +
 * one-line summary with the active item and a done-count), and hidden — the
 * keybind is the ONLY user control; there is no slash command. Clearing is the
 * agent's job (todo_write with an empty list).
 * On session start/resume the list is restored from the most recent
 * todo_write call in the replayed session messages, so it survives /reload
 * and resume without any extra persistence.
 *
 * Install as a package: configs/pi-agent/packages/pi-todo/extensions/todo/index.ts
 * Reload: /reload
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildTodoCarryoverPrompt,
	extractLatestTodos,
	renderCollapsedLine,
	renderTitleLine,
	renderTodoItem,
	renderTodoLineEllipsis,
	renderTodoWidgetLines,
	summarizeTodos,
	type TodoItem,
	type TodoOperation,
	validateTodos,
	validateTodoTransition,
} from "./render.ts";

const TOOL_NAME = "todo_write";
const WIDGET_KEY = "todo-list";
const CARRYOVER_MESSAGE_TYPE = "todo-carryover-context";
const PLACEMENT = { placement: "aboveEditor" as const };
// Claude Code uses ctrl+t, but pi core owns that (toggle thinking blocks).
// alt+o avoids pi core's alt+d delete-word-forward binding and is free across
// the installed extensions (alt+s teams stop, alt+a subagents stop, alt+q/alt+x
// queue, alt+t thinking cycle, alt+m model cycle, alt+w procedure stop).
const TOGGLE_KEY = "alt+o";
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
			description: "The complete todo list. A normal update must retain every existing item, including completed items.",
		}),
		operation: Type.Optional(
			StringEnum(["update", "replace", "clear"] as const, {
				description:
					"update (default) preserves every existing item; replace is only for a direct user-requested replan; clear empties the list.",
			}),
		),
		reason: Type.Optional(
			Type.String({
				description: "Required for replace, and for clearing unfinished work. State the direct user request or abandoned plan.",
			}),
		),
	},
	{ additionalProperties: false },
);

// The alt+o cycle: full list -> one-line summary -> gone -> full list again.
type ViewMode = "expanded" | "collapsed" | "hidden";
const NEXT_MODE: Record<ViewMode, ViewMode> = { expanded: "collapsed", collapsed: "hidden", hidden: "expanded" };

export default function todoList(pi: ExtensionAPI) {
	let todos: TodoItem[] = [];
	let viewMode: ViewMode = "expanded";
	let activeTui: TUI | undefined;

	// The widget is a live FACTORY component, not a string array: pi wraps each
	// string-array line in a pi-tui Text, which drops empty/whitespace-only lines
	// entirely — so a trailing padding row is impossible that way. A component's
	// render() lines pass through raw, so the "" padding line actually renders.
	const buildLines = (theme: ExtensionContext["ui"]["theme"]): string[] => {
		if (todos.length === 0 || viewMode === "hidden") return [];
		const tree = viewMode === "collapsed" ? renderCollapsedLine(todos, theme, TOGGLE_KEY) : renderTodoWidgetLines(todos, theme);
		// Trailing blank line: breathing room between the list and whatever
		// renders below it (other widgets / the status row / the editor).
		return [renderTitleLine(todos, theme), ...tree, ""].map((line) => (line ? ` ${line}` : line));
	};

	const mountWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			activeTui = tui;
			return {
				invalidate() {},
				render: (width) =>
					buildLines(theme).map((line) => truncateToWidth(line, width, renderTodoLineEllipsis(line, theme))),
				dispose() {
					if (activeTui === tui) activeTui = undefined;
				},
			};
		}, PLACEMENT);
	};

	const refreshWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		if (!activeTui) mountWidget(ctx);
		activeTui?.requestRender();
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo List",
		description:
			"Create and manage a structured task list for the current session. Call it with the COMPLETE list every time. " +
			"Use it ONLY for genuinely complex work that naturally requires at least 3 substantive steps; never create a list for " +
			"one- or two-step tasks, quick fixes, simple lookups, or a single change plus verification. During normal progress use " +
			"operation update (the default), NEVER remove an existing todo, and keep completed todos visible. Mark a task " +
			"in_progress BEFORE starting it and completed IMMEDIATELY after it is verified, then advance the next task in the same " +
			"complete list. Use replace only for a direct user-requested replan or clear user-directed task/topic pivot. Clear only " +
			"after all items are completed, when the user directly asks to clear/abandon the checklist, or when they clearly move " +
			"to different work; " +
			"destructive operations require their reason when work is unfinished.",
		promptSnippet: "todo_write — track genuinely complex work with 3+ substantive steps; normal updates preserve the full list",
		promptGuidelines: [
			"Use todo_write only when a task is genuinely complex and naturally decomposes into at least 3 substantive steps. Never use it for 1- or 2-step tasks, quick fixes, simple lookups, or a single change plus verification; do not invent filler steps to reach three. Stale-list cleanup on a clear task/topic pivot is the exception and is allowed even when the new work is simple.",
			"At the start of a new user turn, preserve the current todo list for continuations and follow-ups. When the user clearly moves to a different task or topic, remove stale work before starting: replace it with a new complete list if the new work needs 3+ substantive steps, otherwise clear it. Include a reason when replacing or clearing unfinished work.",
			"For normal progress, call todo_write with operation `update` (or omit operation) and resend the complete list. Never remove any existing item; keep completed items visible until the checklist is explicitly cleared or replaced.",
			"Keep exactly one todo in_progress at a time. As soon as a task is actually done (tests pass, verified), mark that same item completed in the complete list before advancing the next task; never skip the observable completed state.",
			"Give each todo stable, unique imperative `content` ('Fix store layer') and an `activeForm` ('Fixing store layer'). Do not reword content during a normal update because content is the item identity.",
			"If new work surfaces within the same task, add it without removing existing items. Use operation `replace` with a reason only when the user directly changes the requested work, including a clear move to a different task or topic; never use replace to evade marking progress complete.",
			"Use operation `clear` only after all todos have been completed, or with a reason when the user directly requests that unfinished work be cleared/abandoned or clearly moves to a different task or topic. Do not clear in the same turn that marks the final item complete; leave the completed checklist visible with the final report.",
		],
		parameters: TodoWriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const next = params.todos as TodoItem[];
			const operation = (params.operation ?? "update") as TodoOperation;
			const shapeError = validateTodos(next);
			if (shapeError) throw new Error(shapeError);
			const transitionError = validateTodoTransition(todos, next, operation, params.reason);
			if (transitionError) throw new Error(transitionError);

			// Commit only after both shape and transition validation succeed. Clone
			// the snapshot so result/session data cannot alias mutable tool arguments.
			todos = next.map((item) => ({ ...item }));
			refreshWidget(ctx);
			const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");
			const hint =
				todos.length === 0
					? "Todo list cleared."
					: allDone
						? "All todos are completed. Leave this checklist visible with the final report; on a later user turn, clear or replace it before starting a different task or topic."
						: "Continue tracking progress in the complete list: preserve every item, mark finished work completed, and then advance the next task.";
			return {
				content: [
					{
						type: "text",
						text: todos.length === 0 ? hint : `Todo list updated.\n${summarizeTodos(todos)}\n${hint}`,
					},
				],
				details: { todos: todos.map((item) => ({ ...item })), operation, ...(params.reason ? { reason: params.reason } : {}) },
			};
		},

		renderCall(args, theme) {
			const list = Array.isArray(args.todos) ? (args.todos as TodoItem[]) : [];
			const done = list.filter((t) => t.status === "completed").length;
			const operation = args.operation ?? "update";
			let text = theme.fg("toolTitle", theme.bold("todo_write "));
			text += theme.fg("muted", `${done}/${list.length} done`);
			if (operation !== "update") text += theme.fg("warning", ` · ${operation}`);
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

	pi.on("context", (event) => {
		const messages = event.messages.filter(
			(message) => (message as { customType?: string }).customType !== CARRYOVER_MESSAGE_TYPE,
		);
		const removedPriorSnapshot = messages.length !== event.messages.length;
		const carryoverPrompt = pi.getActiveTools().includes(TOOL_NAME) ? buildTodoCarryoverPrompt(todos) : null;
		if (!carryoverPrompt) return removedPriorSnapshot ? { messages } : undefined;

		return {
			messages: [
				...messages,
				{
					role: "custom",
					customType: CARRYOVER_MESSAGE_TYPE,
					content: carryoverPrompt,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	const restoreFromActiveBranch = (ctx: ExtensionContext): void => {
		// Successful result details are the committed state. Reading only the
		// active branch keeps reload/resume/fork/tree navigation branch-correct.
		todos = extractLatestTodos(ctx.sessionManager.getBranch(), TOOL_NAME);
	};

	pi.on("session_start", (_event, ctx) => {
		restoreFromActiveBranch(ctx);
		viewMode = "expanded";
		mountWidget(ctx);
		activeTui?.requestRender();
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreFromActiveBranch(ctx);
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		activeTui = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
	});
}
