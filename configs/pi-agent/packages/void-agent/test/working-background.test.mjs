#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "extensions", "void-agent", "index.ts");
const THEME = join(HERE, "..", "themes", "void-agent.json");

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

const PI_PACKAGE = findPiPackage();
const scratch = mkdtempSync(join(tmpdir(), "void-agent-"));
const originalRandom = Math.random;
const originalNow = Date.now;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

let commands;
let ctx;
let handlers;
let indicator;
let interactiveModePrototype;
let originalShowStatusIndicator;

try {
	process.env.PI_CODING_AGENT_DIR = scratch;
	const { loadExtensions } = await importPath(PI_PACKAGE, "dist", "core", "extensions", "loader.js");
	const { loadThemeFromPath, setThemeInstance } = await importPath(
		PI_PACKAGE, "dist", "modes", "interactive", "theme", "theme.js"
	);
	const { InteractiveMode } = await importPath(PI_PACKAGE, "dist", "index.js");
	const { WorkingStatusIndicator } = await importPath(
		PI_PACKAGE, "dist", "modes", "interactive", "components", "status-indicator.js"
	);
	interactiveModePrototype = InteractiveMode.prototype;
	originalShowStatusIndicator = interactiveModePrototype.showStatusIndicator;
	const { visibleWidth } = await importPath(
		PI_PACKAGE, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"
	);

	const theme = loadThemeFromPath(THEME, "truecolor");
	setThemeInstance(theme);

	const loaded = await loadExtensions([EXTENSION], scratch);
	assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);
	assert.equal(loaded.extensions.length, 1, "exactly one extension loads");
	handlers = loaded.extensions[0].handlers;
	commands = loaded.extensions[0].commands;
	assert.deepEqual([...commands.keys()], ["matrix", "working-animation"], "both animation commands register");
	assert.deepEqual(
		commands.get("matrix").getArgumentCompletions("o").map((item) => item.value),
		["on", "off"],
		"animation command completions expose on/off",
	);

	let workingMessage = "Working...";
	let workingIndicator;
	const notifications = [];
	const ui = {
		theme,
		setWorkingMessage(message) {
			workingMessage = message ?? "Working...";
			indicator?.setMessage(workingMessage);
		},
		setWorkingIndicator(options) { workingIndicator = options; },
		setTheme() { return { success: true }; },
		setHeader() {},
		setEditorComponent() {},
		notify(message, type = "info") { notifications.push({ message, type }); },
	};
	ctx = { mode: "tui", ui };

	const call = async (name, event = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const runCommand = async (name, args) => {
		const command = commands.get(name);
		assert.ok(command, `/${name} command exists`);
		await command.handler(args, ctx);
	};
	const startStyle = async (stylePick) => {
		// label, four style timings, comet direction, two shimmer timings,
		// Matrix seed, background-style choice, spinner choice
		const values = [0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.25, stylePick, 0.1];
		let index = 0;
		Math.random = () => values[index++] ?? 0.5;
		Date.now = () => 0;
		await call("agent_start", { type: "agent_start" });
		indicator = new WorkingStatusIndicator({ requestRender() {} }, workingMessage, workingIndicator);
		interactiveModePrototype.showStatusIndicator.call({
			activeStatusIndicator: undefined,
			statusContainer: { clear() {}, addChild() {} },
		}, indicator);
	};

	await runCommand("matrix", "status");
	await runCommand("working-animation", "status");
	assert.deepEqual(
		notifications.slice(-2).map((item) => item.message),
		["Matrix rain is off (waiting for /working-animation on)", "Working animation is off; Matrix rain is off"],
		"animations default to disabled",
	);
	await runCommand("working-animation", "on");
	await runCommand("matrix", "on");

	// Breathe reaches both endpoints: true black and the Void Agent prompt gray.
	await startStyle(0);
	Date.now = () => 1_400; // midpoint random period is 2,800ms; half-period is the gray peak
	let lines = indicator.render(60);
	assert.ok(lines.slice(1).every((line) => visibleWidth(line) === 60), "every painted row fills the width");
	assert.ok(lines.join("\n").includes("\x1b[48;2;55;55;57m"), "animation reaches userMessageBg #373739");
	const matrixFrames = [];
	for (let t = 0; t <= 1_800; t += 200) {
		Date.now = () => t;
		matrixFrames.push(indicator.render(60).join("\n"));
	}
	assert.ok(
		matrixFrames.some((frame) => /[ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿ]/u.test(frame) && frame.includes("\x1b[38;2;171;223;167m")),
		"Matrix rain renders bright green one-cell glyphs over the background",
	);
	const plainMatrixFrames = matrixFrames.map((frame) => frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
	assert.ok(new Set(plainMatrixFrames).size > 1, "Matrix glyph positions and characters animate over time");
	Date.now = () => 2_800;
	lines = indicator.render(60);
	assert.ok(lines.join("\n").includes("\x1b[48;2;0;0;0m"), "animation reaches black");
	indicator.dispose();
	await call("agent_settled", { type: "agent_settled" });

	// Aurora must retain a per-column runway after Pi's Text renderer pads the
	// source row. This catches the bug where textWidth was always the full width.
	await startStyle(0.3);
	Date.now = () => 1_000;
	lines = indicator.render(60);
	assert.equal(lines.length, 4, "leading spacer plus three-line background block");
	const backgrounds = lines[2].match(/\x1b\[48;2;\d+;\d+;\d+m/g) ?? [];
	assert.ok(new Set(backgrounds).size > 2, "content row keeps an animated per-column runway");
	assert.equal(visibleWidth(lines[2]), 60, "content row stays within the render width");

	// Long stats wrap inside Pi's Text renderer before the patch runs. Collapse
	// those source rows back to one truncated content row so the block remains
	// exactly three painted lines even in a narrow terminal.
	await call("message_update", {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "x".repeat(250_000) }] },
	});
	lines = indicator.render(30);
	assert.equal(lines.length, 4, "narrow status keeps one spacer plus a three-line block");
	assert.ok(lines.slice(1).every((line) => visibleWidth(line) === 30), "narrow painted rows fit the width");

	// The independent Matrix switch removes only character rain. The master
	// working-animation switch restores Pi's standard single-row loader and can
	// rebuild the animated block immediately when re-enabled.
	await runCommand("matrix", "off");
	lines = indicator.render(60);
	assert.equal(lines.length, 4, "/matrix off keeps the animated background block");
	assert.ok(!lines.join("\n").includes("\x1b[38;2;171;223;167m"), "/matrix off removes bright rain glyphs");
	await runCommand("working-animation", "off");
	lines = indicator.render(60);
	assert.equal(lines.length, 2, "/working-animation off restores the standard loader geometry");
	await runCommand("working-animation", "on");
	lines = indicator.render(60);
	assert.equal(lines.length, 4, "/working-animation on restores the three-line animated block");
	await runCommand("matrix", "on");
	const restoredMatrixFrames = [];
	for (let t = 0; t <= 1_800; t += 200) {
		Date.now = () => 1_000 + t;
		restoredMatrixFrames.push(indicator.render(60).join("\n"));
	}
	assert.ok(
		restoredMatrixFrames.some((frame) => frame.includes("\x1b[38;2;171;223;167m")),
		"/matrix on restores green rain glyphs",
	);

	await runCommand("matrix", "status");
	await runCommand("working-animation", "status");
	assert.deepEqual(
		notifications.slice(-2).map((item) => item.message),
		["Matrix rain is on", "Working animation is on; Matrix rain is on"],
		"status commands report both settings",
	);
	await runCommand("matrix", "");
	assert.equal(
		JSON.parse(readFileSync(join(scratch, "void-agent.json"), "utf8")).matrix,
		false,
		"/matrix with no argument toggles rain off",
	);
	await runCommand("matrix", "");
	await runCommand("working-animation", "");
	assert.equal(indicator.render(60).length, 2, "/working-animation with no argument toggles the block off");
	await runCommand("working-animation", "");
	assert.equal(indicator.render(60).length, 4, "a second no-argument toggle restores the block");
	assert.deepEqual(
		JSON.parse(readFileSync(join(scratch, "void-agent.json"), "utf8")),
		{ workingAnimation: true, matrix: true, themeInitialized: false },
		"animation command settings persist",
	);

	const notificationCount = notifications.length;
	await call("session_start", { type: "session_start", reason: "startup" });
	assert.deepEqual(
		notifications.slice(notificationCount),
		[],
		"supported Pi versions install both renderer patches without warnings",
	);

	indicator.dispose();
	await call("agent_settled", { type: "agent_settled" });
	await call("session_shutdown", { type: "session_shutdown" });
	assert.equal(
		interactiveModePrototype.showStatusIndicator,
		originalShowStatusIndicator,
		"standalone-safe InteractiveMode patch restores on shutdown",
	);

	console.log("working background ok — exported host patch, animation commands, persistence, Matrix rain, colors, and layout");
} finally {
	indicator?.dispose();
	if (ctx && handlers) {
		for (const handler of handlers.get("agent_settled") ?? []) {
			try { await handler({ type: "agent_settled" }, ctx); } catch { /* cleanup only */ }
		}
	}
	if (interactiveModePrototype && originalShowStatusIndicator) {
		interactiveModePrototype.showStatusIndicator = originalShowStatusIndicator;
		delete interactiveModePrototype[Symbol.for("void-agent.working-host-patch")];
	}
	Math.random = originalRandom;
	Date.now = originalNow;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(scratch, { recursive: true, force: true });
}
