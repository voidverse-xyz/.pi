import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { AgentComposer } from "../extensions/swarm/composer.mjs";
import { SwarmDashboard } from "../extensions/swarm/dashboard.mjs";

function fixture(send = async () => {}) {
	const run = { runId: "fixture-run", status: "running", revision: 1, workers: [{ id: "one", brief: "Review", specialization: "Tests" }], tasks: [], messages: [] };
	const notices = []; const mainDrafts = []; const navigation = []; const deliveries = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = { fg: (_color, text) => text };
	const dashboard = new SwarmDashboard({
		source: { snapshot: () => ({ run }), history: () => [] }, tui, theme,
		keybindings: { matches: (data, action) => matchesKey(data, ({ "tui.select.cancel": "escape", "tui.select.confirm": "enter" })[action]) },
		signal: new AbortController().signal, done() {}, schedule() {}, unschedule() {}
	});
	dashboard.messageEditor = true; dashboard.focusNavigation = true; dashboard.openSteer("one");
	const drafts = new Map(); const pending = new Map();
	const options = { dashboard, drafts, pending, runId: run.runId,
		ui: { notify: (text, level) => notices.push({ text, level }), setEditorText: text => mainDrafts.push(text) },
		navigate: action => navigation.push(action), send: (...args) => { deliveries.push(args); return send(...args); } };
	const view = new AgentComposer(options);
	return { view, options, run, tui, notices, mainDrafts, navigation, deliveries, drafts, pending };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test("Steer opens at tail, follows completed additions, and Ctrl+End resumes after scroll without stealing drafts", () => {
	initTheme("dark");
	const f = fixture();
	const dashboard = f.options.dashboard;
	const history = Array.from({ length: 30 }, (_, index) => ({ message: { role: "user", content: `Message ${index}` } }));
	dashboard.source.history = () => history;
	try {
		dashboard.openSteer("one");
		let screen = f.view.render(100).join("\n");
		assert.equal(dashboard.follow, true);
		assert.match(screen, /Message 29/);
		assert.equal(dashboard.offset, dashboard.lines.length - dashboard.pageSize);
		assert.equal((screen.match(/Message agent/g) ?? []).length, 1, "one input label, on border only");
		history.push({ message: { role: "user", content: "Followed addition" } });
		dashboard.refresh(); screen = f.view.render(100).join("\n");
		assert.match(screen, /Followed addition/);
		f.view.handleInput("draft f123");
		f.view.handleInput("\x1b[5~"); screen = f.view.render(100).join("\n");
		assert.equal(dashboard.follow, false);
		const scrolledOffset = dashboard.offset;
		assert.doesNotMatch(screen, /Followed addition/);
		history.push({ message: { role: "user", content: "Unfollowed addition" } });
		dashboard.refresh(); screen = f.view.render(100).join("\n");
		assert.equal(dashboard.offset, scrolledOffset);
		assert.doesNotMatch(screen, /Unfollowed addition/);
		f.view.handleInput("\x1b[1;5F"); screen = f.view.render(100).join("\n");
		assert.equal(dashboard.follow, true);
		assert.match(screen, /Unfollowed addition/);
		assert.equal(f.view.editor.getText(), "draft f123");
		assert.equal(f.deliveries.length, 0);
	} finally { f.view.dispose(); }
});

test("unowned running Swarm retains drafts without invoking delivery", async () => {
	const f = fixture();
	f.options.dashboard.source.snapshot = () => ({ run: f.run, ownershipHeld: false });
	try {
		await f.view.submit("Do not dispatch");
		assert.equal(f.deliveries.length, 0);
		assert.equal(f.view.editor.getText(), "Do not dispatch");
	} finally { f.view.dispose(); }
});

test("Steer switching retains independent per-worker drafts", () => {
	const f = fixture();
	f.run.workers.push({ id: "two", specialization: "Second" });
	try {
		f.view.handleInput("First draft"); f.view.handleInput("\t");
		f.view.handleInput("j"); f.view.handleInput("\r");
		f.view.handleInput("Second draft"); f.view.handleInput("\t");
		f.view.handleInput("k"); f.view.handleInput("\r");
		assert.equal(f.view.editor.getText(), "First draft");
		assert.equal(f.drafts.get("two"), "Second draft");
		assert.equal(f.deliveries.length, 0);
	} finally { f.view.dispose(); }
});

test("composer belongs only to Steer; Agents and agent mail remain read-only", () => {
	const f = fixture();
	try {
		let screen = f.view.render(80).join("\n");
		assert.match(screen, /Steer · native Pi transcript/);
		assert.match(screen, /╭ Message agent/);
		f.view.handleInput("draft for one"); f.view.handleInput("\t");
		for (const key of ["1", "3", "2"]) {
			f.view.handleInput(key); screen = f.view.render(80).join("\n");
			assert.match(screen, /1 Messages.*2 Agents.*3 Topics.*4 Steer/);
			assert.doesNotMatch(screen, /Message agent|Enter send/);
		}
		f.view.handleInput("\r"); screen = f.view.render(80).join("\n");
		assert.match(screen, /Agent conversation/); assert.doesNotMatch(screen, /Message agent|Enter send/);
		f.view.handleInput("4"); f.view.handleInput("\r");
		assert.equal(f.view.editor.getText(), "draft for one");
		assert.equal(f.deliveries.length, 0);
	} finally { f.view.dispose(); }
});

test("native Enter sends once to the selected worker and clears only on success", async () => {
	let complete;
	const f = fixture(() => new Promise(resolve => { complete = resolve; }));
	try {
		f.view.handleInput("Please review this"); f.view.handleInput("\r");
		assert.deepEqual(f.deliveries, [["one", "Please review this", "fixture-run"]]);
		assert.equal(f.view.editor.getText(), "Please review this");
		f.view.handleInput("\r"); f.view.handleInput("new text");
		assert.equal(f.deliveries.length, 1);
		assert.match(f.view.render(80).join("\n"), /Sending…/);
		complete(); await settled();
		assert.equal(f.view.editor.getText(), ""); assert.equal(f.drafts.size, 0);
		assert.match(f.notices.at(-1).text, /Message queued to one/);
	} finally { f.view.dispose(); }
});

for (const status of ["paused", "pausing", "stopped", "completed", "verifying"]) {
	test(`${status} blocks submission and retains the native editor draft`, async () => {
		const f = fixture(); f.run.status = status;
		try {
			f.view.handleInput("Keep this draft"); f.view.handleInput("\r"); await settled();
			assert.equal(f.deliveries.length, 0); assert.equal(f.view.editor.getText(), "Keep this draft");
			assert.equal(f.drafts.get("one"), "Keep this draft");
			assert.match(f.notices.at(-1).text, /draft retained/);
		} finally { f.view.dispose(); }
	});
}

test("run changes, removed recipients, and oversized text cannot be sent", async () => {
	for (const mutate of [f => { f.run.runId = "different"; }, f => { f.run.workers = []; }, () => {}]) {
		const f = fixture(); mutate(f);
		try {
			const text = f.run.runId === "fixture-run" && f.run.workers.length ? "x".repeat(32769) : "Retain";
			await f.view.submit(text);
			assert.equal(f.deliveries.length, 0); assert.equal(f.view.editor.getText(), text);
		} finally { f.view.dispose(); }
	}
});

test("snapshot failure cannot send or escape as an unhandled submit rejection", async () => {
	const f = fixture();
	f.options.dashboard.source.snapshot = () => { throw new Error("PRIVATE snapshot failure"); };
	try {
		await f.view.submit("Retain while unavailable");
		assert.equal(f.deliveries.length, 0);
		assert.equal(f.view.editor.getText(), "Retain while unavailable");
		assert.doesNotMatch(JSON.stringify(f.notices), /PRIVATE/);
		assert.equal(f.view.render(80).length, 24);
	} finally { f.view.dispose(); }
});

test("failed delivery retains drafts without raw error leakage or automatic retry", async () => {
	const f = fixture(async () => { throw new Error("PRIVATE provider error"); });
	try {
		f.view.handleInput("Retain after failure"); f.view.handleInput("\r"); await settled();
		assert.equal(f.view.editor.getText(), "Retain after failure");
		assert.equal(f.drafts.get("one"), "Retain after failure");
		assert.equal(f.pending.size, 0); assert.equal(f.deliveries.length, 1);
		assert.doesNotMatch(JSON.stringify(f.notices), /PRIVATE/);
		f.view.render(80); await settled(); assert.equal(f.deliveries.length, 1);
	} finally { f.view.dispose(); }
});

for (const command of ["/help", " !echo test"]) {
	test(`${command.trim()} moves to main as a draft and does not execute or send`, async () => {
		const f = fixture();
		try {
			await f.view.submit(command);
			assert.deepEqual(f.mainDrafts, [command]); assert.deepEqual(f.navigation, ["back"]);
			assert.equal(f.deliveries.length, 0); assert.equal(f.drafts.size, 0);
		} finally { f.view.dispose(); }
	});
}

test("letters, navigation digits and pasted newlines belong to the editor; images are rejected", async () => {
	const f = fixture();
	try {
		f.view.handleInput("qcf123/?");
		assert.equal(f.view.editor.getText(), "qcf123/?"); assert.equal(f.options.dashboard.isSteer, true);
		f.view.handleInput("\x1b[200~"); f.view.handleInput("\nMore text\t"); f.view.handleInput("\x1b[201~");
		assert.equal(f.deliveries.length, 0); assert.match(f.view.editor.getText(), /More text/);
		f.view.handleInput("\x16"); assert.match(f.notices.at(-1).text, /text only/);
		f.view.handleInput("\t"); assert.equal(f.options.dashboard.section, 3);
		assert.match(f.drafts.get("one"), /qcf123/);
		f.view.handleInput("\r"); assert.equal(f.options.dashboard.isSteer, true);
		assert.match(f.view.editor.getText(), /qcf123/);
	} finally { f.view.dispose(); }
});

for (const failure of [false, true]) {
	test(`pending paste remains data when delivery settles with ${failure ? "failure" : "success"} mid-paste`, async () => {
		let complete; let reject;
		const f = fixture(() => new Promise((resolve, fail) => { complete = resolve; reject = fail; }));
		try {
			f.view.handleInput("first"); f.view.handleInput("\r");
			f.view.handleInput("\x1b[200~");
			if (failure) reject(new Error("PRIVATE failure")); else complete();
			await settled();
			f.view.handleInput("pasted mail"); f.view.handleInput("\r"); f.view.handleInput("\x1b[201~");
			assert.equal(f.deliveries.length, 1, "pasted CR cannot send another message");
			assert.equal(f.view.editor.getText(), failure ? "first" : "");
			f.view.handleInput("next draft"); assert.match(f.view.editor.getText(), /next draft/);
		} finally { f.view.dispose(); }
	});
}

test("history paging does not edit the draft and focus propagates to the native cursor", () => {
	const f = fixture();
	try {
		f.view.focused = true; assert.equal(f.view.editor.focused, true);
		f.view.handleInput("Draft"); f.view.render(80); f.view.handleInput("\x1b[6~");
		assert.equal(f.view.editor.getText(), "Draft");
		assert.equal(f.options.dashboard.follow, false);
		assert.ok(f.view.render(80).some(line => line.includes(CURSOR_MARKER)));
	} finally { f.view.dispose(); }
});

test("pending sends survive view replacement without duplicates or stale successful drafts", async () => {
	let complete;
	const f = fixture(() => new Promise(resolve => { complete = resolve; }));
	f.view.handleInput("Send once"); f.view.handleInput("\r"); f.view.dispose();
	const reopened = new AgentComposer(f.options);
	try {
		reopened.render(80); reopened.handleInput("\r"); assert.equal(f.deliveries.length, 1);
		complete(); await settled(); reopened.render(80);
		assert.equal(reopened.editor.getText(), ""); assert.equal(f.drafts.size, 0);
		assert.equal(f.notices.length, 0, "closed view cannot notify or mutate newer UI");
	} finally { reopened.dispose(); }
});

test("closing a replacement view before redraw cannot resurrect delivered mail", async () => {
	for (const renderBeforeSettlement of [false, true]) {
		let complete;
		const f = fixture(() => new Promise(resolve => { complete = resolve; }));
		f.view.handleInput("Already delivered"); f.view.handleInput("\r"); f.view.dispose();
		const reopened = new AgentComposer(f.options);
		if (renderBeforeSettlement) reopened.render(80);
		complete(); await settled();
		reopened.dispose(); // No render/input after settlement.
		assert.equal(f.drafts.size, 0);
		assert.equal(f.deliveries.length, 1);
	}
});

test("closing a replacement view before redraw preserves a failed delivery draft", async () => {
	let fail;
	const f = fixture(() => new Promise((_resolve, reject) => { fail = reject; }));
	f.view.handleInput("Failed draft"); f.view.handleInput("\r"); f.view.dispose();
	const reopened = new AgentComposer(f.options);
	fail(new Error("PRIVATE failure")); await settled(); reopened.dispose();
	assert.equal(f.drafts.get("one"), "Failed draft");
	assert.equal(f.deliveries.length, 1);
});

for (const failure of [false, true]) {
	test(`new typing or paste clears stale ${failure ? "delivery error" : "send success"} feedback`, async () => {
		const f = fixture(async () => { if (failure) throw new Error("PRIVATE failure"); });
		try {
			await f.view.submit("First mail");
			assert.match(f.view.render(100).join("\n"), failure ? /delivery could not be confirmed/ : /Message queued to one/);
			f.view.handleInput("next draft");
			assert.equal(f.view.feedback, undefined);
			assert.match(f.view.render(100).join("\n"), /Enter send/);
			f.view.handleInput("\x16"); assert.ok(f.view.feedback);
			f.view.handleInput("\x1b[200~pasted text\x1b[201~");
			assert.equal(f.view.feedback, undefined);
			assert.equal(f.deliveries.length, 1);
		} finally { f.view.dispose(); }
	});
}

test("feedback clears on pane, recipient and displayed run state changes without losing drafts", async () => {
	const f = fixture();
	try {
		f.view.handleInput("Retained draft"); f.view.handleInput("\x16");
		f.view.handleInput("\t"); assert.equal(f.view.feedback, undefined);
		f.view.handleInput("\r"); assert.equal(f.view.editor.getText(), "Retained draft");
		f.view.handleInput("\x16");
		f.run.workers.push({ id: "two", specialization: "Second" });
		f.options.dashboard.openSteer("two"); f.view.render(100);
		assert.equal(f.view.feedback, undefined); assert.equal(f.drafts.get("one"), "Retained draft");
		f.options.dashboard.openSteer("one"); f.view.render(100);
		assert.equal(f.view.editor.getText(), "Retained draft");
		for (const mutate of [() => { f.run.status = "paused"; }, () => { f.run.status = "running"; },
			() => { f.run.runId = "replacement"; }, () => { f.run.workers = []; }]) {
			f.view.handleInput("\x16"); assert.ok(f.view.feedback);
			mutate(); f.view.render(100);
			assert.equal(f.view.feedback, undefined);
			assert.equal(f.view.editor.getText(), "Retained draft");
		}
		assert.equal(f.deliveries.length, 0);
	} finally { f.view.dispose(); }
});

test("late send settlement cannot restore feedback after recipient or run state changes", async () => {
	for (const changeRecipient of [false, true]) {
		let complete;
		const f = fixture(() => new Promise(resolve => { complete = resolve; }));
		try {
			f.view.handleInput("Pending mail"); f.view.handleInput("\r");
			assert.match(f.view.render(100).join("\n"), /Sending…/);
			if (changeRecipient) {
				f.run.workers.push({ id: "two", specialization: "Second" });
				f.options.dashboard.openSteer("two");
			} else f.run.status = "paused";
			f.view.render(100); complete(); await settled();
			const screen = f.view.render(100).join("\n");
			assert.doesNotMatch(screen, /Message queued to one/);
			assert.match(screen, changeRecipient ? /Enter send/ : /Paused\/unavailable/);
			assert.equal(f.pending.size, 0); assert.equal(f.deliveries.length, 1);
		} finally { f.view.dispose(); }
	}
});

test("native multiline composer stays bounded across terminal sizes and retains its cursor", () => {
	const f = fixture();
	try {
		f.view.focused = true;
		f.view.editor.setText(("界🙂 multiline draft\n").repeat(20));
		for (const [width, rows] of [[100, 40], [60, 24], [40, 16], [30, 9], [16, 10], [12, 6], [8, 4], [1, 1]]) {
			f.tui.terminal.rows = rows;
			const frame = f.view.render(width);
			assert.equal(frame.length, rows, `${width}x${rows} height`);
			assert.ok(frame.every(line => visibleWidth(line) <= width), `${width}x${rows} width`);
			if (width >= 4) assert.ok(frame.some(line => line.includes(CURSOR_MARKER)), `${width}x${rows} cursor`);
			else assert.match(frame[0], /E/, "tiny terminal retains safe close hints");
		}
	} finally { f.view.dispose(); }
});
