#!/usr/bin/env node

import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
	throw new Error("@earendil-works/pi-coding-agent not found; install Pi globally or set PI_SDK_DIR");
}

const PI_PACKAGE = findPiPackage();
const { loadExtensions } = await import(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js"));

function resultEntry(todos) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "todo_write", isError: false, details: { todos } },
	};
}

async function loadTodoExtension() {
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

test("todo_write rejects an omitted unfinished item without mutating prior state", async () => {
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

test("session_start and session_tree restore only the selected branch snapshot", async () => {
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

test("tool guidance requires observable completion and reserves destructive operations", async () => {
	const { tool } = await loadTodoExtension();
	const guidance = [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
	assert.match(guidance, /never remove/i);
	assert.match(guidance, /keep completed/i);
	assert.match(guidance, /direct user-requested|user directly/i);
});
