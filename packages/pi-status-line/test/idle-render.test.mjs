import test from "node:test";
import assert from "node:assert/strict";
import { createPiJiti } from "../../../tests/runtime.mjs";

const jiti = await createPiJiti(import.meta.url);
const statusLine = await jiti.import("../extensions/status-line/index.ts");
const { createTimerWidget } = await jiti.import("../../pi-timers/extensions/timers/tui/widget.ts");
const { TuiMainScreen, CURSOR_MARKER } = await jiti.import("@earendil-works/pi-tui");

function bus() {
	const handlers = new Map();
	return {
		on(name, handler) {
			const listeners = handlers.get(name) ?? [];
			listeners.push(handler);
			handlers.set(name, listeners);
		},
		emit(name, ...args) {
			for (const handler of handlers.get(name) ?? []) handler(...args);
		},
	};
}

function host() {
	let renders = 0;
	let mounts = 0;
	const widgets = new Map();
	const tui = { requestRender() { renders++; } };
	const theme = { fg: (_color, text) => text, bold: text => text };
	const ui = {
		setWidget(key, factory) {
			widgets.get(key)?.dispose?.();
			widgets.delete(key);
			if (factory) {
				mounts++;
				widgets.set(key, factory(tui, theme));
			}
			tui.requestRender();
		},
		setFooter(factory) {
			factory?.(tui, theme, { getExtensionStatuses: () => new Map() });
			tui.requestRender();
		},
	};
	return { ui, widgets, get renders() { return renders; }, get mounts() { return mounts; } };
}

test("status header stays idle and re-pins only on widget mount events", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const lifecycle = bus();
	const events = bus();
	const h = host();
	const pi = { events, on: lifecycle.on, registerCommand() {}, registerShortcut() {} };
	statusLine.default(pi);
	const ctx = { mode: "tui", ui: h.ui };
	lifecycle.emit("session_start", {}, ctx);
	const idleMounts = h.mounts;
	const idleRenders = h.renders;
	t.mock.timers.tick(3000);
	assert.equal(h.mounts, idleMounts, "idle must not recreate the status header");
	assert.equal(h.renders, idleRenders, "idle must not request terminal rendering");
	const header = [...h.widgets.keys()].at(-1);
	h.ui.setWidget("late-content", () => ({ render: () => ["Content"] }));
	events.emit("status-line:pin-header", {});
	assert.equal([...h.widgets.keys()].at(-1), header);
	lifecycle.emit("session_shutdown", {}, ctx);
	const stoppedRenders = h.renders;
	events.emit("status-line:pin-header", {});
	t.mock.timers.tick(3000);
	assert.equal(h.renders, stoppedRenders);
});

test("idle status and empty timers emit no writes through Pi's terminal renderer", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const writes = [];
	const terminal = {
		columns: 100, rows: 24,
		write: text => writes.push(text),
		hideCursor: () => writes.push("hide-cursor"),
		showCursor: () => writes.push("show-cursor"),
	};
	const tui = new TuiMainScreen(terminal);
	// Render synchronously so every extension request exercises the real ANSI renderer.
	tui.requestRender = () => tui.doRender();
	const widgets = new Map();
	const statuses = new Map();
	const theme = { fg: (_color, text) => text, bold: text => text };
	let footer;
	const ui = {
		setWidget(key, factory) {
			widgets.get(key)?.dispose?.();
			widgets.delete(key);
			if (factory) widgets.set(key, factory(tui, theme));
			tui.requestRender();
		},
		setFooter(factory) {
			footer = factory?.(tui, theme, { getExtensionStatuses: () => statuses });
			tui.requestRender();
		},
	};
	tui.addChild({
		render(width) {
			return ["Static transcript for selection",
				...[...widgets.values()].flatMap(widget => widget.render(width)),
				`> ${CURSOR_MARKER}`, ...(footer?.render(width) ?? [])];
		},
	});
	const lifecycle = bus();
	statusLine.default({ events: bus(), on: lifecycle.on, registerCommand() {}, registerShortcut() {} });
	const ctx = { mode: "tui", ui, getContextUsage: () => null,
		sessionManager: { getEntries: () => [] } };
	lifecycle.emit("session_start", {}, ctx);
	const widget = createTimerWidget({ list: () => [] }, ui);
	try {
		writes.length = 0;
		t.mock.timers.tick(5000);
		assert.deepEqual(writes, [], "idle extensions must not send even cursor updates to the terminal");
	} finally {
		widget.dispose();
		lifecycle.emit("session_shutdown", {}, ctx);
	}
});

test("timer widget is quiet when empty and refreshes live countdowns", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let timers = [];
	const h = host();
	const widget = createTimerWidget({ list: () => timers }, h.ui);
	try {
		const idleRenders = h.renders;
		t.mock.timers.tick(3000);
		assert.equal(h.renders, idleRenders, "empty timer widget must not request rendering");
		timers = [{ id: "timer-1" }];
		widget.refresh();
		const activeRenders = h.renders;
		t.mock.timers.tick(1000);
		assert.equal(h.renders, activeRenders + 1, "active countdown must still update");
		timers = [];
		widget.refresh();
		const clearedRenders = h.renders;
		t.mock.timers.tick(3000);
		assert.equal(h.renders, clearedRenders);
	} finally {
		widget.dispose();
	}
	const stoppedRenders = h.renders;
	widget.refresh();
	t.mock.timers.tick(3000);
	assert.equal(h.renders, stoppedRenders);
});
