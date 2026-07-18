import assert from "node:assert/strict";
import test from "node:test";
import {
	coerceTodos,
	extractLatestTodos,
	MARK_DONE,
	MARK_OPEN,
	renderCollapsedLine,
	renderTitleLine,
	renderTodoWidgetLines,
	summarizeTodos,
	TITLE_ICON,
	type TodoItem,
	validateTodos,
} from "./render.ts";

// Tagging fake: styles become readable markers so assertions check both text and color.
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
	strikethrough: (text: string) => `<s>${text}</s>`,
};

const list: TodoItem[] = [
	{ content: "Fix store layer", status: "completed" },
	{ content: "Fix sandbox/typedefs", status: "in_progress", activeForm: "Fixing sandbox/typedefs" },
	{ content: "Fix mail", status: "pending" },
];

test("renderTodoWidgetLines: tree connector on first row, aligned indent after", () => {
	const lines = renderTodoWidgetLines(list, theme);
	assert.equal(lines.length, 3);
	assert.ok(lines[0]!.startsWith("<dim>└ </dim>"));
	assert.ok(lines[1]!.startsWith("  "));
	assert.ok(lines[2]!.startsWith("  "));
});

test("renderTodoWidgetLines: completed is green check + dim strikethrough", () => {
	const [done] = renderTodoWidgetLines(list, theme);
	assert.ok(done!.includes(`<success>${MARK_DONE}</success>`));
	assert.ok(done!.includes("<dim><s>Fix store layer</s></dim>"));
});

test("renderTodoWidgetLines: in-progress is bold accent using activeForm", () => {
	const lines = renderTodoWidgetLines(list, theme);
	assert.ok(lines[1]!.includes(`<accent>${MARK_OPEN}</accent>`));
	assert.ok(lines[1]!.includes("<b><accent>Fixing sandbox/typedefs</accent></b>"));
});

test("renderTodoWidgetLines: pending is dim box + plain text", () => {
	const lines = renderTodoWidgetLines(list, theme);
	assert.ok(lines[2]!.includes(`<dim>${MARK_OPEN}</dim>`));
	assert.ok(lines[2]!.includes("<text>Fix mail</text>"));
});

test("renderTodoWidgetLines: empty list renders nothing", () => {
	assert.deepEqual(renderTodoWidgetLines([], theme), []);
});

test("renderCollapsedLine: in-progress item + done-count + expand hint on one line", () => {
	const lines = renderCollapsedLine(list, theme, "alt+d");
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.startsWith("<dim>└ </dim>"));
	assert.ok(lines[0]!.includes("Fixing sandbox/typedefs"));
	assert.ok(lines[0]!.includes("<dim> · 1/3 done</dim>"));
	assert.ok(lines[0]!.includes("<dim> · alt+d expand</dim>"));
	assert.ok(!renderCollapsedLine(list, theme)[0]!.includes("expand"), "no hint without a key");
});

test("renderTodoWidgetLines: long lists window around the active item with … markers + hint", () => {
	const long: TodoItem[] = Array.from({ length: 14 }, (_, i) => ({
		content: `task ${i}`,
		status: i < 9 ? "completed" : i === 9 ? "in_progress" : "pending",
	}));
	const lines = renderTodoWidgetLines(long, theme);
	assert.equal(lines.length, 8, "6 items + 2 markers");
	assert.ok(lines[0]!.includes("… +7 earlier"), "earlier marker counts hidden rows");
	assert.ok(lines.some((l) => l.includes("task 9")), "active item visible in the window");
	assert.ok(lines[7]!.includes("… +1 more"), "trailing marker");
	assert.ok(lines[7]!.includes("· alt+d"), "keybind hint on the last marker");
	assert.ok(lines[0]!.startsWith("<dim>└ </dim>"), "connector still on the first row");
	// Active at the very end: no trailing marker, hint moves to the earlier marker.
	const tail = renderTodoWidgetLines(long.map((t, i) => ({ ...t, status: i === 13 ? "in_progress" : "completed" })), theme);
	assert.ok(tail[0]!.includes("… +8 earlier · alt+d"));
	assert.ok(tail.some((l) => l.includes("task 13")));
});

test("renderCollapsedLine: falls back to next pending, then all-done; empty renders nothing", () => {
	const pendingOnly = renderCollapsedLine(
		[
			{ content: "a", status: "completed" },
			{ content: "b", status: "pending" },
		],
		theme,
		"alt+d",
	);
	assert.ok(pendingOnly[0]!.includes("<text>b</text>"));

	const allDone = renderCollapsedLine([{ content: "a", status: "completed" }], theme, "alt+d");
	assert.ok(allDone[0]!.includes("<dim>all done</dim>"));
	assert.ok(allDone[0]!.includes("<dim> · 1/1 done</dim>"));

	assert.deepEqual(renderCollapsedLine([], theme, "alt+d"), []);
});

test("renderTitleLine: static muted title + dim progress count — nothing dynamic", () => {
	assert.equal(renderTitleLine(list, theme), `<muted>${TITLE_ICON} Todos</muted><dim> · 1/3</dim>`);
	assert.equal(renderTitleLine([{ content: "a", status: "completed" }], theme), `<muted>${TITLE_ICON} Todos</muted><dim> · 1/1</dim>`);
});

test("summarizeTodos: plain text with progress count", () => {
	const text = summarizeTodos(list);
	assert.ok(text.includes("[x] Fix store layer"));
	assert.ok(text.includes("[~] Fix sandbox/typedefs"));
	assert.ok(text.includes("[ ] Fix mail"));
	assert.ok(text.endsWith("(1/3 completed)"));
	assert.equal(summarizeTodos([]), "Todo list is empty.");
});

test("validateTodos: rejects empty content and multiple in_progress", () => {
	assert.equal(validateTodos(list), null);
	assert.match(validateTodos([{ content: "  ", status: "pending" }]) ?? "", /non-empty/);
	assert.match(
		validateTodos([
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "in_progress" },
		]) ?? "",
		/one todo may be in_progress/,
	);
});

test("coerceTodos: accepts valid shapes, rejects garbage", () => {
	assert.deepEqual(coerceTodos([{ content: "a", status: "pending" }]), [{ content: "a", status: "pending" }]);
	assert.equal(coerceTodos("nope"), null);
	assert.equal(coerceTodos([{ content: "a", status: "later" }]), null);
	assert.equal(coerceTodos([{ content: 5, status: "pending" }]), null);
	// Structurally fine but invalid (two in_progress) is rejected too.
	assert.equal(
		coerceTodos([
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "in_progress" },
		]),
		null,
	);
});

test("extractLatestTodos: last todo_write call wins, bad shapes skipped", () => {
	const call = (todos: unknown) => ({
		role: "assistant",
		content: [{ type: "toolCall", id: "x", name: "todo_write", arguments: { todos } }],
	});
	const messages = [
		{ role: "user", content: "hi" },
		call([{ content: "old", status: "pending" }]),
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		call([{ content: "new", status: "completed" }]),
		call("garbage"), // ignored — earlier valid call is kept
	];
	assert.deepEqual(extractLatestTodos(messages, "todo_write"), [{ content: "new", status: "completed" }]);
	assert.deepEqual(extractLatestTodos([], "todo_write"), []);
});
