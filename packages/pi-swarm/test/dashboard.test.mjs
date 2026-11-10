import test from "node:test";
import assert from "node:assert/strict";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { transcriptText } from "../extensions/swarm/transcript.mjs";
import { SwarmDashboard, displayText, showDashboard } from "../extensions/swarm/dashboard.mjs";

function fixture() {
	let snapshot = { run: { status: "running", revision: 1, cycle: 1, elapsedMs: 12, limits: { active: 4 }, objective: "Goal", workers: [{ id: "one", specialization: "Database", brief: "Investigate" }, { id: "two", specialization: "Review", brief: "Check" }], tasks: [], messages: [] }, driver: { active: ["one"], queued: [], errors: [] }, errors: [] };
	let tick; let clears = 0; let renders = 0;
	const results = []; const historyReads = [];
	const signal = new AbortController();
	const keybindings = { matches: (data, action) => matchesKey(data, ({ "tui.select.cancel": "escape", "tui.select.confirm": "enter", "tui.select.up": "up", "tui.select.down": "down", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown" })[action]) };
	const options = { source: { snapshot: () => snapshot, history: id => { historyReads.push(id); return Array.from({ length: 130 }, (_, i) => ({ id: String(i), message: { role: "assistant", content: `entry-${i}` } })); } }, tui: { terminal: { rows: 24 }, requestRender: () => renders++ }, theme: { fg: (_, text) => text }, keybindings, signal: signal.signal, done: value => results.push(value), schedule: callback => { tick = callback; return 1; }, unschedule: () => clears++ };
	const view = new SwarmDashboard(options);
	return { view, options, signal, results, historyReads, tick: () => tick(), snapshot, setSnapshot: next => { snapshot = next; }, clears: () => clears, renders: () => renders };
}

test("dashboard labels native and unattached selection without claiming mock-only execution", () => {
	const f = fixture();
	f.snapshot.run.hostApprovals = [{ provider: { transport: "pi-native" } }];
	f.tick();
	assert.match(f.view.render(100).join("\n"), /1 Messages.*2 Agents.*3 Topics/);
	assert.doesNotMatch(f.view.render(100).join("\n"), /mock only/);
	f.view.handleInput("2"); assert.match(f.view.body(), /cost: unknown/);
	f.setSnapshot(undefined); f.tick();
	assert.match(f.view.render(100).join("\n"), /unattached/);
	assert.doesNotMatch(f.view.render(100).join("\n"), /mock only/);
	f.view.dispose();
});

test("polling refreshes detached inspection, never executes work; dispose is idempotent", () => {
	const f = fixture();
	assert.match(f.view.render(80).join("\n"), /running/);
	f.snapshot.run.status = "paused"; f.tick();
	assert.match(f.view.render(80).join("\n"), /paused/);
	assert.equal(f.renders(), 1);
	assert.deepEqual(f.results, []);
	f.view.handleInput("\x1b"); f.view.dispose(); f.signal.abort();
	assert.equal(f.clears(), 1); assert.deepEqual(f.results, [undefined]);
	f.tick(); assert.equal(f.renders(), 1);
});

test("worker selection and paged native history have no entry-count cutoff", () => {
	const f = fixture();
	f.view.handleInput("2"); assert.match(f.view.render(80).join("\n"), /working/);
	f.view.handleInput("\x1b[C"); f.view.handleInput("\r");
	assert.deepEqual(f.historyReads, ["two"]);
	f.view.handleInput("\x1b[F");
	assert.match(f.view.render(80).join("\n"), /entry-129/);
	f.tick(); assert.equal(f.historyReads.length, 1);
	f.snapshot.run.revision++; f.tick(); assert.equal(f.historyReads.length, 2);
	f.view.dispose();
});

for (const [key, status, action] of [["p", "running", "pause"], ["s", "running", "stop"], ["r", "paused", "resume"], ["R", "stopped", "restart"], ["C", "pausing", "reconcile"]]) {
	test(`${key} cannot ${action} from the read-only dashboard`, () => {
		const f = fixture(); f.snapshot.run.status = status; f.tick();
		f.view.handleInput(key); f.view.handleInput(key);
		assert.deepEqual(f.results, []); assert.equal(f.clears(), 0); f.view.dispose();
	});
}

test("ineligible continuation does nothing and lifecycle abort returns no action", () => {
	const f = fixture(); f.view.handleInput("r"); f.view.handleInput("R");
	assert.deepEqual(f.results, []); f.signal.abort();
	assert.deepEqual(f.results, [undefined]); assert.equal(f.clears(), 1);
});

test("all sections escape controls and bound Unicode/long strings at narrow widths", () => {
	const f = fixture();
	const hostile = "\x1b]52;c;evil\x07\r\u009b2J\u202e" + "界🙂".repeat(500);
	f.snapshot.run.objective = hostile;
	f.snapshot.run.workers[0].brief = hostile;
	f.snapshot.run.tasks = [{ id: hostile, status: "blocked" }];
	f.snapshot.run.messages = [{ text: hostile }];
	for (const section of "123") {
		f.view.handleInput(section);
		for (const width of [1, 2, 8, 20, 40, 60, 100]) {
			const lines = f.view.render(width);
			assert.equal(lines.length, f.options.tui.terminal.rows);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `${section}: ${width}`);
				assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ""), /[\x00-\x1f\x7f-\x9f\u202e]/);
			}
		}
	}
	assert.match(displayText(hostile), /\\u001b/);
	f.view.dispose();
});

test("read errors remain inspection failures, not stale history or automatic retry actions", () => {
	const f = fixture(); f.options.source.history = () => { throw new Error("private data"); };
	f.view.handleInput("c");
	assert.match(f.view.render(80).join("\n"), /Inspection unavailable/);
	assert.doesNotMatch(f.view.render(80).join("\n"), /private data/);
	assert.deepEqual(f.results, []); f.view.dispose();
});

test("custom UI rejection always disposes its component", async () => {
	const f = fixture(); f.view.dispose(); let component;
	await assert.rejects(showDashboard({ ui: { custom: async factory => {
		component = factory(f.options.tui, f.options.theme, f.options.keybindings, () => {});
		throw new Error("UI closed");
	} } }, f.options.source, f.signal.signal));
	assert.equal(component.closed, true);
});

test("Vim navigation owns rows, panes, half pages and both ends", () => {
	const f = fixture();
	f.view.handleInput("\t"); assert.equal(f.view.section, 1);
	f.view.handleInput("j"); assert.equal(f.view.workerId, "two");
	f.view.handleInput("k"); assert.equal(f.view.workerId, "one");
	f.view.handleInput("c"); f.view.render(60); assert.equal(f.view.section, 0); assert.equal(f.view.isConversation, true);
	f.view.handleInput("G"); f.view.render(60); assert.ok(f.view.offset > 100);
	f.view.handleInput("g"); f.view.handleInput("g"); f.view.render(60); assert.equal(f.view.offset, 0);
	f.view.handleInput("\x04"); assert.equal(f.view.offset, Math.floor(f.view.pageSize / 2));
	f.view.handleInput("\x15"); assert.equal(f.view.offset, 0);
	f.view.handleInput("q"); assert.equal(f.view.section, 1); assert.deepEqual(f.results, []);
	f.view.handleInput("h"); assert.equal(f.view.section, 0);
	f.view.handleInput("l"); assert.equal(f.view.section, 1);
	f.view.handleInput("q"); assert.deepEqual(f.results, [undefined]);
});

test("search is a modal local input, with cancel, reset, no matches and paste isolation", () => {
	const f = fixture(); f.view.handleInput("c"); f.view.render(60);
	f.view.handleInput("/"); f.view.handleInput("p"); f.view.handleInput("s"); f.view.handleInput("C");
	assert.deepEqual(f.results, []); assert.equal(f.view.draft, "psC");
	f.view.handleInput("\x1b"); assert.equal(f.view.query, "");
	f.view.handleInput("/"); f.view.handleInput("entry-12"); f.view.handleInput("\r");
	f.view.render(60); assert.equal(f.view.matchCount, 11); assert.ok(f.view.offset > 0);
	const first = f.view.offset; f.view.handleInput("n"); f.view.render(60); assert.ok(f.view.offset > first);
	f.view.handleInput("N"); f.view.render(60); assert.equal(f.view.offset, first);
	f.view.handleInput("/"); f.view.handleInput("missing"); f.view.handleInput("\r");
	assert.equal(f.view.matchCount, 0); f.view.handleInput("n");
	f.view.handleInput("/"); f.view.handleInput("\r"); assert.equal(f.view.query, "");
	f.view.handleInput("\x1b[200~"); f.view.handleInput("p"); f.view.handleInput("sC\x1b[201~");
	assert.deepEqual(f.results, []);
	f.view.handleInput("/"); f.view.handleInput("\x1b[200~p\x1b[201~"); f.view.handleInput("\r");
	assert.equal(f.view.query, "p"); assert.deepEqual(f.results, []); f.view.dispose();
});

for (const [name, content, query, expectedRow] of [
	["exact boundary", "X".repeat(20) + "MATCH", "MATCH", 1],
	["word wrap", "X".repeat(16) + " MATCH", "MATCH", 1],
	["wide Unicode boundary", "界🙂".repeat(5) + "MATCH", "MATCH", 1],
	["wide Unicode word wrap", "界".repeat(8) + " MATCH", "MATCH", 1],
	["combining graphemes", "e\u0301".repeat(20) + "MATCH", "MATCH", 1],
	["match across wrapped rows", "X".repeat(18) + "MATCH", "MATCH", 0],
	["case expansion before match", "İ".repeat(20) + "MATCH", "match", 1],
]) {
	test(`search maps ${name} to the actual rendered row`, () => {
		const f = fixture();
		f.view.handleInput("c");
		f.view.body = () => content + "\n" + "tail\n".repeat(30);
		f.view.render(24); // 20 content columns plus the padded frame.
		f.view.handleInput("/"); f.view.handleInput(query); f.view.handleInput("\r");
		assert.equal(f.view.matchOffset, expectedRow);
		f.view.render(24);
		assert.equal(f.view.offset, expectedRow);
		assert.match(f.view.lines[expectedRow], expectedRow === 0 ? /MA$/ : /MATCH/);
		f.view.dispose();
	});
}

test("refresh retains worker identity and scroll; follow tail is explicit and cancellable", () => {
	const f = fixture(); f.view.handleInput("2"); f.view.handleInput("j");
	f.snapshot.run.workers.reverse(); f.tick(); assert.equal(f.view.workerId, "two"); assert.equal(f.view.workerIndex, 0);
	f.view.handleInput("c"); f.view.render(80); f.view.handleInput("j"); f.view.render(80);
	const offset = f.view.offset; f.snapshot.run.revision++; f.tick(); f.view.render(80); assert.equal(f.view.offset, offset);
	f.view.handleInput("f"); f.view.render(80); assert.equal(f.view.follow, true); assert.match(f.view.render(80).join("\n"), /entry-129/);
	f.view.handleInput("k"); assert.equal(f.view.follow, false);
	f.signal.abort(); assert.deepEqual(f.results, [undefined]); assert.equal(f.clears(), 1);
});

test("help is scrollable, preserves position and cannot dispatch controls", () => {
	const f = fixture(); f.view.handleInput("c"); f.view.render(60); f.view.handleInput("G"); f.view.render(60);
	const offset = f.view.offset;
	f.view.handleInput("?"); f.view.render(60); f.view.handleInput("p"); f.view.handleInput("C");
	assert.deepEqual(f.results, []); f.view.handleInput("G"); assert.match(f.view.render(60).join("\n"), /Inspection never starts/);
	f.view.handleInput("?"); f.view.render(60); assert.equal(f.view.offset, offset); f.view.dispose();
});

test("focused overlay options and pre-aborted mounting are lifecycle safe", async () => {
	const f = fixture(); f.view.dispose(); let calls = 0;
	const ctx = { ui: { custom: async (factory, options) => {
		calls++; assert.equal(options.overlay, true);
		assert.deepEqual(options.overlayOptions, { row: 0, col: 0, width: "100%", maxHeight: "100%" });
		const view = factory(f.options.tui, f.options.theme, f.options.keybindings, () => {});
		view.finish(); return undefined;
	} } };
	await showDashboard(ctx, f.options.source, f.signal.signal);
	f.signal.abort(); await showDashboard(ctx, f.options.source, f.signal.signal); assert.equal(calls, 1);
});

test("semantic transcript retains roles, context updates and all entries without replay secrets", () => {
	const entries = [
		{ id: "u", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Objective" } },
		{ id: "a", message: { role: "assistant", content: [{ type: "text", text: "Answer" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "sample.txt" }, thoughtSignature: "SECRET" }], responseId: "SECRET" } },
		{ message: { role: "toolResult", toolName: "read", toolCallId: "call", isError: false, content: [{ type: "text", text: "Result text" }], details: { credential: "SECRET" } } },
		{ message: { role: "system", sections: { policy: "Be careful" }, toolsRemoved: [{ name: "write" }] } },
		{ type: "compaction", summary: "Earlier work", firstKeptEntryId: "u", systemMessage: { role: "system", content: "Checkpoint" } },
		{ type: "context_edit", targetId: "u", replacement: null },
		{ type: "model_change", provider: "fixture", modelId: "model" },
		{ type: "custom", customType: "private-host", data: "SECRET" },
		{ type: "session", cwd: "SECRET" },
	];
	const text = transcriptText(entries);
	for (const expected of ["user", "assistant", "Result text", "call", "Be careful", "Earlier work", "Checkpoint", "Omitted from future", "fixture/model", "9 · session"]) assert.ok(text.includes(expected), expected);
	assert.doesNotMatch(text, /SECRET/);
});

for (const [name, replacement, expected] of [
	["string", { content: "Replacement\x1b[2J\u202e", privateData: "SECRET" }, /Replacement\\u001b\[2J\\u202e/],
	["blocks", { content: [{ type: "text", text: "Block\x1b[2J" }, { type: "image", mimeType: "image/png", data: "SECRET" }, { type: "thinking", redacted: true, thinking: "SECRET" }], privateData: "SECRET" }, /Block\\u001b\[2J/],
	["null", null, /Omitted from future model context/],
]) {
	test(`native context edit ${name} renders content without private metadata or controls`, () => {
		const f = fixture();
		f.options.source.history = () => [{ type: "context_edit", targetId: "original", replacement }];
		f.view.handleInput("c");
		const text = displayText(f.view.body());
		assert.match(text, /No messages yet/);
		assert.match(displayText(transcriptText([{ type: "context_edit", targetId: "original", replacement }])), expected);
		assert.doesNotMatch(text, /SECRET|\x1b|\u202e|No text content/);
		f.view.render(60);
		assert.doesNotMatch(f.view.lines.join("\n"), /SECRET|\x1b|\u202e/);
		f.view.dispose();
	});
}

test("frames remain width and height bounded at supported terminal sizes", () => {
	const f = fixture();
	for (const [width, height] of [[60, 24], [80, 24], [100, 40]]) {
		f.options.tui.terminal.rows = height;
		for (const section of "123") {
			f.view.handleInput(section);
			const lines = f.view.render(width);
			assert.equal(lines.length, height);
			assert.ok(lines[3].startsWith("╭") && lines[3].endsWith("╮"));
			assert.ok(lines.at(-2).startsWith("╰") && lines.at(-2).endsWith("╯"));
			for (const line of lines.slice(4, -2)) {
				assert.ok(line.startsWith("│ ") && line.endsWith(" │"));
				assert.equal(visibleWidth(line), width);
			}
			assert.ok(lines.every(line => visibleWidth(line) <= width));
		}
	}
	f.view.dispose();
});


test("topics open their messages and the default view shows main and peer conversations", () => {
	const f = fixture();
	f.snapshot.run.messages = [
		{ from: "owner", to: "one", text: "Investigate", topic: "Auth" },
		{ from: "one", to: "two", text: "Review this", topic: "Auth" },
		{ from: "two", to: "board", text: "Finding", topic: "Storage" },
	]; f.tick();
	assert.match(f.view.body(), /Main agent → one/);
	assert.match(f.view.body(), /one → two/);
	f.view.handleInput("3"); assert.match(f.view.body(), /Auth +\[Discussion\]\n  2 messages/);
	f.view.handleInput("\r"); assert.equal(f.view.section, 0);
	assert.match(f.view.body(), /Investigate/); assert.doesNotMatch(f.view.body(), /Finding/);
	f.view.handleInput("a"); assert.match(f.view.body(), /Finding/);
	f.view.dispose();
});


test("the main agent is selectable and opens only its team conversations", () => {
	const f = fixture();
	f.snapshot.run.messages = [{ from: "one", to: "owner", text: "Question for main" }, { from: "one", to: "two", text: "Peer-only" }];
	f.view.handleInput("2"); f.view.handleInput("k");
	assert.equal(f.view.workerId, "owner");
	f.view.handleInput("\r");
	assert.equal(f.view.section, 0); assert.equal(f.view.isConversation, true);
	assert.match(f.view.body(), /Question for main/); assert.doesNotMatch(f.view.body(), /Peer-only/);
	assert.deepEqual(f.historyReads, []);
	f.view.handleInput("q"); assert.equal(f.view.section, 1); f.view.dispose();
});

test("spaced roster reveals only selected detail and assignment state", () => {
	const f = fixture();
	f.snapshot.run.tasks = [{ id: "build", title: "Build feature", status: "assigned", assignment: { workerId: "one" } }];
	f.view.handleInput("2");
	assert.match(f.view.body(), /> one · working · Database/);
	assert.match(f.view.body(), /Investigate\n  Tasks: Build feature \[assigned\]/);
	assert.match(f.view.body(), /Tasks: Build feature \[assigned\]\n\n  two · idle · Review/);
	assert.doesNotMatch(f.view.body(), /Check/);
	f.view.handleInput("j");
	assert.match(f.view.body(), /> two · idle · Review\n  Model: unavailable · Thinking: unavailable\n  Check/);
	assert.doesNotMatch(f.view.body(), /Tasks:|Investigate|Build feature/);
	f.view.dispose();
});

test("dashboard chrome and selection use live semantic theme roles", () => {
	const f = fixture();
	f.snapshot.run.tasks = [{ id: "build", title: "Build feature", status: "assigned", assignment: { workerId: "one" } }];
	const colors = [];
	f.options.theme.fg = (color, text) => { colors.push({ color, text }); return text; };
	f.view.handleInput("2"); f.view.render(80);
	assert.ok(colors.some(row => row.color === "border" && row.text.startsWith("╭ Agents ") && row.text.endsWith("╮")));
	assert.ok(colors.some(row => row.color === "accent" && row.text.startsWith("> one")));
	assert.ok(colors.some(row => row.color === "muted" && row.text.startsWith("  Investigate")));
	assert.ok(colors.some(row => row.color === "muted" && row.text.startsWith("  Tasks:")));
	assert.ok(colors.some(row => row.color === "text" && row.text.startsWith("  two")));
	assert.equal(colors.at(-1).color, "dim");
	f.view.dispose();
});

test("Agents hierarchy keeps wrapped headings prominent and metadata muted", () => {
	const f = fixture();
	f.view.handleInput("2");
	const rows = f.view.contentRows("> A long selected heading across multiple rows\n  Participants: one, two, three\n\n  Another long heading across multiple rows\n  Topic: discussion-key", 16);
	const gap = rows.findIndex(row => row.text === "");
	const firstDetails = rows.findIndex(row => row.text.includes("Participants:"));
	assert.ok(firstDetails > 1, "heading wraps across multiple rows");
	assert.ok(rows.slice(0, firstDetails).every(row => row.color === "accent"));
	assert.ok(rows.slice(firstDetails, gap).every(row => row.color === "muted"));
	const secondDetails = rows.findIndex(row => row.text.includes("Topic:"));
	assert.ok(rows.slice(gap + 1, secondDetails).every(row => row.color === "text"));
	assert.ok(rows.slice(secondDetails).every(row => row.color === "muted"));
	f.view.handleInput("1");
	assert.ok(f.view.contentRows("Heading\nDescription", 16).every(row => row.color === "text"));
	f.view.handleInput("3"); f.view.help = true;
	assert.ok(f.view.contentRows("Heading\nDescription", 16).every(row => row.color === "text"));
	f.view.dispose();
});

test("Topics show status badges and message counts with muted metadata", () => {
	const f = fixture();
	f.snapshot.run.tasks = [
		{ id: "waiting", status: "ready" },
		{ id: "problem", status: "blocked" },
		{ id: "finished", status: "done" },
	];
	f.tick(); f.view.handleInput("3");
	const rows = f.view.contentRows(f.view.body(), 80);
	for (const status of ["Ready", "Blocked", "Done"]) {
		const index = rows.findIndex(row => row.text.includes(`[${status}]`));
		assert.ok(index >= 0);
		assert.equal(rows[index].color, rows[index].text.startsWith("> ") ? "accent" : "text");
		assert.equal(rows[index + 1].text, "  0 messages · No participants yet");
		assert.equal(rows[index + 1].color, "muted");
	}
	const wrapped = f.view.contentRows("> [Blocked] Long selected topic name\n  2 messages · one, two, three\n\n  [Done] Other topic\n  0 messages · No participants yet", 16);
	const details = wrapped.findIndex(row => row.text.includes("2 messages"));
	assert.ok(details > 1);
	assert.ok(wrapped.slice(0, details).every(row => row.color === "accent"));
	const gap = wrapped.findIndex(row => row.text === "");
	assert.ok(wrapped.slice(details, gap).every(row => row.color === "muted"));
	f.view.dispose();
});

test("empty roster and short terminal remain closeable without worker execution", () => {
	const f = fixture();
	f.snapshot.run.workers = []; f.tick(); f.view.handleInput("2");
	assert.match(f.view.body(), /> Main agent/);
	assert.match(f.view.body(), /No agents recruited/);
	f.options.tui.terminal.rows = 8;
	assert.equal(f.view.render(20).length, 8);
	f.options.tui.terminal.rows = 1;
	assert.match(f.view.render(20)[0], /Esc\/q back/);
	f.view.handleInput("q"); assert.deepEqual(f.results, [undefined]);
	assert.deepEqual(f.historyReads, []);
});

test("topics show one displayed name with count and retain underlying discussion identity", () => {
	const f = fixture();
	f.snapshot.run.tasks = [{ id: "build", title: "Build feature", status: "ready" }];
	f.snapshot.run.messages = [{ from: "one", to: "@board", text: "Finding", topic: "Review" }];
	f.tick(); f.view.handleInput("3");
	assert.match(f.view.body(), /> build +\[Ready\]\n  Build feature\n  0 messages · No participants yet\n\n  Review +\[Discussion\]\n  1 message · one/);
	assert.doesNotMatch(f.view.body(), /\(build\)/);
	f.view.handleInput("\r"); assert.equal(f.view.topic, "build");
	f.view.handleInput("q"); assert.equal(f.view.selectedTopic, "build");
	const screen = f.view.render(80).join("\n");
	assert.match(screen, /3 Topics/);
	assert.doesNotMatch(screen, /Boards/);
	assert.match(screen, /Topic 1\/2 · Enter discussion/);
	f.view.handleInput("j"); f.view.render(80);
	assert.equal(f.view.offset, 0, "selection within the page must not jump to the top");
	assert.match(f.view.render(80).at(-1), /Topic 2\/2/);
	f.view.handleInput("\r"); assert.match(f.view.body(), /Finding/);
	f.view.handleInput("q"); assert.equal(f.view.selectedTopic, "Review");
	f.view.dispose();
});

test("list selection reveals spaced entries and details with minimal scrolling", () => {
	const f = fixture();
	f.snapshot.run.workers = Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, specialization: "Review", brief: "Inspect tests" }));
	f.tick(); f.options.tui.terminal.rows = 16;
	f.view.handleInput("2"); f.view.handleInput("j"); f.view.render(60);
	assert.equal(f.view.offset, 0);
	assert.match(f.view.render(60).at(-1), /Agent 2\/13 · Enter messages/);
	f.view.handleInput("j"); f.view.render(60);
	assert.equal(f.view.offset, 0);
	for (let i = 0; i < 8; i++) { f.view.handleInput("j"); f.view.render(60); }
	assert.equal(f.view.workerId, "agent-9");
	assert.ok(f.view.offset > 0);
	assert.match(f.view.render(60).join("\n"), /> agent-9[\s\S]*Inspect tests/);
	assert.doesNotMatch(f.view.body(), /Tasks:/);
	f.view.handleInput("k"); f.view.render(60);
	assert.match(f.view.render(60).join("\n"), /> agent-8/);
	f.view.handleInput("?"); assert.match(f.view.render(60).join("\n"), /NAVIGATION/);
	f.view.handleInput("?"); assert.match(f.view.render(60).join("\n"), /> agent-8/);
	f.view.dispose();
});

test("wrapped topic selection remains visible in small list viewports", () => {
	const f = fixture();
	f.snapshot.run.tasks = Array.from({ length: 8 }, (_, i) => ({ id: `topic-${i}`, title: `Discuss wide characters 界🙂 ${i}`, status: "ready" }));
	f.tick(); f.options.tui.terminal.rows = 10;
	f.view.handleInput("3"); f.view.render(24);
	for (let i = 0; i < 7; i++) {
		f.view.handleInput("j");
		const lines = f.view.render(24);
		assert.equal(lines.length, 10);
		assert.ok(lines.every(line => visibleWidth(line) <= 24));
		assert.ok(lines.some(line => line.includes(`> topic-${i + 1}`)), "selected heading stays visible even when details exceed the viewport");
	}
	f.view.handleInput("\r"); assert.equal(f.view.topic, "topic-7");
	f.view.dispose();
});

test("topic selection survives live insertion and scoped messages return to Topics", () => {
	const f = fixture();
	f.snapshot.run.messages = [{ from: "one", to: "owner", text: "Auth discussion", topic: "Auth" }, { from: "two", to: "owner", text: "Storage discussion", topic: "Storage" }];
	f.tick(); f.view.handleInput("3"); f.view.handleInput("j");
	assert.equal(f.view.selectedTopic, "Storage");
	f.snapshot.run.tasks = [{ id: "new", title: "New task", status: "ready" }]; f.tick();
	assert.equal(f.view.selectedTopic, "Storage");
	f.view.handleInput("\r"); assert.match(f.view.body(), /Storage discussion/); assert.doesNotMatch(f.view.body(), /Auth discussion/);
	f.view.handleInput("q"); assert.equal(f.view.section, 2);
	f.view.handleInput("1"); assert.equal(f.view.topic, undefined); f.view.dispose();
});

test("worker model labels resolve recorded defaults and overrides in roster and transcript", () => {
	const f = fixture();
	f.snapshot.run.sessions = {
		selection: { provider: "default-provider", modelId: "default-model", thinkingLevel: "low" },
		workerModels: [{ workerId: "two", selection: { provider: "override-provider", modelId: "review-model", thinkingLevel: "high" } }],
	};
	f.view.handleInput("2");
	assert.match(f.view.body(), /Model: default-model · Thinking: low/);
	assert.match(f.view.body(), /Model: review-model · Thinking: high/);
	assert.doesNotMatch(f.view.body(), /default-provider|override-provider/);
	f.view.openConversation("two");
	let screen = f.view.render(90).join("\n");
	assert.match(screen, /Model: review-model/);
	assert.match(screen, /Thinking: high/);
	f.snapshot.run.sessions.selection.thinkingLevel = "medium";
	f.tick();
	assert.match(f.view.render(90).join("\n"), /Thinking: high/);
	f.options.source.history = () => [];
	f.view.openSteer("one");
	screen = f.view.render(90).join("\n");
	assert.match(screen, /Model: default-model/);
	assert.match(screen, /Thinking: medium/);
	assert.deepEqual(f.results, [], "model inspection cannot dispatch actions");
	f.view.dispose();
});

test("worker model metadata is honest when absent and cannot inject terminal controls", () => {
	const f = fixture();
	f.view.handleInput("2");
	assert.match(f.view.body(), /Model: unavailable · Thinking: unavailable/);
	f.snapshot.run.sessions = { selection: { provider: "provider\nname", modelId: "model\x1b[2J", thinkingLevel: "off" } };
	f.tick();
	for (const width of [80, 40, 24, 12]) {
		const lines = f.view.render(width);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.ok(lines.every(line => !line.includes("\x1b[2J") && !line.includes("\n")));
	}
	assert.match(f.view.body(), /Thinking: off/);
	assert.doesNotMatch(f.view.body(), /provider name/);
	f.view.dispose();
});

test("compact topics preserve full selected titles, preview the latest message and retain routing", () => {
	const f = fixture();
	const title = "A detailed topic title that needs more room than a compact row allows";
	f.snapshot.run.tasks = [{ id: "stable-id", title, status: "blocked" }, { id: "other", title: "Other", status: "ready" }];
	f.snapshot.run.messages = [
		{ from: "one", to: "owner", text: "Old preview", topic: "stable-id" },
		{ from: "owner", to: "one", text: "Latest\nreply\x1b[2J", topic: "stable-id" },
	];
	f.tick(); f.view.handleInput("3");
	const lines = f.view.render(48, 16);
	assert.ok(lines.every(line => visibleWidth(line) <= 48));
	const body = f.view.body();
	assert.match(body.split("\n")[0], /^> stable-id +\[Blocked\]$/);
	assert.equal(visibleWidth(body.split("\n")[0]), 44, "status aligns to content right edge");
	assert.ok(body.includes(title), "selected title remains available after compact-heading truncation");
	assert.match(body, /2 messages · one, Main agent/);
	assert.match(body, /Latest · Main agent: Latest reply/);
	assert.doesNotMatch(body, /Old preview|\x1b/);
	f.view.handleInput("\r");
	assert.equal(f.view.topic, "stable-id", "selection uses the original topic identity");
	f.view.dispose();
});
