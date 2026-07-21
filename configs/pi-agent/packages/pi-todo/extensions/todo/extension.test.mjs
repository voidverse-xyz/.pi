#!/usr/bin/env node

import test from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "index.ts");

function findPiPackage() {
	const home = process.env.HOME ?? "";
	const candidates = [
		process.env.PI_SDK_DIR,
		join(home, ".local/lib/node_modules/@earendil-works/pi-coding-agent"),
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "dist", "cli.js"))) return candidate;
	}
	return undefined;
}

const PI_PACKAGE = findPiPackage();
const requireFromPi = PI_PACKAGE ? createRequire(join(PI_PACKAGE, "package.json")) : undefined;
const loadExtensions = PI_PACKAGE
	? (await import(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js"))).loadExtensions
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
	const { visibleWidth } = await import(requireFromPi.resolve("@earendil-works/pi-tui"));
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
