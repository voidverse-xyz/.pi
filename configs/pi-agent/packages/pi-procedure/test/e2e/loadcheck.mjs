/**
 * loadcheck.mjs — jiti-load the extension entry with a fake ExtensionAPI and
 * assert every surface registers: the procedure tool, /procedures, alt+w, alt+e.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { summary, test } from "./harness.mjs";

const extension = await jiti.import(join(EXT, "..", "index.ts"));
const statusLineExtension = await jiti.import(join(EXT, "..", "..", "..", "pi-status-line", "extensions", "status-line", "index.ts"));
const { createProcedureTool } = await jiti.import(join(EXT, "tool.ts"));
const { BOTTOM_PADDING, createTreeWidget, EXPAND_KEY } = await jiti.import(join(EXT, "tui/tree-widget.ts"));

const tools = [];
const commands = new Map();
const shortcuts = new Map();
const handlers = new Map();
const entryRenderers = new Map();
const entries = [];
const fakePi = {
	registerTool: (t) => tools.push(t),
	registerCommand: (name, spec) => commands.set(name, spec),
	registerShortcut: (key, spec) => shortcuts.set(key, spec),
	registerEntryRenderer: (type, renderer) => entryRenderers.set(type, renderer),
	appendEntry: (type, data) => entries.push({ type, data }),
	on: (event, fn) => handlers.set(event, fn),
	events: { emit: () => {}, on: () => () => {} },
};

await test("extension registers tool, command, shortcut, lifecycle handlers", () => {
	extension.default(fakePi);
	assert.deepEqual(tools.map((t) => t.name), ["procedure"]);
	assert.ok(commands.has("procedures"));
	assert.ok(shortcuts.has("alt+w"));
	assert.ok(shortcuts.has("alt+e"));
	assert.ok(handlers.has("session_start"));
	assert.ok(handlers.has("session_shutdown"));
	assert.ok(entryRenderers.has("procedure-command-output"));
});

await test("procedure widget mounts raw, preserves compact padding, and expands via its controller", () => {
	let current = {
		runId: "20260718T000000_aaaaaa",
		name: "widget-check",
		status: "running",
		currentPhase: "Inspect",
		phases: ["Inspect"],
		rows: Array.from({ length: 5 }, (_, seq) => ({ seq, label: `agent-${seq}`, phase: "Inspect", state: seq === 0 ? "running" : "queued" })),
		logs: ["first log", "second log"],
	};
	let content;
	let component;
	let renderRequests = 0;
	let pinRequests = 0;
	const tui = { requestRender: () => renderRequests++ };
	const theme = { fg: (_color, text) => text };
	const ui = {
		setWidget: (_key, nextContent) => {
			component?.dispose?.();
			content = nextContent;
			component = nextContent ? nextContent(tui, theme) : undefined;
		},
	};
	const controller = createTreeWidget(() => current, ui, { onMounted: () => pinRequests++ });
	try {
		assert.equal(typeof content, "function", "raw component factory bypasses Pi's string-widget cap");
		assert.equal(pinRequests, 1, "mount requests immediate status-header re-pinning");
		const compact = component.render(200);
		assert.ok(compact.length <= 10);
		assert.equal(compact.at(-1), BOTTOM_PADDING, "compact view keeps the visible bottom-padding row");
		assert.ok(compact.at(-2).endsWith(`${EXPAND_KEY} expand`));
		assert.equal(controller.toggleExpanded(), true);
		assert.ok(renderRequests > 0);
		const expanded = component.render(200);
		assert.ok(expanded.length > compact.length);
		assert.ok(expanded[0].includes(`${EXPAND_KEY} collapse`));
		current = { ...current, status: "completed" };
		controller.refresh();
		assert.equal(content, undefined, "completed run clears the widget");
	} finally {
		controller.dispose();
	}
});

await test("procedure mount immediately re-pins the project/Git status row below it", () => {
	const eventHandlers = new Map();
	const extensionHandlers = new Map();
	const events = {
		on: (channel, handler) => eventHandlers.set(channel, handler),
		emit: (channel, data) => eventHandlers.get(channel)?.(data),
	};
	statusLineExtension.default({
		events,
		registerCommand: () => {},
		on: (event, handler) => extensionHandlers.set(event, handler),
	});

	const widgets = new Map();
	const tui = { requestRender: () => {} };
	const theme = { fg: (_color, text) => text };
	const footerData = { getExtensionStatuses: () => new Map() };
	const ui = {
		setFooter: (factory) => factory?.(tui, theme, footerData),
		setWidget: (key, content) => {
			widgets.delete(key);
			if (content !== undefined) widgets.set(key, content);
		},
	};
	const ctx = { mode: "tui", ui };
	extensionHandlers.get("session_start")({}, ctx);
	assert.deepEqual([...widgets.keys()], ["status-line-header"]);

	const activeSnapshot = {
		runId: "20260718T000000_bbbbbb",
		name: "status-order",
		status: "running",
		currentPhase: "Inspect",
		phases: ["Inspect"],
		rows: Array.from({ length: 5 }, (_, seq) => ({ seq, label: `agent-${seq}`, phase: "Inspect", state: "running" })),
		logs: ["one", "two"],
	};
	const controller = createTreeWidget(() => activeSnapshot, ui, {
		onMounted: () => events.emit("status-line:pin-header", {}),
	});
	try {
		assert.deepEqual([...widgets.keys()], ["procedure-tree", "status-line-header"]);
	} finally {
		controller.dispose();
		extensionHandlers.get("session_shutdown")({}, ctx);
	}
});

await test("maxConcurrent settings default, validate, and clamp to 1..64", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-procedure-settings-"));
	const file = join(dir, "procedures.json");
	assert.equal(extension.readMaxConcurrent(file), 4);
	writeFileSync(file, JSON.stringify({ maxConcurrent: 7 }));
	assert.equal(extension.readMaxConcurrent(file), 7);
	writeFileSync(file, JSON.stringify({ maxConcurrent: 0 }));
	assert.equal(extension.readMaxConcurrent(file), 1);
	writeFileSync(file, JSON.stringify({ maxConcurrent: 100 }));
	assert.equal(extension.readMaxConcurrent(file), 64);
	writeFileSync(file, JSON.stringify({ maxConcurrent: 1.5 }));
	assert.equal(extension.readMaxConcurrent(file), 4);
	writeFileSync(file, "not json");
	assert.equal(extension.readMaxConcurrent(file), 4);
});

await test("tool params: exactly-one-source errors are thrown for Pi to mark", async () => {
	const tool = tools[0];
	const ctx = { cwd: "/tmp", mode: "print", isProjectTrusted: () => false };
	await assert.rejects(tool.execute("t1", {}, undefined, undefined, ctx), /exactly one/i);
	await assert.rejects(tool.execute("t2", { script: "return 1", name: "x" }, undefined, undefined, ctx), /exactly one/i);
});

await test("tool enforces one active run and throws source-resolution failures", async () => {
	const ctx = { cwd: "/tmp", mode: "print", isProjectTrusted: () => false };
	const active = { run: { name: "busy", runId: "20260716T000000_aaaaaa" } };
	const host = {
		active,
		lastRunId: { value: null },
		resolveSource: () => ({ source: "return 1" }),
		createRun: () => assert.fail("must not create a second run"),
		onRunChanged: () => {},
	};
	const tool = createProcedureTool(host);
	await assert.rejects(tool.execute("busy", { script: "return 1" }, undefined, undefined, ctx), /already running/);

	active.run = null;
	host.resolveSource = () => {
		throw new Error("source resolution failed");
	};
	await assert.rejects(tool.execute("bad-source", { script: "return 1" }, undefined, undefined, ctx), /source resolution failed/);
});

await test("/procedures lists, describes, completes, and reports missing saved procedures", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-procedure-command-"));
	const procedureDir = join(cwd, ".pi", "procedures");
	mkdirSync(procedureDir, { recursive: true });
	writeFileSync(
		join(procedureDir, "command-check.js"),
		"export const meta = {name: 'command-check', description: 'command coverage', phases: ['One']};\nreturn 1\n",
	);
	const notices = [];
	const ctx = {
		cwd,
		mode: "print",
		isProjectTrusted: () => true,
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const command = commands.get("procedures");
	const completions = command.getArgumentCompletions("command-");
	assert.ok(completions.some((item) => item.value === "command-check"));

	await command.handler("", ctx);
	assert.match(notices.at(-1).message, /command-check \(project\) — command coverage/);
	await command.handler("command-check", ctx);
	assert.match(notices.at(-1).message, /phases: One/);
	await command.handler("missing-command-check", ctx);
	assert.equal(notices.at(-1).level, "error");
	assert.match(notices.at(-1).message, /No saved procedure named/);

	const tuiCtx = { ...ctx, mode: "tui" };
	await command.handler("", tuiCtx);
	assert.equal(entries.at(-1).type, "procedure-command-output");
	assert.match(entries.at(-1).data.text, /command-check \(project\) — command coverage/);
});

summary("loadcheck");
