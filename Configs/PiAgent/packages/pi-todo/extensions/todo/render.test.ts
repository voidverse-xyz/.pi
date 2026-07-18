import assert from "node:assert/strict";
import test from "node:test";
import {
	activeTodoLabel,
	coerceTodos,
	estimateMessageTokens,
	exactOutputTokens,
	extractLatestTodoState,
	formatElapsed,
	formatTokenCount,
	HEADER_MARK,
	MARK_DONE,
	MARK_OPEN,
	renderCollapsedLine,
	renderHeaderLine,
	renderTodoWidgetLines,
	summarizeTodos,
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

test("renderCollapsedLine: in-progress item + done-count on one line", () => {
	const lines = renderCollapsedLine(list, theme);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.startsWith("<dim>└ </dim>"));
	assert.ok(lines[0]!.includes("Fixing sandbox/typedefs"));
	assert.ok(lines[0]!.includes("<dim> · 1/3 done</dim>"));
});

test("renderCollapsedLine: falls back to next pending, then all-done; empty renders nothing", () => {
	const pendingOnly = renderCollapsedLine(
		[
			{ content: "a", status: "completed" },
			{ content: "b", status: "pending" },
		],
		theme,
	);
	assert.ok(pendingOnly[0]!.includes("<text>b</text>"));

	const allDone = renderCollapsedLine([{ content: "a", status: "completed" }], theme);
	assert.ok(allDone[0]!.includes("<dim>all done</dim>"));
	assert.ok(allDone[0]!.includes("<dim> · 1/1 done</dim>"));

	assert.deepEqual(renderCollapsedLine([], theme), []);
});

test("formatElapsed: seconds, minutes, hours", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(29_000), "29s");
	assert.equal(formatElapsed((21 * 60 + 29) * 1_000), "21m 29s");
	assert.equal(formatElapsed((3_600 + 2 * 60 + 3) * 1_000), "1h 2m 3s");
	assert.equal(formatElapsed(-5_000), "0s");
});

test("formatTokenCount: raw under 1k, one-decimal k, one-decimal M", () => {
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(62_300), "62.3k");
	assert.equal(formatTokenCount(1_500), "1.5k");
	assert.equal(formatTokenCount(2_400_000), "2.4M");
});

test("activeTodoLabel: activeForm of the in-progress item, content fallback, undefined when none", () => {
	assert.equal(activeTodoLabel(list), "Fixing sandbox/typedefs");
	assert.equal(activeTodoLabel([{ content: "Build core", status: "in_progress" }]), "Build core");
	assert.equal(activeTodoLabel([{ content: "a", status: "pending" }]), undefined);
	assert.equal(activeTodoLabel([]), undefined);
});

test("renderHeaderLine: ✻ label… (elapsed · ↓ tokens), token segment only when > 0", () => {
	const withTokens = renderHeaderLine("Building pure core modules", (21 * 60 + 29) * 1_000, 62_300, theme);
	assert.equal(
		withTokens,
		`<accent>${HEADER_MARK}</accent> <text>Building pure core modules…</text> <dim>(21m 29s · ↓ 62.3k tokens)</dim>`,
	);

	const noTokens = renderHeaderLine("Working", 5_000, 0, theme);
	assert.equal(noTokens, `<accent>${HEADER_MARK}</accent> <text>Working…</text> <dim>(5s)</dim>`);
});

test("exactOutputTokens / estimateMessageTokens", () => {
	assert.equal(exactOutputTokens({ usage: { output: 42 } }), 42);
	assert.equal(exactOutputTokens({ usage: { output: 0 } }), undefined);
	assert.equal(exactOutputTokens({}), undefined);

	assert.equal(estimateMessageTokens({ content: [{ type: "text", text: "abcdefgh" }] }), 2);
	assert.equal(
		estimateMessageTokens({
			content: [
				{ type: "thinking", thinking: "abcd" },
				{ type: "toolCall", arguments: { a: 1 } },
			],
		}),
		Math.ceil((4 + JSON.stringify({ a: 1 }).length) / 4),
	);
	assert.equal(estimateMessageTokens({ content: "not-an-array" }), 0);
});

test("summarizeTodos: plain text with progress count", () => {
	const text = summarizeTodos(list);
	assert.ok(text.includes(`[${MARK_DONE}] Fix store layer`));
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

test("extractLatestTodoState: last todo_write call wins, bad shapes skipped, header captured", () => {
	const call = (todos: unknown, header?: unknown) => ({
		role: "assistant",
		content: [{ type: "toolCall", id: "x", name: "todo_write", arguments: { todos, header } }],
	});
	const messages = [
		{ role: "user", content: "hi" },
		call([{ content: "old", status: "pending" }], "Old phase"),
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		call([{ content: "new", status: "completed" }], "Building pure core modules"),
		call("garbage", "ignored"), // ignored — earlier valid call is kept
	];
	assert.deepEqual(extractLatestTodoState(messages, "todo_write"), {
		todos: [{ content: "new", status: "completed" }],
		header: "Building pure core modules",
	});
	// header omitted or blank -> absent, so the live fallback (activeForm) applies
	assert.deepEqual(extractLatestTodoState([call([{ content: "a", status: "pending" }], "  ")], "todo_write"), {
		todos: [{ content: "a", status: "pending" }],
	});
	assert.deepEqual(extractLatestTodoState([], "todo_write"), { todos: [] });
});
