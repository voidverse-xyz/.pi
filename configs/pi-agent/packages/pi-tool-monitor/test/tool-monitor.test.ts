import { visibleWidth } from "@earendil-works/pi-tui";

import { calculateListWindow, ToolMonitorComponent } from "../extensions/tool-monitor/index.ts";

function assertEqual<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
	}
}

function assertIncludes(lines: string[], expected: string, label: string): void {
	if (!lines.some((line) => line.includes(expected))) {
		throw new Error(`${label}: expected rendered output to include ${JSON.stringify(expected)}`);
	}
}

function testListWindow(): void {
	assertEqual(calculateListWindow(30, 0, 5, 0, true).scroll, 0, "first selection stays at top");
	assertEqual(calculateListWindow(30, 7, 5, 0, true).scroll, 3, "selection below viewport scrolls into view");
	assertEqual(calculateListWindow(30, 2, 5, 10, true).scroll, 2, "selection above viewport scrolls into view");
	assertEqual(calculateListWindow(30, 0, 5, 10, false).scroll, 10, "manual page scroll is preserved");
	assertEqual(calculateListWindow(30, 0, 5, 100, false).scroll, 25, "manual scroll clamps at final page");
	assertEqual(calculateListWindow(0, -1, 5, 10, false).scroll, 0, "empty list resets scroll");
}

function testBoundedOverlay(): void {
	const terminalRows = 12;
	const width = 100;
	const tui = {
		terminal: { rows: terminalRows },
		requestRender: () => {},
	};
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};
	const ctx = {
		abort: () => {},
		ui: { notify: () => {} },
	};
	const runs = new Map<string, unknown>();
	const order: string[] = [];

	for (let i = 0; i < 30; i++) {
		const id = `call-${i}`;
		order.push(id);
		runs.set(id, {
			id,
			name: `tool-${i}`,
			args: {},
			status: "done",
			startedAt: 0,
			endedAt: 100,
			partialResult: undefined,
			result: {},
		});
	}

	const component = new ToolMonitorComponent(tui as never, theme as never, () => {}, ctx as never, runs as never, order);
	try {
		const firstPage = component.render(width);
		assertEqual(firstPage.length, terminalRows - 2, "overlay height is bounded by its margins");
		assertIncludes(firstPage, "1/30 · rows 1-5/30", "initial page indicator");
		for (const line of firstPage) assertEqual(visibleWidth(line), width, "rendered row width");

		component.handleInput("\x1b[6~");
		const secondPage = component.render(width);
		assertEqual(secondPage.length, terminalRows - 2, "paged overlay height remains bounded");
		assertIncludes(secondPage, "6/30 · rows 6-10/30", "page-down selects the first visible call");

		component.handleInput("\r");
		assertIncludes(component.render(width), "Tool: tool-24", "enter opens the visible paged selection");
		component.handleInput("q");

		component.handleInput("G");
		const finalSelection = component.render(width);
		assertIncludes(finalSelection, "30/30 · rows 26-30/30", "end selection follows final page");
		assertIncludes(finalSelection, "> tool-0 [done]", "last call remains selectable after scrolling");

		tui.terminal.rows = 8;
		const shorterRows = component.render(width);
		assertEqual(shorterRows.length, 6, "terminal shrink recomputes the overlay height");
		assertIncludes(shorterRows, "30/30 · rows 30-30/30", "terminal shrink keeps the selection visible");

		tui.terminal.rows = 20;
		const tallerRows = component.render(width);
		assertEqual(tallerRows.length, 18, "terminal growth recomputes the overlay height");
		assertIncludes(tallerRows, "30/30 · rows 18-30/30", "terminal growth expands the visible window");

		tui.terminal.rows = terminalRows;
		for (const narrowWidth of [1, 2, 3]) {
			const narrowRows = component.render(narrowWidth);
			assertEqual(narrowRows.length, terminalRows - 2, `width ${narrowWidth} keeps the overlay height bounded`);
			for (const line of narrowRows) {
				assertEqual(visibleWidth(line) <= narrowWidth, true, `width ${narrowWidth} keeps rows horizontally bounded`);
			}
		}
	} finally {
		component.dispose();
	}
}

function testChildRowPaging(): void {
	const tui = {
		terminal: { rows: 12 },
		requestRender: () => {},
	};
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};
	let abortCount = 0;
	const ctx = {
		abort: () => {
			abortCount++;
		},
		ui: { notify: () => {} },
	};
	const messages: unknown[] = [];
	for (let i = 0; i < 12; i++) {
		const id = `inner-${i}`;
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id, name: `child-${i}`, arguments: {} }],
		});
		messages.push({ role: "toolResult", toolCallId: id, isError: false });
	}
	const runs = new Map<string, unknown>([
		[
			"delegate-call",
			{
				id: "delegate-call",
				name: "delegate",
				args: {},
				status: "running",
				startedAt: Date.now(),
				endedAt: null,
				partialResult: { details: { results: [{ agent: "worker", messages }] } },
				result: undefined,
			},
		],
	]);
	const component = new ToolMonitorComponent(
		tui as never,
		theme as never,
		() => {},
		ctx as never,
		runs as never,
		["delegate-call"],
	);

	try {
		assertIncludes(component.render(100), "1/1 · rows 1-5/13", "child rows contribute to list paging");
		component.handleInput("\x1b[6~");
		assertIncludes(component.render(100), "1/1 · rows 6-10/13", "child rows page without losing the parent mapping");
		component.handleInput("x");
		assertEqual(abortCount, 1, "abort on a child page targets its running parent");
		component.handleInput("\r");
		assertIncludes(component.render(100), "Tool: delegate", "enter on a child page opens its parent detail");
	} finally {
		component.dispose();
	}
}

export default function (): void {
	testListWindow();
	testBoundedOverlay();
	testChildRowPaging();
	console.log("pi-tool-monitor assertions passed");
}
