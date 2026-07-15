/**
 * Phase-6 TUI e2e for pi-teams: the pure render helpers (widget segments +
 * status text; picker rows, flat + archive). The interactive picker/viewer
 * overlays are wired in index.ts but need a live TUI, so only the pure builders
 * are exercised here.
 *
 * Run: node phase6-tui.mjs
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";

const widget = await jiti.import(join(EXT, "tui/widget.ts"));
const picker = await jiti.import(join(EXT, "tui/picker.ts"));
const tree = await jiti.import(join(EXT, "tui/tree-widget.ts"));

let passed = 0;
function test(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

console.log("widget:");
test("segments appear only when non-zero; hidden at zero agents", () => {
	assert.equal(widget.widgetStatusText({ agentCount: 0, running: 0, waiting: 0, unread: 0 }), undefined);
	assert.deepEqual(widget.widgetSegments({ agentCount: 3, running: 2, waiting: 0, unread: 0 }), ["2 running"]);
	const text = widget.widgetStatusText({ agentCount: 3, running: 2, waiting: 1, unread: 3 });
	assert.ok(text.includes("2 running"));
	assert.ok(text.includes("1 waiting"));
	assert.ok(text.includes("3"));
});
test("no budget segment (D21/D22)", () => {
	const text = widget.widgetStatusText({ agentCount: 1, running: 1, waiting: 0, unread: 0 });
	assert.ok(!text.toLowerCase().includes("budget"));
});

console.log("picker rows:");
const roster = [
	{ address: "refactorer/auth", type: "refactorer", id: "auth", state: "running", lifetime: "persistent", purview: "auth", vitals: { state: "running", ctxPercent: 0.6, tokens: 100, cost: 0, turns: 3 }, unread: 0, updatedAt: "" },
	{ address: "docs/main", type: "docs", id: "main", state: "dormant", lifetime: "persistent", purview: "main", vitals: { state: "dormant", ctxPercent: null, tokens: 0, cost: 0, turns: 0 }, unread: 0, updatedAt: "" },
];
test("flat rows sorted by address; no team headers (D12)", () => {
	const rows = picker.buildPickerRows(roster, [], { archiveExpanded: false, unread: () => 0 });
	assert.equal(rows.length, 2);
	assert.equal(rows[0].kind, "agent");
	assert.equal(rows[0].entry.address, "docs/main"); // sorted
	assert.equal(rows[1].entry.address, "refactorer/auth");
	assert.ok(rows.every((r) => r.kind !== "team-header"));
});
test("archive section collapses/expands", () => {
	const archived = [{ address: "oneshot/tmp-ab", retiredAt: "2026-07-14T00:00:00Z" }];
	const collapsed = picker.buildPickerRows(roster, archived, { archiveExpanded: false, unread: () => 0 });
	assert.ok(collapsed.some((r) => r.kind === "archive-header"));
	assert.ok(!collapsed.some((r) => r.kind === "archived"));
	const expanded = picker.buildPickerRows(roster, archived, { archiveExpanded: true, unread: () => 0 });
	assert.ok(expanded.some((r) => r.kind === "archived"));
});
test("row text shows state glyph, address, ctx%, unread badge", () => {
	const rows = picker.buildPickerRows(roster, [], { archiveExpanded: false, unread: (a) => (a === "refactorer/auth" ? 2 : 0) });
	const authRow = rows.find((r) => r.kind === "agent" && r.entry.address === "refactorer/auth");
	const text = picker.pickerRowText(authRow);
	assert.ok(text.includes("refactorer/auth"));
	assert.ok(text.includes("running"));
	assert.ok(text.includes("60%"));
	assert.ok(text.includes("2"));
});

console.log("tree widget (Phase 8):");
const plainTheme = { fg: (_c, t) => t };
test("empty when nothing is working", () => {
	assert.deepEqual(tree.renderTreeLines([], plainTheme), []);
});
test("renders a tree row + current tool per running agent", () => {
	const lines = tree.renderTreeLines(
		[
			{ address: "refactorer/auth", tool: "bash", summary: "Bash: find CLI files", toolUses: 10 },
			{ address: "docs/main", tool: "read", summary: "Read: src/index.ts", toolUses: 1 },
		],
		plainTheme,
	);
	assert.ok(lines[0].includes("Running 2 team agents"));
	assert.ok(lines.some((l) => l.includes("refactorer/auth") && l.includes("10 tool uses")));
	assert.ok(lines.some((l) => l.includes("Bash: find CLI files")));
	assert.ok(lines.some((l) => l.includes("docs/main") && l.includes("1 tool use") && !l.includes("1 tool uses")));
	assert.ok(lines.some((l) => l.includes("└─"))); // last-branch glyph
});

console.log(`\nPhase 6: ${passed} checks passed.`);
