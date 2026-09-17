#!/usr/bin/env node

import test from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "index.ts");

function findPiPackage() {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	// npm installs globals to a different root per platform, and on Windows that
	// root is under APPDATA. Probe both so these tests are not silently POSIX-only.
	const candidates = [
		process.env.PI_SDK_DIR,
		join(home, ".local/lib/node_modules/@earendil-works/pi-coding-agent"),
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
		process.env.APPDATA ? join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent") : undefined,
		join(home, "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent"),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "dist", "cli.js"))) return candidate;
	}
	return undefined;
}

const PI_PACKAGE = findPiPackage();
const requireFromPi = PI_PACKAGE ? createRequire(join(PI_PACKAGE, "package.json")) : undefined;
const loadExtensions = PI_PACKAGE
	? (await import(pathToFileURL(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js")).href)).loadExtensions
	: undefined;
const SDK_TEST_OPTIONS = loadExtensions
	? {}
	: { skip: "Pi's importable Node distribution is unavailable; the binary runtime load test still runs." };

function resultEntry(todos) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "todo_write", isError: false, details: { todos } },
	};
}

async function loadTodoExtension() {
	assert.ok(loadExtensions, "Pi's importable Node distribution is required for lifecycle tests");
	const loaded = await loadExtensions([EXTENSION], process.cwd());
	assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);
	assert.equal(loaded.extensions.length, 1, "exactly one extension loads");
	const extension = loaded.extensions[0];
	const tool = extension.tools.get("todo_write")?.definition;
	assert.ok(tool, "todo_write registered");
	return { tool, handlers: extension.handlers };
}

function makeContext(getBranch) {
	return {
		mode: "json",
		ui: {},
		sessionManager: { getBranch },
	};
}

async function emit(handlers, name, ctx) {
	for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
}

test("extension loads in the installed Pi runtime", (t) => {
	const rpc = spawnSync(
		process.env.PI_BIN ?? "pi",
		[
			"--mode",
			"rpc",
			"--no-session",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-e",
			EXTENSION,
		],
		{
			encoding: "utf8",
			input: '{"id":"load-check","type":"get_state"}\n',
			timeout: 15_000,
		},
	);
	if (rpc.error?.code === "ENOENT") {
		t.skip("Pi executable not found; set PI_BIN to run the binary runtime load test.");
		return;
	}
	assert.ifError(rpc.error);
	assert.equal(rpc.status, 0, rpc.stderr || rpc.stdout);

	const records = rpc.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const response = records.find((record) => record.id === "load-check");
	assert.equal(response?.success, true, `missing successful get_state response: ${rpc.stdout}`);
	assert.equal(records.some((record) => record.type === "extension_error"), false, rpc.stdout);
});

test("widget output honors the TUI component width", SDK_TEST_OPTIONS, async () => {
	const { handlers } = await loadTodoExtension();
	assert.ok(requireFromPi);
	const { visibleWidth } = await import(pathToFileURL(requireFromPi.resolve("@earendil-works/pi-tui")).href);
	const longContent = "a very long 界 todo description ".repeat(8);
	let widgetFactory;
	const ctx = {
		mode: "tui",
		ui: {
			setWidget(_key, value) {
				if (typeof value === "function") widgetFactory = value;
			},
		},
		sessionManager: {
			getBranch: () => [resultEntry([{ content: longContent, status: "in_progress" }])],
		},
	};
	await emit(handlers, "session_start", ctx);
	assert.equal(typeof widgetFactory, "function");

	const theme = {
		fg: (_color, text) => `\x1b[31m${text}\x1b[39m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
		strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
	};
	const component = widgetFactory({ requestRender() {} }, theme);
	const width = 24;
	const lines = component.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	assert.equal(lines.some((line) => line.includes(longContent)), false);
});

test("todo_write rejects an omitted unfinished item without mutating prior state", SDK_TEST_OPTIONS, async () => {
	const { tool } = await loadTodoExtension();
	const ctx = makeContext(() => []);
	await tool.execute(
		"1",
		{
			todos: [
				{ content: "a", status: "in_progress", activeForm: "doing a" },
				{ content: "b", status: "pending" },
			],
		},
		undefined,
		undefined,
		ctx,
	);
	await assert.rejects(
		tool.execute("2", { todos: [{ content: "b", status: "in_progress" }] }, undefined, undefined, ctx),
		/must keep every existing item.*a/i,
	);
	const accepted = await tool.execute(
		"3",
		{
			todos: [
				{ content: "a", status: "completed" },
				{ content: "b", status: "in_progress" },
			],
		},
		undefined,
		undefined,
		ctx,
	);
	assert.deepEqual(accepted.details?.todos, [
		{ content: "a", status: "completed" },
		{ content: "b", status: "in_progress" },
	]);
});

test("session_start and session_tree restore only the selected branch snapshot", SDK_TEST_OPTIONS, async () => {
	const { tool, handlers } = await loadTodoExtension();
	let branch = [resultEntry([{ content: "left", status: "in_progress" }])];
	const ctx = makeContext(() => branch);
	await emit(handlers, "session_start", ctx);
	await assert.rejects(
		tool.execute("1", { todos: [{ content: "other", status: "pending" }] }, undefined, undefined, ctx),
		/must keep every existing item.*left/i,
	);

	branch = [resultEntry([{ content: "right", status: "in_progress" }])];
	await emit(handlers, "session_tree", ctx);
	const accepted = await tool.execute(
		"2",
		{ todos: [{ content: "right", status: "completed" }] },
		undefined,
		undefined,
		ctx,
	);
	assert.deepEqual(accepted.details?.todos, [{ content: "right", status: "completed" }]);
});

test("tool guidance requires observable completion and reserves destructive operations", SDK_TEST_OPTIONS, async () => {
	const { tool } = await loadTodoExtension();
	const guidance = [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
	assert.match(guidance, /never remove/i);
	assert.match(guidance, /keep completed/i);
	assert.match(guidance, /direct user-requested|user directly/i);
	assert.match(guidance, /different task or topic/i);
	assert.match(guidance, /cleanup.*simple|exception.*simple/i);
});

test("an accepted todo_write result renders nothing, leaving the list to the widget", SDK_TEST_OPTIONS, async () => {
	const { tool } = await loadTodoExtension();
	const theme = {
		fg: (_color, text) => text,
		bold: (text) => text,
		strikethrough: (text) => text,
	};
	const todos = [
		{ content: "Fix store layer", status: "completed" },
		{ content: "Fix mail", status: "in_progress", activeForm: "Fixing mail" },
	];
	const accepted = await tool.execute("1", { todos }, undefined, undefined, makeContext(() => []));

	const rendered = tool.renderResult(accepted, { expanded: false, isPartial: false }, theme, { isError: false });
	assert.deepEqual(rendered.render(80), [], "the accepted list must not be redrawn under the call line");

	const callLine = tool.renderCall({ todos }, theme, { isError: false }).render(80).join("");
	assert.match(callLine, /1\/2 done/);
	assert.match(callLine, /Fixing mail/);

	const rejected = { content: [{ type: "text", text: "A normal todo update must keep every existing item." }] };
	const failure = tool.renderResult(rejected, { expanded: false, isPartial: false }, theme, { isError: true }).render(80);
	assert.ok(failure.join("").includes("must keep every existing item"), "rejections still report why");
});

test("a finished checklist is dropped when the next user turn begins", SDK_TEST_OPTIONS, async () => {
	const { tool, handlers } = await loadTodoExtension();
	const ctx = makeContext(() => []);
	await tool.execute("1", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "completed" }] }, undefined, undefined, ctx);

	// Until the user speaks again the finished list stands, so it is still on
	// screen beside the final report — and still protected from silent omission.
	await assert.rejects(
		tool.execute("2", { todos: [{ content: "c", status: "pending" }] }, undefined, undefined, ctx),
		/must keep every existing item/i,
	);

	await emit(handlers, "agent_start", ctx);

	// The new turn starts from nothing, so unrelated work needs no replace/clear.
	const accepted = await tool.execute("3", { todos: [{ content: "c", status: "pending" }] }, undefined, undefined, ctx);
	assert.deepEqual(accepted.details?.todos, [{ content: "c", status: "pending" }]);
});

test("an unfinished checklist survives the turn boundary for the model to judge", SDK_TEST_OPTIONS, async () => {
	const { tool, handlers } = await loadTodoExtension();
	const ctx = makeContext(() => []);
	const list = [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }];
	await tool.execute("1", { todos: list }, undefined, undefined, ctx);

	await emit(handlers, "agent_start", ctx);

	await assert.rejects(
		tool.execute("2", { todos: [{ content: "c", status: "pending" }] }, undefined, undefined, ctx),
		/must keep every existing item.*a/i,
		"unfinished work is a pivot decision for the model, not a runtime drop",
	);
});
