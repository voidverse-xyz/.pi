import assert from "node:assert/strict";
import test from "node:test";
import type { RunSnapshot } from "../run.ts";
import { fitThinkingSummary, liveThinkingSummary } from "../text.ts";
import {
	BOTTOM_PADDING,
	CONTEXT_ICON,
	EXPAND_KEY,
	MAX_COLLAPSED_LINES,
	PROCEDURE_ICON,
	renderTreeLines,
	STOP_KEY,
	TOKEN_ICON,
	TOOL_ICON,
	treeNeedsExpansion,
} from "./tree-render.ts";

const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
	runId: "20260716T000000_aaaaaa",
	name: "release-check",
	status: "running",
	currentPhase: "Test",
	phases: ["Build", "Test"],
	rows: [
		{ seq: 0, label: "build", phase: "Build", state: "cached", cached: true },
		{
			seq: 1,
			label: "unit-tests",
			phase: "Test",
			state: "running",
			activity: { tool: "bash", summary: "Bash: npm test", toolUses: 4, tokens: 12_345, ctxPercent: 18.4 },
		},
		{ seq: 2, label: "integ-tests", phase: "Test", state: "queued" },
	],
	logs: ["fanning out test shards"],
	...over,
});

const longSnapshot = (): RunSnapshot =>
	snapshot({
		rows: [
			...snapshot().rows,
			{ seq: 3, label: "lint", phase: "Test", state: "running" },
			{ seq: 4, label: "package", phase: "Test", state: "queued" },
		],
		logs: ["fanning out test shards", "collecting reports"],
	});

test("header: procedure icon, name, phase, counts, stop hint with the bound key", () => {
	const [header] = renderTreeLines(snapshot(), theme);
	assert.equal(PROCEDURE_ICON, "\uF52E", "Nerd Fonts procedure-tree glyph");
	assert.ok(header!.includes(`${PROCEDURE_ICON} procedure release-check`));
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
		{ expanded: true },
	);
	const text = lines.join("\n");
	assert.ok(text.includes("<success></success> build<dim> (cached)</dim>"));
	assert.ok(text.includes("<accent></accent> unit-tests"));
	assert.ok(text.includes(`${TOOL_ICON} 4 tools`));
	assert.ok(text.includes(`${CONTEXT_ICON} 18%`));
	assert.ok(text.includes(`${TOKEN_ICON} 12k tokens`));
	assert.ok(text.includes("└ Bash: npm test"));
	assert.ok(text.includes("<dim></dim> integ-tests"));
	assert.ok(text.includes("<error></error> boom"));
	assert.ok(text.includes("model exploded"));
	assert.ok(text.includes("log: fanning out test shards"));
});

test("running rows show provider-visible thinking when no tool is active", () => {
	const lines = renderTreeLines(
		snapshot({
			rows: [
				{
					seq: 0,
					label: "reasoner",
					phase: "Test",
					state: "running",
					activity: {
						tool: "",
						summary: "tracing the newest dependency edge · thinking…",
						toolUses: 0,
						tokens: 0,
						ctxPercent: null,
					},
				},
			],
			logs: [],
		}),
		theme,
	);
	const text = lines.join("\n");
	assert.ok(text.includes("└ tracing the newest dependency edge · thinking…"));
	assert.equal(text.includes("tool use"), false);
});

test("long thinking rows retain the newest clue and active suffix within the detail width", () => {
	const plainTheme = { fg: (_color: string, text: string) => text };
	const summary = liveThinkingSummary(`${"older context ".repeat(20)}FINAL_MARKER`);
	const lines = renderTreeLines(
		snapshot({
			rows: [
				{
					seq: 0,
					label: "reasoner",
					phase: "Test",
					state: "running",
					activity: { tool: "", summary, toolUses: 0, tokens: 900, ctxPercent: 3.2 },
				},
			],
			logs: [],
		}),
		plainTheme,
		{ width: 40, fitDetail: (detail, max) => fitThinkingSummary(detail, max) },
	);
	const detail = lines.find((line) => line.endsWith(" · thinking…"));
	assert.ok(detail, `thinking detail should keep its suffix: ${lines.join(" | ")}`);
	assert.ok(detail.includes("FINAL_MARKER"), `newest thought should survive: ${lines.join(" | ")}`);
	assert.ok(Array.from(detail).length <= 40);
});

test("narrow rows protect compact metrics and account for the extra line in expansion", () => {
	const plainTheme = { fg: (_color: string, text: string) => text };
	const oneRow = snapshot({ rows: [snapshot().rows[1]!], logs: [] });
	const lines = renderTreeLines(oneRow, plainTheme, { width: 34 });
	assert.ok(lines.some((line) => line.includes(`${TOOL_ICON} 4 · ${CONTEXT_ICON} 18% · ${TOKEN_ICON} 12k`)));
	assert.ok(lines.some((line) => line.includes("Bash: npm test")));

	const threeActiveRows = snapshot({
		rows: Array.from({ length: 3 }, (_, seq) => ({
			...snapshot().rows[1]!,
			seq,
			label: `agent-${seq}`,
		})),
		logs: [],
	});
	assert.equal(treeNeedsExpansion(threeActiveRows), false, "wide rows stay two lines each");
	assert.equal(treeNeedsExpansion(threeActiveRows, 34), true, "narrow metric rows count toward the compact budget");
});

test("multiline agent rows keep a stable height across state and activity changes", () => {
	const base = snapshot({ logs: [] });
	const initial = renderTreeLines(base, theme);
	const changed = renderTreeLines(
		snapshot({
			logs: [],
			rows: base.rows.map((row) => {
				const changed = { ...row, state: "done" as const };
				delete changed.activity;
				return changed;
			}),
		}),
		theme,
	);
	assert.equal(initial.length, changed.length);
	assert.equal(initial.length, 1 + base.rows.length * 2 + 1, "header + two lines per agent + bottom padding");
	assert.ok(initial.join("\n").includes("Waiting for a concurrency slot"));
	assert.ok(changed.join("\n").includes("Complete"));
});

test("compact long trees keep whole agent blocks, expansion hint, and raw bottom padding", () => {
	const snap = longSnapshot();
	assert.equal(treeNeedsExpansion(snap), true);
	const lines = renderTreeLines(snap, theme);
	assert.ok(lines.length <= MAX_COLLAPSED_LINES);
	assert.equal(lines.at(-1), BOTTOM_PADDING, "visually blank padding row");
	assert.ok(lines[0]!.includes(`${EXPAND_KEY} expand`), "header advertises expansion before the tail");
	assert.ok(lines.at(-2)!.includes(`+6 lines · ${EXPAND_KEY} expand`));
	assert.ok(!lines.join("\n").includes("widget truncated"));
	assert.equal(lines.filter((line) => line.includes("lint")).length, 0, "an agent is not shown without its detail line");
});

test("expanded long trees show every row, a collapse hint, and bottom padding", () => {
	const lines = renderTreeLines(longSnapshot(), theme, { expanded: true });
	assert.ok(lines.length > MAX_COLLAPSED_LINES);
	assert.equal(lines.at(-1), BOTTOM_PADDING);
	assert.ok(lines[0]!.includes(`${EXPAND_KEY} collapse`));
	assert.ok(lines.join("\n").includes("lint"));
	assert.ok(lines.join("\n").includes("collecting reports"));
});

test("short, inactive, and completed trees do not need expansion", () => {
	assert.equal(treeNeedsExpansion(snapshot()), false);
	assert.equal(renderTreeLines(snapshot(), theme).at(-1), BOTTOM_PADDING);
	assert.equal(treeNeedsExpansion(null), false);
	assert.equal(treeNeedsExpansion(snapshot({ status: "completed" })), false);
	assert.deepEqual(renderTreeLines(null, theme), []);
	assert.deepEqual(renderTreeLines(snapshot({ status: "completed" }), theme), []);
});
