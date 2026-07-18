/**
 * Todo list — Claude Code-style task tracking for Pi.
 *
 * The *agent* calls the todo_write tool (modeled on Claude Code's TodoWrite)
 * with the complete list each time: statuses are pending / in_progress /
 * completed, at most one item in_progress. The live checklist renders in a
 * widget directly above the editor whose first line is a dynamic working
 * header while the agent streams (ref IMG_5781):
 *
 *   ✻ Fixing sandbox/typedefs… (21m 29s · ↓ 62.3k tokens)
 *   └ ✓ Fix store layer          <- green check, dim strikethrough
 *     □ Fix sandbox/typedefs     <- in progress: accent, bold
 *     □ Fix mail
 *
 * The header lives INSIDE the widget (not pi's working row) so nothing can
 * render between it and the tree — other aboveEditor widgets like
 * pi-status-line's shared row sit above the whole block. It is not a clone of
 * the working indicator: the label is custom text the LLM sets via
 * todo_write's optional `header` param (falling back to the active todo's
 * activeForm, then "Working"), dressed with a static ✻, elapsed time, and the
 * output tokens streamed this run. pi's built-in working loader row is left
 * untouched and keeps rendering above everything. The header disappears when
 * the agent settles; the tree stays.
 *
 * alt+d cycles the widget between expanded (full list), collapsed (one-line
 * summary with the active item and a done-count), and hidden. /todos shows
 * the list ("/todos clear" wipes it).
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
	activeTodoLabel,
	estimateMessageTokens,
	exactOutputTokens,
	extractLatestTodoState,
	renderCollapsedLine,
	renderHeaderLine,
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
// alt+q/alt+x queue, alt+t thinking cycle, alt+m model cycle).
const TOGGLE_KEY = "alt+d";
const MAX_TODOS = 50;
// Widget re-render cadence while the agent works — drives the elapsed clock
// and picks up token-count changes (the ✻ glyph is static, so 1s is enough).
const HEADER_TICK_MS = 1_000;
const HEADER_FALLBACK_LABEL = "Working";

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
		header: Type.Optional(
			Type.String({
				description:
					"Short present-continuous phrase shown as the status header above the list, e.g. 'Building pure core modules'. " +
					"Describe the overall work, not one todo — update it as the work shifts. Omit to fall back to the in-progress todo's activeForm.",
			}),
		),
	},
	{ additionalProperties: false },
);

// The alt+d cycle: full list -> one-line summary -> gone -> full list again.
type ViewMode = "expanded" | "collapsed" | "hidden";
const NEXT_MODE: Record<ViewMode, ViewMode> = { expanded: "collapsed", collapsed: "hidden", hidden: "expanded" };

export default function todoList(pi: ExtensionAPI) {
	let todos: TodoItem[] = [];
	let viewMode: ViewMode = "expanded";
	let activeCtx: ExtensionContext | undefined;
	// LLM-set header phrase from the latest todo_write call (undefined -> activeForm fallback).
	let headerLabel: string | undefined;
	let headerStartedAt: number | undefined;
	let headerTimer: ReturnType<typeof setInterval> | undefined;
	// Output tokens this agent run: finalized assistant messages + the streaming one.
	let doneTokens = 0;
	let streamingTokens = 0;

	const refreshWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		const header =
			headerStartedAt === undefined
				? []
				: [
						renderHeaderLine(
							headerLabel ?? activeTodoLabel(todos) ?? HEADER_FALLBACK_LABEL,
							Date.now() - headerStartedAt,
							doneTokens + streamingTokens,
							theme,
						),
					];
		const tree =
			todos.length === 0 || viewMode === "hidden"
				? []
				: viewMode === "collapsed"
					? renderCollapsedLine(todos, theme)
					: renderTodoWidgetLines(todos, theme);
		const lines = [...header, ...tree];
		ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, PLACEMENT);
	};

	const stopHeader = (ctx: ExtensionContext): void => {
		if (headerTimer) clearInterval(headerTimer);
		headerTimer = undefined;
		headerStartedAt = undefined;
		refreshWidget(ctx);
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
			"Optionally set `header` — a short present-continuous phrase for the status line above the list describing the overall work ('Building pure core modules'); keep it fresh as the work shifts.",
			"If new work surfaces mid-task, add it to the list rather than silently expanding scope.",
		],
		parameters: TodoWriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const err = validateTodos(params.todos as TodoItem[]);
			if (err) throw new Error(err);
			todos = params.todos as TodoItem[];
			headerLabel = typeof params.header === "string" && params.header.trim() ? params.header.trim() : undefined;
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
				headerLabel = undefined;
				refreshWidget(ctx);
				ctx.ui.notify("Todo list cleared", "info");
				return;
			}
			ctx.ui.notify(summarizeTodos(todos), "info");
		},
	});

	pi.on("agent_start", (_event, ctx) => {
		activeCtx = ctx;
		if (ctx.mode !== "tui" || headerStartedAt !== undefined) return;
		headerStartedAt = Date.now();
		doneTokens = 0;
		streamingTokens = 0;
		refreshWidget(ctx);
		headerTimer = setInterval(() => {
			if (activeCtx) refreshWidget(activeCtx);
		}, HEADER_TICK_MS);
		headerTimer.unref?.();
	});

	// Token counts render on the next header tick (≤120ms), so no eager refresh.
	pi.on("message_update", (event) => {
		streamingTokens = exactOutputTokens(event.message) ?? estimateMessageTokens(event.message);
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		doneTokens += exactOutputTokens(event.message) ?? estimateMessageTokens(event.message);
		streamingTokens = 0;
	});

	pi.on("agent_settled", (_event, ctx) => {
		stopHeader(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		// Rebuild from the replayed session log so the list survives resume,
		// /reload, and fork — the last todo_write call wins.
		const messages: unknown[] = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message") messages.push(entry.message);
		}
		const restored = extractLatestTodoState(messages, TOOL_NAME);
		todos = restored.todos;
		headerLabel = restored.header;
		viewMode = "expanded";
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (headerTimer) clearInterval(headerTimer);
		headerTimer = undefined;
		headerStartedAt = undefined;
		activeCtx = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
	});
}
