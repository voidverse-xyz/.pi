import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFocusBridge } from "../extensions/swarm/focus.mjs";

test("Swarm publishes into Pi agent navigation with an owned read-only three-tab overlay", () => {
	const events = new EventEmitter(); const changes = new Set(); const rosters = []; const navigated = []; const overlays = [];
	const snapshot = { run: { status: "running", revision: 1, workers: [{ id: "builder", specialization: "Implementation", brief: "Build" }], messages: [], tasks: [] }, driver: { active: ["builder"], queued: [] } };
	events.on("agent-focus:roster", roster => rosters.push(roster));
	events.on("agent-focus:navigate", target => navigated.push(target));
	const surface = { terminal: { rows: 24 }, requestRender() {}, showOverlay(component, options) {
		const record = { component, options, hidden: false }; overlays.push(record);
		return { hide() { record.hidden = true; } };
	} };
	const ui = { setWidget(_key, factory) { factory?.(surface, { fg: (_color, text) => text }); } };
	const source = { snapshot: () => snapshot, history: () => [], subscribe: fn => { changes.add(fn); return () => changes.delete(fn); } };
	const bridge = createFocusBridge({ events }, source, ui);
	try {
		assert.deepEqual(rosters.at(-1), { source: "swarm", noun: "swarm agent", agents: [{ id: "builder", name: "Implementation", working: true }] });
		events.emit("agent-focus:focus", { source: "swarm", id: "builder" });
		let view = overlays.at(-1).component;
		assert.deepEqual(overlays.at(-1).options, { row: 0, col: 0, width: "100%", maxHeight: "100%" });
		assert.match(view.render(80).join("\n"), /1 Messages.*2 Agents.*3 Topics/);
		assert.doesNotMatch(view.render(80).join("\n"), /Agent conversation|Message agent/);
		assert.match(view.render(80)[0], /Swarm · running · read-only/);
		assert.match(view.render(80)[1], /Alt\+N next · Esc main · PgUp\/PgDn history/);
		for (const [width, rows] of [[100, 40], [80, 24], [40, 16], [16, 10], [8, 8], [1, 1]]) {
			surface.terminal.rows = rows;
			const frame = view.render(width);
			assert.equal(frame.length, rows);
			assert.ok(frame.every(line => visibleWidth(line) <= width));
			if (width >= 16 && rows >= 10) {
				assert.ok(frame[3].startsWith("╭") && frame[3].endsWith("╮"));
				assert.ok(frame.at(-2).startsWith("╰") && frame.at(-2).endsWith("╯"));
				assert.ok(frame.slice(4, -2).every(line => line.startsWith("│ ") && line.endsWith(" │")));
			}
		}
		surface.terminal.rows = 24;
		for (const [position, total, counter] of [[2, 3, "[2/3] "], [0, 3, ""], [4, 3, ""], [1, 0, ""], [1.5, 3, ""], ["1", 3, ""], [1, Infinity, ""], [undefined, undefined, ""]]) {
			events.emit("agent-focus:focus", { source: "swarm", id: "builder", position, total });
			view = overlays.at(-1).component;
			const heading = view.render(80)[0];
			assert.ok(heading.startsWith(`${counter}Swarm`));
		}
		view.handleInput("\t"); assert.match(view.render(80).join("\n"), /Main agent/);
		assert.match(view.render(80).join("\n"), /1 Messages.*2 Agents.*3 Topics/);
		view.handleInput("p"); view.handleInput("s"); assert.deepEqual(navigated, []);
		view.handleInput("\x1bn"); assert.equal(navigated.at(-1).action, "next");
		view.handleInput("\x1b"); assert.equal(navigated.at(-1).action, "back");
		bridge.hide(); assert.equal(overlays.at(-1).hidden, true);
		events.emit("agent-focus:focus", { source: "swarm", id: "builder" });
		snapshot.run.workers = []; for (const update of changes) update();
		assert.equal(overlays.at(-1).hidden, true);
	} finally { bridge.dispose(); }
	assert.equal(changes.size, 0);
	assert.equal(events.listenerCount("agent-focus:focus"), 0);
	assert.equal(events.listenerCount("agent-focus:roster-request"), 0);
	assert.deepEqual(rosters.at(-1).agents, []);
});


test("Alt+N focus opens general Messages; only roster selection opens agent mail", async () => {
	const events = new EventEmitter(); const deliveries = []; const history = []; let component;
	const run = { runId: "overview-run", status: "running", revision: 1,
		workers: [{ id: "a", specialization: "Alpha" }, { id: "b", specialization: "Beta" }], tasks: [],
		messages: [{ from: "owner", to: "a", text: "Alpha mail" }, { from: "owner", to: "b", text: "Beta mail" }] };
	const source = { snapshot: () => ({ run }), history: id => { history.push(id); return []; }, subscribe: () => () => {} };
	const surface = { terminal: { rows: 24 }, requestRender() {}, showOverlay(value) { component = value; return { hide() {} }; } };
	const ui = { setWidget(_key, factory) { factory?.(surface, { fg: (_color, text) => text }); }, notify() {}, setEditorText() {} };
	events.on("agent-focus:navigate", target => {
		if (target.action === "select") events.emit("agent-focus:focus", { source: "swarm", id: target.targetId });
		else if (target.action === "next") events.emit("agent-focus:focus", { source: "swarm", id: "a" });
		else if (target.action === "back") events.emit("agent-focus:focus", { source: "main" });
	});
	const bridge = createFocusBridge({ events }, source, ui, { send: async (...args) => deliveries.push(args) });
	try {
		events.emit("agent-focus:focus", { source: "swarm", id: "a" });
		let screen = component.render(80).join("\n");
		assert.match(screen, /Alpha mail/); assert.match(screen, /Beta mail/);
		assert.doesNotMatch(screen, /Message agent|Agent conversation/);
		assert.deepEqual(history, []);
		component.handleInput("c");
		assert.doesNotMatch(component.render(80).join("\n"), /Message agent|Agent conversation/);
		assert.deepEqual(history, []);
		component.handleInput("2"); component.handleInput("j"); component.handleInput("\r");
		screen = component.render(80).join("\n");
		assert.match(screen, /Agent conversation/); assert.doesNotMatch(screen, /Message agent/);
		assert.match(screen, /Beta mail/); assert.doesNotMatch(screen, /Alpha mail/);
		assert.deepEqual(history, ["b"]);
		component.handleInput("4"); component.handleInput("\r");
		assert.match(component.render(80).join("\n"), /Steer · native Pi transcript/);
		component.handleInput("Mail to beta"); component.handleInput("\r");
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(deliveries, [["b", "Mail to beta", "overview-run"]]);
		component.handleInput("Retained beta draft"); component.handleInput("\x1bn");
		screen = component.render(80).join("\n");
		assert.match(screen, /Alpha mail/); assert.match(screen, /Beta mail/);
		assert.doesNotMatch(screen, /Message agent/);
		component.handleInput("4"); component.handleInput("j"); component.handleInput("\r");
		assert.match(component.render(80).join("\n"), /Retained beta draft/);
	} finally { bridge.dispose(); }
});

test("selecting main from a focused roster returns to the native main chat", () => {
	const events = new EventEmitter(); const navigation = []; let component;
	events.on("agent-focus:navigate", value => navigation.push(value));
	const source = { snapshot: () => ({ run: { status: "paused", workers: [{ id: "a", specialization: "Worker" }], tasks: [], messages: [] }, driver: { active: [], queued: [] } }), history: () => [], subscribe: () => () => {} };
	const surface = { terminal: { rows: 24 }, requestRender() {}, showOverlay(value) { component = value; return { hide() {} }; } };
	const bridge = createFocusBridge({ events }, source, { setWidget(_key, factory) { factory?.(surface, { fg: (_color, text) => text }); } });
	try {
		events.emit("agent-focus:focus", { source: "swarm", id: "a" });
		component.handleInput("2"); component.handleInput("k"); component.handleInput("\r");
		assert.deepEqual(navigation.at(-1), { source: "swarm", id: "a", action: "back" });
	} finally { bridge.dispose(); }
});
