import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPiPackage } from "../../../tests/runtime.mjs";

const sdk = findPiPackage();
const { loadExtensions } = await import(pathToFileURL(join(sdk, "dist/core/extensions/loader.js")));
const { InteractiveMode } = await import(pathToFileURL(join(sdk, "dist/index.js")));
const extension = fileURLToPath(new URL("../extensions/void-agent/index.ts", import.meta.url));

test("public working indicator retains spinner and stats without background patches", async (t) => {
	const scratch = mkdtempSync(join(tmpdir(), "void-agent-working-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = scratch;
	const configPath = join(scratch, "void-agent.json");
	const legacyConfig = { themeInitialized: true, workingAnimation: true, matrix: true };
	writeFileSync(configPath, JSON.stringify(legacyConfig));
	const originalShowStatusIndicator = InteractiveMode.prototype.showStatusIndicator;
	let now = 0;
	t.mock.method(Date, "now", () => now);
	t.mock.method(Math, "random", () => 0.99);
	t.mock.timers.enable({ apis: ["setInterval"] });
	let handlers;
	const messages = [];
	const indicators = [];
	const notifications = [];
	const ui = {
		theme: { fg: (_color, text) => text },
		setWorkingMessage: message => messages.push(message),
		setWorkingIndicator: options => indicators.push(options),
		setHeader() {}, setEditorComponent() {},
		setTheme() { throw new Error("an existing theme must not be overridden"); },
		notify: message => notifications.push(message),
	};
	const ctx = { mode: "tui", ui };
	const call = async (name, event = {}, context = ctx) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, context);
	};
	try {
		const loaded = await loadExtensions([extension], scratch);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		handlers = loaded.extensions[0].handlers;
		assert.equal(loaded.extensions[0].commands.size, 0, "removed animation commands must not register");
		assert.equal(InteractiveMode.prototype.showStatusIndicator, originalShowStatusIndicator,
			"loading must not intercept the native working renderer");
		await call("session_start");
		assert.ok(!notifications.some(message => message.includes("working-background")));
		assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), legacyConfig,
			"obsolete flags are ignored without rewriting local settings");
		const idleCount = messages.length;
		t.mock.timers.tick(1000);
		assert.equal(messages.length, idleCount, "no idle refresh timer");

		await call("agent_start");
		assert.deepEqual(indicators.at(-1), {
			frames: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"], intervalMs: 120,
		}, "spinner uses Pi's public frames and timing API");
		assert.match(messages.at(-1), /^Assembling… \(0s\)$/);
		assert.ok(!messages.at(-1).includes("tokens"));
		now = 81_089_000;
		t.mock.timers.tick(200);
		assert.match(messages.at(-1), /22h 31m 29s/);
		await call("message_update", { message: {
			role: "assistant", content: [{ type: "text", text: "x".repeat(40) }],
		} });
		assert.match(messages.at(-1), /↓ 10 tokens/);
		await call("message_end", { message: { role: "assistant", usage: { output: 1200 } } });
		await call("message_update", { message: { role: "assistant", usage: { output: 200 } } });
		assert.match(messages.at(-1), /↓ 1\.4k tokens/, "finalized and streaming tokens accumulate");
		await call("agent_start");
		assert.equal(indicators.length, 1, "duplicate start must not replace a live spinner");
		await call("agent_settled");
		assert.equal(messages.at(-1), undefined, "settling restores the default working message");
		const settledCount = messages.length;
		t.mock.timers.tick(1000);
		assert.equal(messages.length, settledCount, "settling stops timer updates");

		await call("agent_start");
		assert.match(messages.at(-1), /\(0s\)$/, "a new run resets elapsed time and tokens");
		await call("session_shutdown");
		assert.equal(indicators.at(-1), undefined, "shutdown restores the default spinner");
		const stoppedCount = messages.length;
		t.mock.timers.tick(1000);
		assert.equal(messages.length, stoppedCount, "shutdown stops live timer updates");
		assert.equal(InteractiveMode.prototype.showStatusIndicator, originalShowStatusIndicator);

		const nonTui = { mode: "print", ui: new Proxy({}, {
			get() { throw new Error("non-TUI lifecycle must not access the UI"); },
		}) };
		for (const name of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) {
			await call(name, {}, nonTui);
		}
	} finally {
		if (handlers) await call("session_shutdown");
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(scratch, { recursive: true, force: true });
	}
});
