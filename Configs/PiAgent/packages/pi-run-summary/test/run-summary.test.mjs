#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "extensions", "run-summary", "index.ts");

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
const helpers = await import(EXTENSION);

assert.equal(helpers.formatDuration(500), "<1s");
assert.equal(helpers.formatDuration(65_500), "1m 5s");
assert.equal(helpers.formatDuration(3_661_000), "1h 1m 1s");
assert.equal(helpers.formatTokens(999), "999");
assert.equal(helpers.formatTokens(3_000), "3.0k");
assert.equal(
	helpers.summarizeFinalResponse("## Completed\n\n- Implemented **run summaries**. More detail follows."),
	"Implemented run summaries.",
);
assert.equal(
	helpers.summarizeFinalResponse("```ts\nconst ignored = true;\n```\n\nResult:\n\n- Tests pass! Additional detail."),
	"Tests pass!",
);

const { loadExtensions } = await import(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js"));
const loaded = await loadExtensions([EXTENSION], process.cwd());
assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);
assert.equal(loaded.extensions.length, 1, "exactly one extension loads");

const handlers = loaded.extensions[0].handlers;
assert.deepEqual(
	[...handlers.keys()],
	["agent_start", "agent_end", "agent_settled", "session_shutdown"],
	"extension registers only the required lifecycle handlers",
);

const notifications = [];
let idle = true;
const ctx = {
	mode: "tui",
	isIdle: () => idle,
	ui: {
		notify(message, type = "info") {
			notifications.push({ message, type });
		},
	},
};
const call = async (eventName, event = {}) => {
	for (const handler of handlers.get(eventName) ?? []) {
		await handler({ type: eventName, ...event }, ctx);
	}
};
const assistant = (text, input, output, stopReason = "stop", cacheRead = 0, cacheWrite = 0) => ({
	role: "assistant",
	content: text ? [{ type: "text", text }] : [],
	usage: { input, output, cacheRead, cacheWrite },
	stopReason,
});
const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 5));

const originalNow = Date.now;
try {
	Date.now = () => 1_000;
	await call("agent_start");
	await call("agent_end", {
		messages: [assistant("I will inspect the project.", 800, 200, "toolUse", 9_000, 100)],
	});
	await call("agent_start"); // retry/continuation must not reset elapsed time or usage
	await call("agent_end", {
		messages: [assistant("## Completed\n\n- Implemented **run summaries**. More detail follows.", 1_950, 250)],
	});

	idle = false;
	Date.now = () => 30_000;
	await call("agent_settled");
	await flushTimers();
	assert.equal(notifications.length, 0, "a non-idle settled boundary postpones the toast");

	idle = true;
	await call("agent_settled");
	Date.now = () => 30_001;
	await call("agent_start");
	await call("agent_end", { messages: [assistant("Finished verification. Tests pass.", 250, 50)] });
	await flushTimers();
	assert.equal(notifications.length, 0, "agent_start cancels deferred finalization");

	Date.now = () => 66_500;
	await call("agent_settled");
	await flushTimers();
	assert.deepEqual(notifications, [
		{
			message: "• Finished verification. · 1m 5s · ↑3.0k · ↓500",
			type: "info",
		},
	]);

	Date.now = () => 100_000;
	await call("agent_start");
	await call("agent_end", { messages: [assistant("I will keep working.", 5, 1, "toolUse")] });
	await call("agent_start");
	await call("agent_end", { messages: [assistant("", 10, 0, "aborted")] });
	Date.now = () => 100_500;
	await call("agent_settled");
	await flushTimers();
	assert.equal(
		notifications.at(-1).message,
		"• The agent run was stopped. · <1s · ↑15 · ↓1",
		"an empty final response clears stale prose and uses the stop-reason fallback",
	);

	for (const mode of ["rpc", "json", "print"]) {
		ctx.mode = mode;
		Date.now = () => 150_000;
		await call("agent_start");
		await call("agent_end", { messages: [assistant("Hidden outside the TUI.", 10, 2)] });
		Date.now = () => 151_000;
		await call("agent_settled");
		await flushTimers();
	}
	ctx.mode = "tui";
	assert.equal(notifications.length, 2, "RPC, JSON, and print modes do not emit completion notifications");

	Date.now = () => 200_000;
	await call("agent_start");
	await call("agent_end", { messages: [assistant("This toast must be cancelled.", 10, 2)] });
	await call("agent_settled");
	await call("session_shutdown");
	await flushTimers();
	assert.equal(notifications.length, 2, "session shutdown cancels a pending toast and discards run state");
} finally {
	Date.now = originalNow;
}

console.log("run summary ok — lifecycle, idle gating, timing, tokens, summary, and fallback");
