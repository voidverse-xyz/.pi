/**
 * Phase-6 TUI e2e for pi-teams: pure render helpers (picker rows, flat +
 * archive; tree widget lines) plus the tree controller's stable-mount contract.
 * The interactive picker/viewer overlays are wired in index.ts but need a live
 * TUI. The tree widget is the ONE ambient surface — there is no footer status
 * segment.
 *
 * Run: node phase6-tui.mjs
 */
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXT, WORLDS, jiti } from "./env.mjs";

const picker = await jiti.import(join(EXT, "tui/picker.ts"));
const textHelpers = await jiti.import(join(EXT, "text.ts"));
const tree = await jiti.import(join(EXT, "tui/tree-widget.ts"));

let passed = 0;
function test(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}
async function testAsync(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

console.log("picker rows:");
const roster = [
	{ address: "refactorer/auth", type: "refactorer", id: "auth", state: "running", lifetime: "persistent", purview: "auth", vitals: { state: "running", ctxPercent: 60, tokens: 100, cost: 0, turns: 3 }, unread: 0, updatedAt: "" },
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

console.log("tree widget:");
const plainTheme = { fg: (_c, t) => t };
test("empty when nothing is working and no main mail is unread", () => {
	assert.deepEqual(tree.renderTreeLines([], 0, plainTheme), []);
});
test("thinking summaries preserve prior clues and honor narrow budgets", () => {
	assert.equal(textHelpers.retainLatestThought("prior clue", " \n "), "prior clue");
	for (let max = 0; max <= 15; max++) {
		assert.ok(Array.from(textHelpers.liveThinkingSummary("abcdef", max)).length <= max);
	}
});
test("long thinking rows retain the newest clue and active suffix", () => {
	const summary = textHelpers.liveThinkingSummary(`${"older context ".repeat(20)}FINAL_MARKER`);
	const lines = tree.renderTreeLines(
		[{ address: "worker/thinking", tool: "", summary, toolUses: 0, ctxPercent: 1, tokens: 100, unread: 0 }],
		0,
		plainTheme,
		40,
	);
	const detail = lines.find((line) => line.endsWith(" · thinking…"));
	assert.ok(detail?.includes("FINAL_MARKER"), `newest thought should survive: ${lines.join(" | ")}`);
	assert.ok(Array.from(detail).length <= 40);
});
test("renders Nerd Font metric icons, short labels, and the current tool", () => {
	const lines = tree.renderTreeLines(
		[
			{ address: "refactorer/auth", tool: "bash", summary: "Bash: find CLI files", toolUses: 10, ctxPercent: 41.2, tokens: 23_000, unread: 0 },
			{ address: "docs/main", tool: "read", summary: "Read: src/index.ts", toolUses: 1, ctxPercent: null, tokens: 950, unread: 0 },
		],
		0,
		plainTheme,
	);
	assert.ok(lines[0].includes(`${tree.AGENTS_ICON} Running 2 team agents`));
	assert.equal(lines.at(-1), "", "visible widget ends with a blank spacer line");
	assert.ok(lines.some((l) => l.includes("refactorer/auth") && l.includes(`${tree.TOOL_ICON} 10 tools`) && l.includes(`${tree.CONTEXT_ICON} 41.2%`) && l.includes(`${tree.TOKEN_ICON} 23k tokens`)));
	assert.ok(lines.some((l) => l.includes("Bash: find CLI files")));
	assert.ok(lines.some((l) => l.includes("docs/main") && l.includes(`${tree.TOOL_ICON} 1 tool`) && !l.includes("1 tools") && l.includes(`${tree.CONTEXT_ICON} ?`) && l.includes(`${tree.TOKEN_ICON} 950 tokens`)));
	assert.ok(lines.some((l) => l.includes("└─"))); // last-branch glyph
});
test("main and per-agent unread mail use the mail icon", () => {
	const lines = tree.renderTreeLines(
		[{ address: "worker/main", tool: "bash", summary: "Bash: test", toolUses: 2, ctxPercent: 8, tokens: 1_250, unread: 2 }],
		3,
		plainTheme,
	);
	assert.ok(lines[0].includes(`${tree.MAIL_ICON} 3 main mail`));
	assert.ok(lines[1].includes(`${tree.MAIL_ICON} 2 mail`));
	const mailOnly = tree.renderTreeLines([], 1, plainTheme);
	assert.ok(mailOnly[0].includes(`${tree.AGENTS_ICON} Teams`));
	assert.ok(mailOnly[0].includes(`${tree.MAIL_ICON} 1 main mail`));
	assert.ok(!mailOnly[0].includes(`${tree.STOP_KEY} stop`), "mail-only header has no stop hint");
	assert.equal(mailOnly.at(-1), "", "mail-only widget also ends with spacing");
});
test("a display label renders next to the address in tree and picker rows", () => {
	const lines = tree.renderTreeLines(
		[{ address: "worker/tmp-3f9a", label: "lint sweep", tool: "bash", summary: "Bash: eslint", toolUses: 2, ctxPercent: 8, tokens: 1_250, unread: 0 }],
		0,
		plainTheme,
	);
	assert.ok(lines.some((l) => l.includes("worker/tmp-3f9a “lint sweep”")), `tree row shows the label: ${lines[1]}`);
	const entry = { address: "worker/tmp-3f9a", type: "worker", id: "tmp-3f9a", state: "running", lifetime: "oneshot", purview: "lint sweep", label: "lint sweep", vitals: { state: "running", ctxPercent: null, tokens: 0, cost: 0, turns: 1 }, unread: 0, updatedAt: "" };
	const text = picker.pickerRowText({ kind: "agent", entry, unread: 0 });
	assert.ok(text.includes("worker/tmp-3f9a “lint sweep”"), `picker row shows the label: ${text}`);
	const noLabel = picker.pickerRowText({ kind: "agent", entry: { ...entry, label: undefined }, unread: 0 });
	assert.ok(!noLabel.includes("“"), "no quotes when there is no label");
});
test("the stop hint is shown while agents run, and never when idle", () => {
	const lines = tree.renderTreeLines([{ address: "a/1", tool: "bash", summary: "Bash: x", toolUses: 1, ctxPercent: 1.5, tokens: 12, unread: 0 }], 0, plainTheme);
	// The brake must be discoverable exactly when it is usable.
	assert.ok(lines[0].includes(`${tree.STOP_KEY} stop`), `header should advertise the stop key, got: ${lines[0]}`);
	assert.deepEqual(tree.renderTreeLines([], 0, plainTheme), [], "no hint (and no widget) when nothing is working");
});
test("controller mounts once so refreshes cannot hop below the status row", () => {
	let rows = [];
	let mainUnread = 0;
	let listener = () => {};
	let renders = 0;
	const setCalls = [];
	const controller = tree.createTreeWidget(
		{
			activitySnapshot: () => rows,
			mainUnreadCount: () => mainUnread,
			onEvent: (fn) => ((listener = fn), () => {}),
		},
		{ setWidget: (key, content, options) => setCalls.push({ key, content, options }) },
	);
	assert.equal(setCalls.length, 1, "component occupies one stable widget-map slot at startup");
	const component = setCalls[0].content({ requestRender: () => renders++ }, plainTheme);
	assert.deepEqual(component.render(120), [], "mounted component is visually silent while idle");
	rows = [{ address: "worker/main", tool: "read", summary: "Read: file", toolUses: 1, ctxPercent: 5, tokens: 500, unread: 0 }];
	listener();
	const visible = component.render(120);
	assert.ok(visible[0].includes(`${tree.AGENTS_ICON} Running 1 team agent`));
	assert.equal(visible.at(-1), "", "visible component provides trailing spacing");
	mainUnread = 1;
	listener();
	assert.equal(setCalls.length, 1, "activity and mail refreshes never reinsert the widget");
	assert.ok(renders >= 2, "state changes request component rerenders");
	controller.dispose();
	assert.equal(setCalls.length, 2, "dispose removes the widget once");
	assert.equal(setCalls[1].content, undefined);
});
await testAsync("the advertised stop key is the one index.ts actually binds", async () => {
	// Guards the hint from drifting from the binding: both must come from STOP_KEY.
	const shortcuts = [];
	const stubPi = {
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: (key, opts) => shortcuts.push({ key, opts }),
		on: () => {},
		events: { emit: () => {}, on: () => {} },
		sendMessage: () => {},
	};
	const ext = await jiti.import(join(EXT, "index.ts"));
	(ext.default ?? ext)(stubPi);
	assert.ok(
		shortcuts.some((s) => s.key === tree.STOP_KEY),
		`index.ts must bind STOP_KEY (${tree.STOP_KEY}); bound: ${JSON.stringify(shortcuts.map((s) => s.key))}`,
	);
});

await testAsync("no footer status is ever published — the tree widget is the only ambient surface", async () => {
	// Boot index.ts's real session_start in TUI mode under a temp HOME. The old
	// footer segment was removed (redundant with the tree; auto-wake consumes the
	// unread/waiting signals) — nothing may call setStatus, so nothing can go stale.
	const scratch = join(WORLDS, "phase6-world");
	rmSync(scratch, { recursive: true, force: true });
	const home = join(scratch, "home");
	const project = join(scratch, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(project, { recursive: true });

	const handlers = new Map();
	const statusCalls = [];
	const stubPi = {
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event, handler) => handlers.set(event, handler),
		events: { emit: () => {}, on: () => {} },
		sendMessage: () => {},
	};
	const ext = await jiti.import(join(EXT, "index.ts"));
	(ext.default ?? ext)(stubPi);

	const ctx = {
		cwd: project,
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "p6-sess", getSessionFile: () => join(project, "s.jsonl") },
		ui: {
			notify: () => {},
			setStatus: (key, value) => statusCalls.push({ key, value }),
			setWidget: () => {},
			theme: { fg: (_c, s) => s },
		},
	};
	const realHome = process.env.HOME;
	process.env.HOME = home;
	try {
		await handlers.get("session_start")({ type: "session_start" }, ctx);
		await handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
		assert.deepEqual(statusCalls, [], "no setStatus calls across the whole lifecycle");
	} finally {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
	}
});

console.log(`\nPhase 6: ${passed} checks passed.`);
