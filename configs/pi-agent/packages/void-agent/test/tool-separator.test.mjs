#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "extensions", "void-agent", "index.ts");
const THEME = join(HERE, "..", "themes", "void-agent.json");
const WIDTH = 48;

function importPath(...segments) {
	return import(pathToFileURL(join(...segments)).href);
}

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

function stripAnsi(value) {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function hasDivider(lines) {
	return stripAnsi(lines.at(-1) ?? "") === "─".repeat(WIDTH);
}

const PI_PACKAGE = findPiPackage();
const scratch = mkdtempSync(join(tmpdir(), "void-agent-tool-separator-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let handlers;
let originalRender;
let ToolExecutionComponent;

try {
	process.env.PI_CODING_AGENT_DIR = scratch;
	const root = await importPath(PI_PACKAGE, "dist", "index.js");
	ToolExecutionComponent = root.ToolExecutionComponent;
	originalRender = ToolExecutionComponent.prototype.render;

	const { loadThemeFromPath, setThemeInstance } = await importPath(
		PI_PACKAGE, "dist", "modes", "interactive", "theme", "theme.js"
	);
	setThemeInstance(loadThemeFromPath(THEME, "truecolor"));

	const { loadExtensions } = await importPath(PI_PACKAGE, "dist", "core", "extensions", "loader.js");
	const loaded = await loadExtensions([EXTENSION], scratch);
	assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);
	assert.equal(loaded.extensions.length, 1, "exactly one extension loads");
	handlers = loaded.extensions[0].handlers;
	assert.notEqual(ToolExecutionComponent.prototype.render, originalRender, "root-exported tool component is patched");

	const tool = new ToolExecutionComponent(
		"standalone-probe",
		"tool-1",
		{ input: "probe" },
		{ showImages: false },
		undefined,
		{ requestRender() {} },
		scratch,
	);
	tool.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
	assert.equal(hasDivider(tool.render(WIDTH)), false, "streaming tool output has no premature divider");

	tool.updateResult({ content: [{ type: "text", text: "complete" }], isError: false });
	const completed = tool.render(WIDTH);
	assert.equal(hasDivider(completed), true, "completed tool output ends with a full-width divider");
	assert.notEqual(completed[0], "", "zero-width outer spacer is removed while box padding remains");

	const ctx = {
		mode: "tui",
		ui: {
			setWorkingMessage() {},
			setWorkingIndicator() {},
			setEditorComponent() {},
			setHeader() {},
		},
	};
	for (const handler of handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown" }, ctx);
	}
	assert.equal(ToolExecutionComponent.prototype.render, originalRender, "tool renderer restores on shutdown");

	console.log("tool separator ok — root-exported component patch, completion divider, spacing, and cleanup");
} finally {
	if (ToolExecutionComponent && originalRender) {
		ToolExecutionComponent.prototype.render = originalRender;
		delete ToolExecutionComponent.prototype[Symbol.for("void-agent.tool-render-patch")];
	}
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(scratch, { recursive: true, force: true });
}
