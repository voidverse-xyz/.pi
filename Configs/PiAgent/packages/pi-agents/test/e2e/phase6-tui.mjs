/**
 * Phase-6 TUI smoke test for pi-agents (component-level harness).
 *
 * Drives the four tui/ modules with fake core state and asserts rendered
 * lines and input handling:
 *  (w) widget: segment hiding (zero agents / zero segments), budget segment
 *      only >50% consumed, paused-banner SGR band correctness (ONE bg+fg
 *      pair, plain interior, single trailing reset — no nested resets).
 *  (p) picker: team-grouped ordering, state glyphs, unread badge, collapsed/
 *      expanded .archive section; keys ↑↓/Enter/x/X-confirm/Esc.
 *  (v) viewer: header-strip format, wake-digest → compact 📨 entries
 *      (round-trip through the REAL composeWakeDigest), mail-tool calls →
 *      outbound 📨 entries, incremental tail reader, Enter=sendAsUser
 *      (Editor onSubmit quirk), alt+Enter=steer, x=interrupt, Esc/alt+j.
 *  (m) escalation modal: spec lines, a/d/D-with-note/v/Esc key handling.
 *
 * The digest-embedded wake trigger (carried-forward fix) is asserted
 * end-to-end in smoke-phase3.mjs (updated expectations).
 *
 * Run: node smoke-phase6.mjs
 */
import { strict as assert } from "node:assert";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";



const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const { visibleWidth } = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-tui/dist/index.js"));
piSdk.initTheme(); // Pi transcript components read the global theme
const themeModule = await jiti.import(join(PI_PKG, "dist/modes/interactive/theme/theme.js"));
const realTheme = themeModule.theme;
const widget = await jiti.import(join(EXT, "tui/widget.ts"));
const picker = await jiti.import(join(EXT, "tui/picker.ts"));
const viewer = await jiti.import(join(EXT, "tui/viewer.ts"));
const modal = await jiti.import(join(EXT, "tui/escalation-modal.ts"));
const { composeWakeDigest } = await jiti.import(join(EXT, "mail/digest.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));

const scratch = join(WORLDS, "phase6-world");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

let passed = 0;
let failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed++;
		console.log(`  ✗ ${name}`);
		console.log(`    ${error.stack?.split("\n").slice(0, 6).join("\n    ")}`);
	}
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Fake theme: distinguishable fg wraps + raw bg/fg SGR accessors for bands.
const FG = "\x1b[38;2;220;220;40m";
const BG = "\x1b[48;2;60;0;0m";
const fakeTheme = {
	fg: (_color, text) => `\x1b[38;5;245m${text}\x1b[39m`,
	getFgAnsi: () => FG,
	getBgAnsi: () => BG,
};
const plainTheme = { ...fakeTheme, fg: (_c, t) => t };
const fakeTui = { requestRender() {}, terminal: { rows: 30, columns: 100 } };

// ---------------------------------------------------------------------------
// (w) widget
// ---------------------------------------------------------------------------
console.log("(w) widget:");
const snap = (over = {}) => ({ ...widget.emptySnapshot(), ...over });

await test("zero agents → widget hidden entirely", () => {
	assert.deepEqual(widget.renderWidgetLines(snap({ running: 3, unread: 2 }), fakeTheme, 80), []);
});
await test("segments render only when non-zero", () => {
	const lines = widget.renderWidgetLines(
		snap({ agentCount: 3, running: 2, waiting: 1, unread: 3, turnsUsed: 5, turnsBudget: 40, tokensBudget: 500000 }),
		plainTheme,
		80,
	);
	assert.equal(lines.length, 1);
	assert.equal(lines[0], "⚒ 2 running · 1 waiting · 📬 3");
});
await test("zero-valued segments are dropped", () => {
	const lines = widget.renderWidgetLines(
		snap({ agentCount: 2, running: 1, turnsBudget: 40, tokensBudget: 500000 }),
		plainTheme,
		80,
	);
	assert.equal(lines[0], "⚒ 1 running");
	const hidden = widget.renderWidgetLines(snap({ agentCount: 2, turnsBudget: 40, tokensBudget: 500000 }), plainTheme, 80);
	assert.deepEqual(hidden, [], "all-zero segments → nothing to say → hidden");
});
await test("budget segment only once >50% consumed (turns axis)", () => {
	const base = { agentCount: 1, running: 1, turnsBudget: 40, tokensBudget: 500000 };
	assert.equal(widget.budgetSegmentText(snap({ ...base, turnsUsed: 12 })), null, "30% → hidden");
	assert.equal(widget.budgetSegmentText(snap({ ...base, turnsUsed: 21 })), "⏸ budget 21/40");
	const line = widget.renderWidgetLines(snap({ ...base, turnsUsed: 21 }), plainTheme, 80)[0];
	assert.equal(line, "⚒ 1 running · ⏸ budget 21/40");
});
await test("budget segment shows the closer axis (tokens)", () => {
	const text = widget.budgetSegmentText(
		snap({ agentCount: 1, turnsUsed: 5, turnsBudget: 40, tokensUsed: 300000, tokensBudget: 500000 }),
	);
	assert.equal(text, "⏸ budget 300k/500k");
});
await test("paused banner: one bg+fg band, plain interior, single trailing reset", () => {
	const lines = widget.renderWidgetLines(
		snap({ agentCount: 2, paused: true, trippedBy: "turns", turnsUsed: 40, turnsBudget: 40, queuedMail: 5, unread: 2 }),
		fakeTheme,
		100,
	);
	assert.equal(lines.length, 1);
	const banner = lines[0];
	assert.ok(banner.startsWith(BG + FG), "band opens with ONE bg+fg pair");
	assert.ok(banner.endsWith("\x1b[0m"), "band ends with the reset");
	const interior = banner.slice((BG + FG).length, -"\x1b[0m".length);
	assert.ok(!interior.includes("\x1b"), "NO nested SGR inside the band (the hard-won constraint)");
	assert.match(interior, /⏸ subagents paused/);
	assert.match(interior, /turns 40\/40/);
	assert.match(interior, /📬 7 queued/);
});
await test("paused banner: tokens trip variant", () => {
	const lines = widget.renderWidgetLines(
		snap({ agentCount: 1, paused: true, trippedBy: "tokens", tokensUsed: 512000, tokensBudget: 500000 }),
		fakeTheme,
		200,
	);
	assert.match(strip(lines[0]), /tokens 512k\/500k/);
});
await test("paused banner fits the terminal exactly at 40/80/120 (host-crash guard)", () => {
	// pi-tui's non-overlay render path THROWS on any line wider than the
	// terminal ("Rendered line N exceeds terminal width") and stops the whole
	// host session — the banner must clip, and clipping must not break the
	// single bg+fg band (no nested SGR inside).
	const pausedSnap = snap({
		agentCount: 2,
		paused: true,
		trippedBy: "turns",
		turnsUsed: 40,
		turnsBudget: 40,
		queuedMail: 5,
		unread: 2,
	});
	for (const width of [40, 80, 120]) {
		const lines = widget.renderWidgetLines(pausedSnap, fakeTheme, width);
		assert.equal(lines.length, 1);
		const banner = lines[0];
		assert.equal(visibleWidth(banner), width, `banner is exactly ${width} cols wide`);
		assert.ok(banner.startsWith(BG + FG), "band still opens with ONE bg+fg pair");
		assert.ok(banner.endsWith("\x1b[0m"), "band still ends with the reset");
		const interior = banner.slice((BG + FG).length, -"\x1b[0m".length);
		assert.ok(!interior.includes("\x1b"), "truncation left NO SGR inside the band");
	}
});
await test("busy segment line never exceeds a narrow terminal", () => {
	const busy = snap({ agentCount: 9, running: 5, waiting: 3, unread: 12, turnsUsed: 30, turnsBudget: 40 });
	for (const width of [40, 80]) {
		const lines = widget.renderWidgetLines(busy, fakeTheme, width);
		assert.equal(lines.length, 1);
		assert.ok(
			visibleWidth(lines[0]) <= width,
			`segment line ${visibleWidth(lines[0])} cols must fit ${width}`,
		);
	}
});

// ---------------------------------------------------------------------------
// (p) picker
// ---------------------------------------------------------------------------
console.log("(p) picker:");
const vitals = (ctx = 0) => ({ contextPercent: ctx, tokens: 0, cost: 0, turns: 0, compactions: 0 });
const roster = [
	{ address: "refactorer/auth", type: "refactorer", id: "auth", state: "running", lifetime: "persistent", purview: "auth", teams: ["billing"], vitals: vitals(61), updatedAt: "" },
	{ address: "refactorer/api", type: "refactorer", id: "api", state: "queued", lifetime: "persistent", purview: "api", teams: ["billing"], vitals: vitals(10), updatedAt: "" },
	{ address: "docs-keeper/main", type: "docs-keeper", id: "main", state: "dormant", lifetime: "persistent", purview: "docs", teams: [], vitals: vitals(5), updatedAt: "" },
	{ address: "tester/main", type: "tester", id: "main", state: "waiting", lifetime: "persistent", purview: "tests", teams: [], vitals: vitals(30), updatedAt: "" },
];
const archivedList = [
	{ address: "oneshot/tmp-abc", type: "oneshot", id: "tmp-abc", archiveDir: "/x", retiredAt: "2026-07-08T10:00:00.000Z", sessionFile: null },
];
const unread = (address) => (address === "refactorer/auth" ? 2 : 0);

await test("rows grouped by team then (solo); collapsed .archive at the bottom", () => {
	const rows = picker.buildPickerRows(roster, archivedList, { archiveExpanded: false, unread });
	const texts = rows.map(picker.pickerRowText);
	assert.deepEqual(texts, [
		"billing",
		"  ◐ refactorer/api  ·  queued  ·  ctx 10%",
		"  ● refactorer/auth  ·  running  ·  ctx 61%  ·  📬 2",
		"(solo)",
		"  ○ docs-keeper/main  ·  dormant  ·  ctx 5%",
		"  ⚠ tester/main  ·  waiting  ·  ctx 30%",
		"▸ .archive (1)",
	]);
});
await test("expanded archive lists retired agents", () => {
	const rows = picker.buildPickerRows(roster, archivedList, { archiveExpanded: true, unread });
	const texts = rows.map(picker.pickerRowText);
	assert.equal(texts[texts.length - 2], "▾ .archive (1)");
	assert.equal(texts[texts.length - 1], "  ✝ oneshot/tmp-abc · retired 2026-07-08");
});
await test("state glyphs match the spec (● ◐ ○ ⚠)", () => {
	assert.deepEqual(picker.STATE_GLYPHS, { running: "●", queued: "◐", dormant: "○", waiting: "⚠" });
});

function fakePickerCore(calls) {
	return {
		status: async () => roster,
		archived: () => archivedList,
		agentUnreadCount: unread,
		runtime: { onEvent: () => () => {} },
		interrupt: async (address) => (calls.push(["interrupt", address]), { interrupted: true }),
		retire: async (address) => (calls.push(["retire", address]), { retired: true, archiveDir: null }),
	};
}

await test("picker keys: ↓↓ Enter → view second agent", async () => {
	const calls = [];
	let result;
	const component = picker.createPicker({
		core: fakePickerCore(calls),
		tui: fakeTui,
		theme: plainTheme,
		onDone: (r) => (result = r),
	});
	await tick();
	// selection starts on the first selectable row (refactorer/api)
	component.handleInput("\x1b[B"); // ↓ → refactorer/auth
	component.handleInput("\r");
	assert.deepEqual(result, { action: "view", address: "refactorer/auth" });
});
await test("picker: Enter on ▸ .archive expands; Enter on archived row → view-archived", async () => {
	const calls = [];
	let result;
	const component = picker.createPicker({
		core: fakePickerCore(calls),
		tui: fakeTui,
		theme: plainTheme,
		onDone: (r) => (result = r),
	});
	await tick();
	for (let i = 0; i < 10; i++) component.handleInput("\x1b[B"); // bottom = archive header
	component.handleInput("\r"); // expand
	assert.equal(result, undefined, "expanding does not close");
	component.handleInput("\x1b[B"); // onto the archived row
	component.handleInput("\r");
	assert.equal(result.action, "view-archived");
	assert.equal(result.archived.address, "oneshot/tmp-abc");
});
await test("picker: x interrupts; X asks y/N and only y retires", async () => {
	const calls = [];
	let result;
	const component = picker.createPicker({
		core: fakePickerCore(calls),
		tui: fakeTui,
		theme: plainTheme,
		onDone: (r) => (result = r),
	});
	await tick();
	component.handleInput("x");
	await tick();
	assert.deepEqual(calls[0], ["interrupt", "refactorer/api"]);
	component.handleInput("X");
	component.handleInput("n"); // declined
	await tick();
	assert.equal(calls.length, 1, "n does not retire");
	component.handleInput("X");
	component.handleInput("y");
	await tick();
	assert.deepEqual(calls[1], ["retire", "refactorer/api"]);
	component.handleInput("\x1b");
	assert.deepEqual(result, { action: "closed" });
});
await test("picker: scroll clamps when rows shrink (retire/GC while scrolled down)", async () => {
	const many = Array.from({ length: 12 }, (_, i) => ({
		address: `worker/a${String(i).padStart(2, "0")}`,
		type: "worker",
		id: `a${String(i).padStart(2, "0")}`,
		state: "dormant",
		lifetime: "persistent",
		purview: "x",
		teams: [],
		vitals: vitals(1),
		updatedAt: "",
	}));
	let entries = many;
	let fire = () => {};
	const core = {
		status: async () => entries,
		archived: () => [],
		agentUnreadCount: () => 0,
		runtime: { onEvent: (cb) => ((fire = cb), () => {}) },
	};
	const component = picker.createPicker({ core, tui: fakeTui, theme: plainTheme, onDone: () => {}, maxBody: 5 });
	await tick();
	for (let i = 0; i < 20; i++) component.handleInput("\x1b[B"); // scroll to the bottom
	// Most rows disappear (retire/GC) and a runtime event triggers a reload.
	entries = many.slice(0, 2);
	fire({ type: "state-changed", address: "worker/a00", state: "dormant" });
	await tick();
	await tick();
	const lines = component.render(80).map(strip);
	const body = lines.slice(1); // after the " Subagents" title
	assert.ok(
		body.some((line) => line.includes("worker/a00")),
		`list body must show rows after the shrink (stale scroll → blank list). got: ${JSON.stringify(lines)}`,
	);
	component.dispose();
});
await test("picker render: selected marker + hint line", async () => {
	const calls = [];
	const component = picker.createPicker({
		core: fakePickerCore(calls),
		tui: fakeTui,
		theme: plainTheme,
		onDone: () => {},
	});
	await tick();
	const lines = component.render(90).map(strip);
	assert.ok(lines.some((line) => line.startsWith("❯   ◐ refactorer/api")), "selected row marked");
	assert.match(lines[lines.length - 1], /enter view · x interrupt · X retire/);
	component.dispose();
});
// The picker now renders into a FULL-SCREEN overlay (index.ts openPicker uses
// the same overlayOptions as the working viewer: anchor top-left, 100%×100%,
// margin 0). Verify it reads well full-width and never emits a line wider than
// the terminal (pi-tui's overlay path is forgiving, but the discipline the
// widget needs applies here too — and a leading blank line lifts it off the
// top edge, matching the sibling overlays).
await test("picker render: full-screen sanity at 80/120 (leading blank, title, hint, width-safe)", async () => {
	const component = picker.createPicker({
		core: fakePickerCore([]),
		tui: fakeTui,
		theme: plainTheme,
		onDone: () => {},
	});
	await tick();
	for (const width of [80, 120]) {
		const raw = component.render(width);
		const lines = raw.map(strip);
		assert.equal(lines[0], "", "leading blank line for full-screen breathing room");
		assert.ok(lines.some((line) => line.includes("Subagents")), "title present");
		assert.ok(lines.some((line) => line.includes("refactorer/api")), "roster rows present");
		assert.match(lines[lines.length - 1], /↑↓ move · enter view · x interrupt · X retire · esc/);
		for (const line of raw) {
			assert.ok(visibleWidth(line) <= width, `no line exceeds ${width} cols (got ${visibleWidth(line)})`);
		}
	}
	component.dispose();
});
await test("picker render: empty roster shows the (no agents) empty state full-screen", async () => {
	const core = {
		status: async () => [],
		archived: () => [],
		agentUnreadCount: () => 0,
		runtime: { onEvent: () => () => {} },
	};
	const component = picker.createPicker({ core, tui: fakeTui, theme: plainTheme, onDone: () => {} });
	await tick();
	for (const width of [80, 120]) {
		const lines = component.render(width).map(strip);
		assert.equal(lines[0], "", "leading blank line");
		assert.ok(lines.some((line) => line.includes("Subagents")), "title still shown when empty");
		assert.ok(lines.some((line) => /no agents/.test(line)), "empty-state hint");
	}
	component.dispose();
});

// ---------------------------------------------------------------------------
// (v) viewer
// ---------------------------------------------------------------------------
console.log("(v) viewer:");

await test("header strip format matches the spec example (team slot, D12)", () => {
	// 05 §3's `billing-refactor` is the agent's TEAM, not its purview.
	const text = viewer.headerStripText({
		address: "refactorer/auth",
		team: "billing-refactor",
		state: "running",
		contextPercent: 61,
		tokens: 142000,
		cost: 0.84,
		turns: 9,
	});
	assert.equal(text, "refactorer/auth · billing-refactor · running · ctx 61% · 142k · $0.84 · ↻9");
});
await test("header strip omits the team slot for solo agents", () => {
	const text = viewer.headerStripText({
		address: "worker/main",
		team: "",
		state: "running",
		contextPercent: 42,
		tokens: 4200,
		cost: 0.12,
		turns: 3,
	});
	assert.equal(text, "worker/main · running · ctx 42% · 4k · $0.12 · ↻3");
});
await test("wake digest round-trips to compact inbound 📨 entries", () => {
	const q = makeEnvelope({ from: "refactorer/api", to: "refactorer/auth", type: "question", text: "Which endpoint?" });
	const r = makeEnvelope({ from: "main", to: "refactorer/auth", type: "message", text: "carry on\nsecond line" });
	const digest = composeWakeDigest({
		items: [
			{ envelope: q, redelivered: false },
			{ envelope: r, redelivered: false },
		],
		questionLookup: () => undefined,
	});
	assert.ok(viewer.isWakeDigestText(digest));
	const entries = viewer.parseDigestEntries(digest);
	assert.equal(entries.length, 2);
	const question = entries.find((e) => e.type === "question");
	assert.deepEqual(question, { direction: "in", peer: "refactorer/api", type: "question", preview: "Which endpoint?" });
	assert.equal(viewer.envelopeEntryText(question), '📨 ← refactorer/api: question "Which endpoint?"');
	const message = entries.find((e) => e.type === "message");
	assert.equal(message.preview, "carry on", "preview is the first line only");
});
await test("answer envelopes parse from the answers section", () => {
	const q = makeEnvelope({ from: "refactorer/auth", to: "refactorer/api", type: "question", text: "Format?" });
	const a = makeEnvelope({ from: "refactorer/api", to: "refactorer/auth", type: "answer", text: "RFC7807", correlationId: q.id });
	const digest = composeWakeDigest({
		items: [{ envelope: a, redelivered: false }],
		questionLookup: () => "Format?",
	});
	const entries = viewer.parseDigestEntries(digest);
	assert.deepEqual(entries, [{ direction: "in", peer: "refactorer/api", type: "answer", preview: "RFC7807" }]);
});
await test("mail-tool calls become outbound 📨 entries", () => {
	const send = viewer.envelopeEntryForToolCall("send_message", { to: "refactorer/api", type: "question", text: "hi\nthere" });
	assert.equal(viewer.envelopeEntryText(send), '📨 → refactorer/api: question "hi"');
	const ask = viewer.envelopeEntryForToolCall("ask", { text: "which branch?" });
	assert.equal(viewer.envelopeEntryText(ask), '📨 → main: question "which branch?"');
	const report = viewer.envelopeEntryForToolCall("report", { text: "done" });
	assert.equal(report.type, "report");
	assert.equal(viewer.envelopeEntryForToolCall("bash", { command: "ls" }), null);
});
await test("tail reader: appends deliver only complete new lines", () => {
	const file = join(scratch, "tail.jsonl");
	writeFileSync(file, `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n`);
	const reader = viewer.createTailReader(file);
	assert.equal(reader.poll().length, 2);
	assert.equal(reader.poll().length, 0, "no re-reads");
	appendFileSync(file, `${JSON.stringify({ a: 3 })}\n{"partial":`);
	const third = reader.poll();
	assert.equal(third.length, 1, "torn trailing line held back");
	assert.equal(third[0].a, 3);
	appendFileSync(file, `1}\n`);
	assert.deepEqual(reader.poll(), [{ partial: 1 }], "completed line delivered once whole");
});

function makeSessionFixture() {
	const q = makeEnvelope({ from: "main", to: "worker/main", type: "question", text: "Need the answer" });
	const digest = composeWakeDigest({ items: [{ envelope: q, redelivered: false }], questionLookup: () => undefined });
	const file = join(scratch, "session.jsonl");
	const now = Date.now();
	const entries = [
		{ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: "/tmp" },
		{ type: "message", id: "1", parentId: null, timestamp: "", message: { role: "user", content: digest, timestamp: now } },
		{
			type: "message",
			id: "2",
			parentId: "1",
			timestamp: "",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "On it — replying now." },
					{ type: "toolCall", id: "t1", name: "report", arguments: { text: "progress 50%" } },
					{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "echo hello" } },
				],
				api: "anthropic-messages",
				provider: "mock",
				model: "mock-1",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				stopReason: "toolUse",
				timestamp: now,
			},
		},
		{
			type: "message",
			id: "3",
			parentId: "2",
			timestamp: "",
			message: { role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "hello" }], isError: false, timestamp: now },
		},
	];
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}

function fakeViewerCore(file, log, teams = ["billing-refactor"]) {
	return {
		layout: { cwd: "/tmp" },
		peek: async () => ({
			address: "worker/main",
			type: "worker",
			id: "main",
			state: "running",
			lifetime: "persistent",
			// Production shape: purview equals the id (runtime sets purview: id
			// and never updates it) — the header must show TEAMS, never this.
			purview: "main",
			teams,
			vitals: { contextPercent: 42, tokens: 4200, cost: 0.12, turns: 3, compactions: 0 },
			updatedAt: "",
			typeFileHash: "x",
			createdAt: "",
			sessionFile: file,
			tail: [],
		}),
		runtime: { onEvent: () => () => {} },
		sendAsUser: async (options) => (log.push(["sendAsUser", options.to, options.text]), { delivery: "queued", recipientState: "running", envelopeId: "msg_x" }),
		steer: async (to, text) => (log.push(["steer", to, text]), { steered: true }),
		interrupt: async (to) => (log.push(["interrupt", to]), { interrupted: true }),
	};
}

await test("viewer renders header, Pi transcript, and compact envelope entries", async () => {
	const file = makeSessionFixture();
	const log = [];
	const component = viewer.createViewer({
		core: fakeViewerCore(file, log),
		tui: fakeTui,
		theme: realTheme, // real Theme: Pi components style through it
		address: "worker/main",
		onDone: () => {},
	});
	await tick();
	await tick();
	const text = component.render(100).map(strip).join("\n");
	// The header's second slot is the TEAM off the real AgentDetail.teams
	// field (D12) — with purview at its production value (= id), a purview
	// leak would render `worker/main · running` with no team, failing this.
	assert.match(text, /worker\/main · billing-refactor · running · ctx 42% · 4k · \$0\.12 · ↻3/);
	assert.match(text, /📨 ← main: question "Need the answer"/, "inbound digest collapsed to a compact entry");
	assert.match(text, /📨 → main: report "progress 50%"/, "mail tool call is an envelope entry, not a tool box");
	assert.match(text, /On it — replying now\./, "assistant text through Pi's own component");
	assert.match(text, /echo hello/, "non-mail tool call rendered as a tool execution");
	assert.match(text, /enter mail · alt\+enter steer/, "superuser input hints");
	component.dispose();
});
await test("viewer header: solo agent (no teams) omits the slot — purview never leaks in", async () => {
	const file = makeSessionFixture();
	const component = viewer.createViewer({
		core: fakeViewerCore(file, [], []), // teams: [] — solo
		tui: fakeTui,
		theme: realTheme,
		address: "worker/main",
		onDone: () => {},
	});
	await tick();
	await tick();
	const header = strip(component.render(100)[0]);
	assert.match(header, /worker\/main · running · ctx 42%/, "team slot omitted for solo agents");
	component.dispose();
});
await test("viewer input: Enter mails via sendAsUser (Editor onSubmit quirk respected)", async () => {
	const file = makeSessionFixture();
	const log = [];
	const component = viewer.createViewer({
		core: fakeViewerCore(file, log),
		tui: fakeTui,
		theme: realTheme,
		address: "worker/main",
		onDone: () => {},
	});
	await tick();
	for (const ch of "do the thing") component.handleInput(ch);
	component.handleInput("\r");
	await tick();
	assert.deepEqual(log[0], ["sendAsUser", "worker/main", "do the thing"]);
	component.dispose();
});
await test("viewer input: alt+Enter steers; x (empty editor) interrupts; Esc/alt+j exit", async () => {
	const file = makeSessionFixture();
	const log = [];
	let result;
	const component = viewer.createViewer({
		core: fakeViewerCore(file, log),
		tui: fakeTui,
		theme: realTheme,
		address: "worker/main",
		onDone: (r) => (result = r),
	});
	await tick();
	for (const ch of "go left") component.handleInput(ch);
	component.handleInput("\x1b\r"); // alt+enter
	await tick();
	assert.deepEqual(log[0], ["steer", "worker/main", "go left"]);
	component.handleInput("x"); // editor now empty → interrupt
	await tick();
	assert.deepEqual(log[1], ["interrupt", "worker/main"]);
	component.handleInput("\x1bj"); // alt+j
	assert.deepEqual(result, { action: "next" });
	// fresh viewer: Esc → back
	let result2;
	const component2 = viewer.createViewer({
		core: fakeViewerCore(file, log),
		tui: fakeTui,
		theme: realTheme,
		address: "worker/main",
		onDone: (r) => (result2 = r),
	});
	await tick();
	component2.handleInput("\x1b");
	assert.deepEqual(result2, { action: "back" });
});
await test("viewer polls peek with tail 0 (vitals only) — transcript comes from its own tail reader", async () => {
	const file = makeSessionFixture();
	const peekTails = [];
	const base = fakeViewerCore(file, []);
	const core = {
		...base,
		peek: async (address, tail) => {
			peekTails.push(tail);
			return base.peek(address, tail);
		},
	};
	const component = viewer.createViewer({
		core,
		tui: fakeTui,
		theme: realTheme,
		address: "worker/main",
		onDone: () => {},
	});
	await tick();
	await tick();
	assert.ok(peekTails.length > 0, "viewer polled peek");
	assert.ok(peekTails.every((tail) => tail === 0), `every poll asks for tail 0, got ${JSON.stringify(peekTails)}`);
	// With tail:0 peek carrying NO transcript, the header AND the transcript
	// must still render — the transcript via the incremental TailReader.
	const text = component.render(100).map(strip).join("\n");
	assert.match(text, /worker\/main · billing-refactor · running · ctx 42%/, "header strip intact");
	assert.match(text, /On it — replying now\./, "live transcript intact (own tail reader, not peek's tail)");
	component.dispose();
});
await test("archived viewer: read-only (no input line, no superuser hints)", async () => {
	const file = makeSessionFixture();
	const log = [];
	const component = viewer.createViewer({
		core: fakeViewerCore(file, log),
		tui: fakeTui,
		theme: realTheme,
		archived: { address: "oneshot/tmp-abc", type: "oneshot", id: "tmp-abc", archiveDir: scratch, retiredAt: "2026-07-08T10:00:00.000Z", sessionFile: file },
		onDone: () => {},
	});
	await tick();
	const text = component.render(100).map(strip).join("\n");
	assert.match(text, /oneshot\/tmp-abc · retired 2026-07-08 · archived/);
	assert.match(text, /archived · read-only/);
	assert.doesNotMatch(text, /enter mail/);
	for (const ch of "hello") component.handleInput(ch); // typing does nothing
	component.handleInput("\r");
	await tick();
	assert.equal(log.length, 0, "no sends from an archived viewer");
	component.dispose();
});

// ---------------------------------------------------------------------------
// (m) escalation modal
// ---------------------------------------------------------------------------
console.log("(m) escalation modal:");
const record = {
	id: "esc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
	agent: "refactorer/auth",
	tool: "bash",
	inputSummary: "git push origin main",
	reason: "writePaths (mutation outside src/auth/**)",
	status: "pending",
	envelopeId: null,
	note: null,
	createdAt: "",
	resolvedAt: null,
};

await test("modal body matches the spec shape", () => {
	assert.deepEqual(modal.escalationLines(record), [
		"⚠ refactorer/auth requests approval",
		"  bash: git push origin main",
		"  blocked by: writePaths (mutation outside src/auth/**)",
		"  [a]pprove once  [d]eny  [D]eny with note  [v]iew session",
	]);
});
const driveModal = (keys, queuedBehind = 0) => {
	let result;
	const component = modal.createEscalationModal({
		record,
		queuedBehind,
		tui: fakeTui,
		theme: plainTheme,
		onDone: (r) => (result = r),
	});
	for (const key of keys) component.handleInput(key);
	return { result, component };
};
await test("a → approve once; d → deny; v → view; Esc → dismissed (stays queued)", () => {
	assert.deepEqual(driveModal(["a"]).result, { action: "approve" });
	assert.deepEqual(driveModal(["d"]).result, { action: "deny" });
	assert.deepEqual(driveModal(["v"]).result, { action: "view" });
	assert.deepEqual(driveModal(["\x1b"]).result, { action: "dismissed" });
});
await test("D opens the note input; Enter denies WITH the note", () => {
	const { result } = driveModal(["D", ..."off-plan", "\r"]);
	assert.deepEqual(result, { action: "deny", note: "off-plan" });
});
await test("D then Esc cancels note mode without resolving", () => {
	const { result, component } = driveModal(["D", ..."abc", "\x1b"]);
	assert.equal(result, undefined, "escape only left note mode");
	component.handleInput("a");
	// still resolvable afterwards
});
await test("queued count renders behind the prompt", () => {
	const component = modal.createEscalationModal({ record, queuedBehind: 2, tui: fakeTui, theme: plainTheme, onDone: () => {} });
	const text = component.render(90).map(strip).join("\n");
	assert.match(text, /\(\+2 more pending\)/);
	assert.match(text, /⚠ refactorer\/auth requests approval/);
});
// The modal now renders into a FULL-SCREEN overlay (index.ts surfaceEscalations
// uses the same overlayOptions as the working viewer: anchor top-left,
// 100%×100%, margin 0). Verify the approval prompt reads well full-width and
// stays width-safe, with the leading blank line off the top edge.
await test("modal render: full-screen sanity at 80/120 (leading blank, spec lines, width-safe)", () => {
	const component = modal.createEscalationModal({
		record,
		queuedBehind: 3,
		tui: fakeTui,
		theme: plainTheme,
		onDone: () => {},
	});
	for (const width of [80, 120]) {
		const raw = component.render(width);
		const lines = raw.map(strip);
		assert.equal(lines[0], "", "leading blank line for full-screen breathing room");
		assert.ok(lines.some((line) => /⚠ refactorer\/auth requests approval/.test(line)), "prompt header");
		assert.ok(lines.some((line) => /\[a\]pprove once/.test(line)), "action line");
		assert.ok(lines.some((line) => /\(\+3 more pending\)/.test(line)), "queued count");
		for (const line of raw) {
			assert.ok(visibleWidth(line) <= width, `no line exceeds ${width} cols (got ${visibleWidth(line)})`);
		}
	}
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
