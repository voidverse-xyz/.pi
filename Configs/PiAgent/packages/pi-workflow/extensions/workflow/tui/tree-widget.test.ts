import assert from "node:assert/strict";
import test from "node:test";
import type { RunSnapshot } from "../run.ts";
import { createTreeWidget, renderTreeLines, STOP_KEY } from "./tree-widget.ts";

const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
	runId: "20260716T000000_aaaaaa",
	name: "release-check",
	status: "running",
	currentPhase: "Test",
	phases: ["Build", "Test"],
	rows: [
		{ seq: 0, label: "build", phase: "Build", state: "cached", cached: true },
		{ seq: 1, label: "unit-tests", phase: "Test", state: "running", activity: { tool: "bash", summary: "Bash: npm test", toolUses: 4 } },
		{ seq: 2, label: "integ-tests", phase: "Test", state: "queued" },
	],
	logs: ["fanning out test shards"],
	...over,
});

test("header: name, phase, counts, stop hint with the bound key", () => {
	const [header] = renderTreeLines(snapshot(), theme);
	assert.ok(header!.includes("workflow release-check"));
	assert.ok(header!.includes("phase Test"));
	assert.ok(header!.includes("1 running 1 queued"));
	assert.ok(header!.includes(`${STOP_KEY} stop`));
});

test("rows: cached ✓, running ▶ with tool subline, queued ○, error ✗, logs tail", () => {
	const lines = renderTreeLines(
		snapshot({
			rows: [...snapshot().rows, { seq: 3, label: "boom", phase: "Test", state: "error", error: "model exploded" }],
		}),
		theme,
	);
	const text = lines.join("\n");
	assert.ok(text.includes("<success></success> build<dim> (cached)</dim>"));
	assert.ok(text.includes("<accent></accent> unit-tests"));
	assert.ok(text.includes("4 tool uses"));
	assert.ok(text.includes("└ Bash: npm test"));
	assert.ok(text.includes("<dim></dim> integ-tests"));
	assert.ok(text.includes("<error></error> boom"));
	assert.ok(text.includes("model exploded"));
	assert.ok(text.includes("log: fanning out test shards"));
});

test("multiline agent rows keep a stable height across state and activity changes", () => {
	const base = snapshot({ logs: [] });
	const initial = renderTreeLines(base, theme);
	const changed = renderTreeLines(
		snapshot({
			logs: [],
			rows: base.rows.map((row) => ({ ...row, state: "done", activity: undefined })),
		}),
		theme,
	);
	assert.equal(initial.length, changed.length);
	assert.equal(initial.length, 1 + base.rows.length * 2 + 1, "header + two lines per agent + bottom padding");
	assert.ok(initial.join("\n").includes("Waiting for a concurrency slot"));
	assert.ok(changed.join("\n").includes("Complete"));
});

test("active tree ends with one visually blank padding row", () => {
	assert.equal(renderTreeLines(snapshot(), theme).at(-1), "\u200B");
});

test("hidden when no run or run not running", () => {
	assert.deepEqual(renderTreeLines(null, theme), []);
	assert.deepEqual(renderTreeLines(snapshot({ status: "completed" }), theme), []);
});

test("controller avoids widget churn when only the run id changes", () => {
	let current = snapshot();
	const widgets: Array<string[] | undefined> = [];
	const ui = {
		theme,
		setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
	};
	const controller = createTreeWidget(() => current, ui);
	try {
		const widgetCalls = widgets.length;
		current = snapshot({ runId: "20260716T000001_bbbbbb" });
		controller.refresh();
		assert.equal(widgets.length, widgetCalls, "unchanged tree lines should not churn the widget");
	} finally {
		controller.dispose();
	}
});

test("controller clears the widget on completion and dispose", () => {
	let current: RunSnapshot | null = snapshot();
	const widgets: Array<string[] | undefined> = [];
	const ui = {
		theme,
		setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
	};
	const controller = createTreeWidget(() => current, ui);
	current = snapshot({ status: "completed" });
	controller.refresh();
	assert.equal(widgets.at(-1), undefined);
	current = null;
	controller.dispose();
	assert.equal(widgets.at(-1), undefined);
});
