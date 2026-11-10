import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEventBus, getAgentDir } from "@earendil-works/pi-coding-agent";

// Factory config/audit I/O is confined to this disposable fixture, never user settings.
const directory = mkdtempSync(join(tmpdir(), "pi-safety-test-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
assert.equal(getAgentDir(), directory);
const { default: safetyExtension, SWARM_CONFIRM_TIMEOUT_MS } = await import("../extensions/safety/index.ts");
after(() => {
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	rmSync(directory, { recursive: true, force: true });
});
const flush = () => new Promise(setImmediate);

function harness(mode = "max", uiMode = "tui") {
	writeFileSync(join(directory, "safety.json"), JSON.stringify({ mode, gateWrites: false }));
	const handlers = new Map();
	const commands = new Map();
	const registrations = [];
	const bus = createEventBus();
	const dialogs = [];
	let maxActive = 0;
	const main = new AbortController();
	const ctx = {
		mode: uiMode, hasUI: uiMode === "tui" || uiMode === "rpc", signal: main.signal,
		ui: {
			theme: { fg: (_color, value) => value }, setStatus() {}, notify() {},
			custom(factory) {
				return new Promise((resolve) => {
					const dialog = { closed: false };
					dialog.component = factory({ requestRender() {} }, {}, {}, (value) => {
						dialog.closed = true;
						dialog.component?.dispose();
						resolve(value);
					});
					if (dialog.closed) dialog.component.dispose();
					dialogs.push(dialog);
					maxActive = Math.max(maxActive, dialogs.filter((item) => !item.closed).length);
				});
			},
		},
	};
	safetyExtension({
		on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		registerCommand(name, value) { commands.set(name, value); },
		events: { on(name, fn) { registrations.push(name); return bus.on(name, fn); } },
	});
	const event = async (name, context = ctx) => {
		for (const handler of handlers.get(name) ?? []) await handler({}, context);
	};
	const claim = (request, channel = "swarm:confirm-request") => {
		let provider;
		bus.emit(channel, { method: "confirm", request, claim(fn) { provider = fn; } });
		return provider;
	};
	return { ctx, main, dialogs, handlers, commands, bus, registrations, event, claim, get maxActive() { return maxActive; } };
}

const request = (overrides = {}) => ({ agent: "worker", tool: "bash", command: "unknown-operation", signal: new AbortController().signal, ...overrides });
async function start(h) { await h.event("session_start"); }

test("all legacy channels remain registered with existing read-only and file policies", async () => {
	const h = harness();
	await start(h);
	assert.deepEqual(h.registrations, ["teams:confirm-request", "subagents:confirm-request", "procedure:confirm-request", "swarm:confirm-request"]);
	for (const channel of h.registrations.slice(0, 3)) {
		const read = { tool: "bash", command: "git status" };
		assert.equal((await h.claim(read, channel)(read)).approved, true);
		const edit = { tool: "edit", path: "file.txt" };
		const result = h.claim(edit, channel)(edit);
		await flush();
		h.dialogs.at(-1).component.handleInput("y");
		assert.equal((await result).approved, true);
	}
	assert.equal(h.maxActive, 1);
});

test("Swarm remains unclaimed before start, after shutdown, and outside live TUI", async () => {
	for (const mode of ["tui", "rpc", "print", "json"]) {
		const h = harness("max", mode);
		assert.equal(h.claim(request()), undefined);
		await start(h);
		if (mode !== "tui") assert.equal(h.claim(request()), undefined);
		await h.event("session_shutdown");
		assert.equal(h.claim(request()), undefined);
	}
});

test("malformed Swarm requests deny without throwing or displaying UI", async () => {
	const h = harness();
	await start(h);
	for (const value of [null, undefined, {}, request({ tool: "read" }), request({ signal: undefined }), request({ signal: {} }), request({ command: "  " }), request({ command: 7 }), request({ tool: "edit", path: "" }), request({ tool: "write", path: 7 }), request({ agent: {} })]) {
		const provider = h.claim(value);
		assert.equal((await provider(value)).approved, false);
	}
	const valid = request();
	assert.equal((await h.claim(valid)(null)).approved, false);
	const throwing = { get tool() { throw new Error("bad accessor"); } };
	assert.equal((await h.claim(valid)(throwing)).approved, false);
	for (const value of [null, 1, {}, { method: "confirm", claim: "invalid" }, { get method() { throw new Error("bad envelope"); } }]) {
		assert.doesNotThrow(() => h.bus.emit("swarm:confirm-request", value));
	}
	assert.equal(h.dialogs.length, 0);
});

test("Swarm preserves off/on/max classifier and write policy independent of main gateWrites", async () => {
	for (const mode of ["off", "on", "max"]) {
		const h = harness(mode);
		await start(h);
		for (const value of [request({ command: "git status" }), request({ tool: "edit", path: "file.txt" }), request({ tool: "write", path: "file.txt" })]) {
			const result = h.claim(value)(value);
			await flush();
			if (mode === "max" && value.tool !== "bash") h.dialogs.at(-1).component.handleInput("y");
			assert.equal((await result).approved, true);
		}
		assert.equal(h.dialogs.length, mode === "max" ? 2 : 0);
		// Main edit gate remains opt-in and unchanged.
		for (const handler of h.handlers.get("tool_call")) {
			assert.equal(await handler({ toolName: "edit", input: { path: "file.txt" } }, h.ctx), undefined);
		}
	}
});

test("pre-canceled calls deny even if policy would auto-allow", async () => {
	const h = harness("off");
	await start(h);
	const value = request({ command: "git status", signal: AbortSignal.abort() });
	assert.equal((await h.claim(value)(value)).approved, false);
	assert.equal(h.dialogs.length, 0);
});

test("Swarm active cancellation and queue cancellation never overlap or inherit main abort", async () => {
	const h = harness();
	await start(h);
	const worker = new AbortController();
	const first = request({ signal: worker.signal });
	const result = h.claim(first)(first);
	await flush();
	h.main.abort();
	assert.equal(h.dialogs[0].closed, false);
	const queuedAbort = new AbortController();
	const queued = request({ signal: queuedAbort.signal });
	const queuedResult = h.claim(queued)(queued);
	const last = request();
	const lastResult = h.claim(last)(last);
	queuedAbort.abort();
	assert.equal((await queuedResult).approved, false);
	assert.equal(h.dialogs.length, 1);
	worker.abort();
	assert.equal((await result).approved, false);
	await flush();
	assert.equal(h.dialogs.length, 2);
	h.dialogs[1].component.handleInput("y");
	assert.equal((await lastResult).approved, true);
	assert.equal(h.maxActive, 1);
});

test("lifecycle replacement, tree change and policy changes revoke active, queued and claimed requests", async () => {
	for (const revoke of ["session_shutdown", "session_start", "session_tree", "policy"]) {
		const h = harness();
		await start(h);
		const value = request();
		const provider = h.claim(value);
		const active = provider(value);
		const queued = provider(value);
		await flush();
		if (revoke === "policy") await h.commands.get("safety").handler("off", h.ctx);
		else await h.event(revoke, revoke === "session_start" ? { ...h.ctx } : h.ctx);
		assert.equal((await active).approved, false, revoke);
		assert.equal((await queued).approved, false, revoke);
		assert.equal((await provider(value)).approved, false, `stale claim: ${revoke}`);
		await flush();
		assert.equal(h.dialogs.length, 1);
		assert.equal(h.dialogs[0].closed, true);
	}
});

test("policy revocation after human approval cannot return stale approval", async () => {
	const h = harness();
	await start(h);
	const value = request();
	const result = h.claim(value)(value);
	await flush();
	h.dialogs[0].component.handleInput("y");
	await h.commands.get("safety").handler("on", h.ctx);
	assert.equal((await result).approved, false);
});

test("direct Swarm callers have a finite maximum timeout including queue time", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness();
	await start(h);
	const value = request();
	const active = h.claim(value)(value);
	const queued = h.claim(value)(value);
	await flush();
	t.mock.timers.tick(SWARM_CONFIRM_TIMEOUT_MS);
	assert.equal((await active).approved, false);
	assert.equal((await queued).approved, false);
	await flush();
	assert.equal(h.dialogs.length, 1);
	assert.equal(h.dialogs[0].closed, true);
});

test("UI errors fail closed and do not poison subsequent confirmations", async () => {
	const h = harness();
	await start(h);
	const custom = h.ctx.ui.custom;
	h.ctx.ui.custom = async () => { throw new Error("UI failed with private details"); };
	const value = request();
	assert.deepEqual(await h.claim(value)(value), { approved: false, note: "confirmation denied" });
	h.ctx.ui.custom = custom;
	const retry = h.claim(value)(value);
	await flush();
	h.dialogs[0].component.handleInput("y");
	assert.equal((await retry).approved, true);
});

test("main-agent and Swarm confirmations share one serial gate", async () => {
	const h = harness();
	await start(h);
	const main = h.handlers.get("tool_call")[0]({ toolName: "bash", input: { command: "unknown-operation" } }, h.ctx);
	const value = request();
	const swarm = h.claim(value)(value);
	await flush();
	assert.equal(h.dialogs.length, 1);
	h.dialogs[0].component.handleInput("y");
	assert.equal(await main, undefined);
	await flush();
	assert.equal(h.dialogs.length, 2);
	h.dialogs[1].component.handleInput("y");
	assert.equal((await swarm).approved, true);
	assert.equal(h.maxActive, 1);
});

test("Swarm audits omit agent labels and command arguments", async () => {
	const h = harness();
	await start(h);
	const value = request({ agent: "private-label-marker", command: "unknown-operation private-argument-marker" });
	const result = h.claim(value)(value);
	await flush();
	h.dialogs[0].component.handleInput("y");
	assert.equal((await result).approved, true);
	const audit = readFileSync(join(directory, "safety-audit.jsonl"), "utf8");
	assert.equal(audit.includes("private-label-marker"), false);
	assert.equal(audit.includes("private-argument-marker"), false);
});
