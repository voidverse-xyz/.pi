#!/usr/bin/env node

import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "extensions", "turn-stats", "index.ts");

const helpers = await import(EXTENSION);

function registerTurnStatsExtension() {
	const handlers = new Map();
	const pi = {
		on(eventName, handler) {
			const eventHandlers = handlers.get(eventName) ?? [];
			eventHandlers.push(handler);
			handlers.set(eventName, eventHandlers);
		},
	};
	helpers.default(pi);
	return handlers;
}

function assistant(input, output, stopReason = "stop", cacheRead = 0, cacheWrite = 0) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ordinary response without hidden protocol data" }],
		usage: { input, output, cacheRead, cacheWrite },
		stopReason,
	};
}

test("formatters and stats builder use compact Pi-style units", () => {
	assert.equal(helpers.formatDuration(500), "<1s");
	assert.equal(helpers.formatDuration(65_500), "1m 5s");
	assert.equal(helpers.formatDuration(3_661_000), "1h 1m 1s");
	assert.equal(helpers.formatTokens(999), "999");
	assert.equal(helpers.formatTokens(3_000), "3.0k");
	assert.deepEqual(
		helpers.buildTurnStats({ startedAt: 1_000, inputTokens: 3_000, outputTokens: 500 }, 66_500),
		{ input: "3.0k", output: "500", elapsed: "1m 5s" },
	);
});

test("renderTurnStats delegates every semantic color to the active theme", () => {
	const theme = {
		fg(color, text) {
			return `<${color}>${text}</${color}>`;
		},
	};
	assert.equal(
		helpers.renderTurnStats({ input: "3.0k", output: "500", elapsed: "1m 5s" }, theme),
		"<dim></dim> <muted>3.0k</muted> <dim>·</dim> <dim></dim> <muted>500</muted> <dim>·</dim> <dim></dim> <muted>1m 5s</muted>",
	);
});

test("summary protocol helpers are absent", () => {
	assert.equal("extractGeneratedSummary" in helpers, false);
	assert.equal("summarizeFinalResponse" in helpers, false);
	assert.equal("buildCompletionNotice" in helpers, false);
});

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

test("lifecycle aggregates one settled user turn and emits theme-aware stats only", async () => {
	const handlers = registerTurnStatsExtension();
	assert.deepEqual(
		[...handlers.keys()],
		["agent_start", "agent_end", "agent_settled", "session_shutdown"],
		"summary prompt and message-rewrite hooks are not registered",
	);

	const notifications = [];
	let idle = true;
	const ctx = {
		mode: "tui",
		isIdle: () => idle,
		ui: {
			theme: {
				fg(color, text) {
					return `<${color}>${text}</${color}>`;
				},
			},
			notify(message, type = "info") {
				notifications.push({ message, type });
			},
		},
	};
	const call = async (eventName, event = {}) => {
		let result;
		for (const handler of handlers.get(eventName) ?? []) {
			result = await handler({ type: eventName, ...event }, ctx);
		}
		return result;
	};

	const originalNow = Date.now;
	try {
		Date.now = () => 1_000;
		await call("agent_start");
		await call("agent_end", { messages: [assistant(800, 200, "toolUse", 9_000, 100)] });
		await call("agent_start");
		await call("agent_end", { messages: [assistant(1_950, 250)] });

		idle = false;
		Date.now = () => 30_000;
		await call("agent_settled");
		assert.equal(notifications.length, 0, "a non-idle settled boundary keeps the accumulator open");

		Date.now = () => 40_000;
		await call("agent_start");
		await call("agent_end", { messages: [assistant(250, 50)] });

		idle = true;
		Date.now = () => 66_500;
		await call("agent_settled");
		assert.deepEqual(notifications, [
			{
				message:
					"<dim></dim> <muted>3.0k</muted> <dim>·</dim> <dim></dim> <muted>500</muted> <dim>·</dim> <dim></dim> <muted>1m 5s</muted>",
				type: "info",
			},
		]);

		for (const mode of ["rpc", "json", "print"]) {
			ctx.mode = mode;
			Date.now = () => 100_000;
			await call("agent_start");
			await call("agent_end", { messages: [assistant(10, 2)] });
			Date.now = () => 101_000;
			await call("agent_settled");
		}
		ctx.mode = "tui";
		assert.equal(notifications.length, 1, "RPC, JSON, and print modes do not emit notifications");

		Date.now = () => 200_000;
		await call("agent_start");
		await call("agent_end", { messages: [assistant(10, 2)] });
		await call("session_shutdown");
		await call("agent_settled");
		assert.equal(notifications.length, 1, "session shutdown discards unfinished turn state");
	} finally {
		Date.now = originalNow;
	}
});
