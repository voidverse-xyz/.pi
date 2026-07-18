/**
 * loadcheck.mjs — jiti-load the extension entry with a fake ExtensionAPI and
 * assert every surface registers: the workflow tool, /workflows, alt+w.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { summary, test } from "./harness.mjs";

const extension = await jiti.import(join(EXT, "..", "index.ts"));
const { createWorkflowTool } = await jiti.import(join(EXT, "tool.ts"));

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
	assert.deepEqual(tools.map((t) => t.name), ["workflow"]);
	assert.ok(commands.has("workflows"));
	assert.ok(shortcuts.has("alt+w"));
	assert.ok(handlers.has("session_start"));
	assert.ok(handlers.has("session_shutdown"));
	assert.ok(entryRenderers.has("workflow-command-output"));
});

await test("maxConcurrent settings default, validate, and clamp to 1..64", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-workflow-settings-"));
	const file = join(dir, "workflows.json");
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
	const tool = createWorkflowTool(host);
	await assert.rejects(tool.execute("busy", { script: "return 1" }, undefined, undefined, ctx), /already running/);

	active.run = null;
	host.resolveSource = () => {
		throw new Error("source resolution failed");
	};
	await assert.rejects(tool.execute("bad-source", { script: "return 1" }, undefined, undefined, ctx), /source resolution failed/);
});

await test("/workflows lists, describes, completes, and reports missing saved workflows", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-workflow-command-"));
	const workflowDir = join(cwd, ".pi", "workflows");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(
		join(workflowDir, "command-check.js"),
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
	const command = commands.get("workflows");
	const completions = command.getArgumentCompletions("command-");
	assert.ok(completions.some((item) => item.value === "command-check"));

	await command.handler("", ctx);
	assert.match(notices.at(-1).message, /command-check \(project\) — command coverage/);
	await command.handler("command-check", ctx);
	assert.match(notices.at(-1).message, /phases: One/);
	await command.handler("missing-command-check", ctx);
	assert.equal(notices.at(-1).level, "error");
	assert.match(notices.at(-1).message, /No saved workflow named/);

	const tuiCtx = { ...ctx, mode: "tui" };
	await command.handler("", tuiCtx);
	assert.equal(entries.at(-1).type, "workflow-command-output");
	assert.match(entries.at(-1).data.text, /command-check \(project\) — command coverage/);
});

summary("loadcheck");
