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
const longFallback = `Completed ${"a detailed verification step ".repeat(8).trim()}.`;
assert.equal(helpers.summarizeFinalResponse(longFallback), longFallback, "fallback summaries are not hard-truncated");
assert.deepEqual(
	helpers.extractGeneratedSummary("Visible response.\n\n[pi-run-summary]: # \"Generated **outcome** summary.\"\n"),
	{ text: "Visible response.", summary: "Generated outcome summary." },
	"a terminal marker with an ordinary trailing newline is extracted",
);
assert.deepEqual(
	helpers.extractGeneratedSummary("Visible response.\r\n\r\n[pi-run-summary]: # \"CRLF summary.\"\r\n"),
	{ text: "Visible response.", summary: "CRLF summary." },
	"CRLF output is extracted",
);
assert.deepEqual(
	helpers.extractGeneratedSummary("Visible response.\n\n[pi-run-summary]: malformed protocol line\n"),
	{ text: "Visible response." },
	"a malformed reserved marker is scrubbed without becoming the outcome",
);
assert.equal(
	helpers.extractGeneratedSummary("[pi-run-summary]: # \"marker is not terminal\"\nVisible response."),
	undefined,
	"only a terminal marker is consumed",
);

const { Markdown } = await import(join(
	PI_PACKAGE,
	"node_modules",
	"@earendil-works",
	"pi-tui",
	"dist",
	"components",
	"markdown.js",
));
const passthroughTheme = new Proxy({}, { get: () => (text) => text });
const renderedMarker = new Markdown(
	"Visible response.\n\n[pi-run-summary]: # \"Generated outcome summary.\"",
	0,
	0,
	passthroughTheme,
).render(80).join("\n");
assert.doesNotMatch(renderedMarker, /pi-run-summary|Generated outcome/u, "Pi's Markdown renderer hides the marker");

const { loadExtensions } = await import(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js"));
const loaded = await loadExtensions([EXTENSION], process.cwd());
assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);
assert.equal(loaded.extensions.length, 1, "exactly one extension loads");

const handlers = loaded.extensions[0].handlers;
assert.deepEqual(
	[...handlers.keys()],
	["before_agent_start", "agent_start", "message_end", "agent_end", "agent_settled", "session_shutdown"],
	"extension registers only the required lifecycle handlers",
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
const assistant = (text, input, output, stopReason = "stop", cacheRead = 0, cacheWrite = 0) => ({
	role: "assistant",
	content: text ? [{ type: "text", text }] : [],
	usage: { input, output, cacheRead, cacheWrite },
	stopReason,
});
const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 5));
const finishMessage = async (message) => {
	const transformed = await call("message_end", { message });
	return transformed?.message ?? message;
};

const originalNow = Date.now;
try {
	const promptUpdate = await call("before_agent_start", { systemPrompt: "Base system prompt" });
	assert.match(promptUpdate.systemPrompt, /\[pi-run-summary\]: # "SUMMARY"/u, "the TUI prompt requests a summary marker");
	assert.match(promptUpdate.systemPrompt, /^Base system prompt/u, "the existing system prompt is preserved");

	Date.now = () => 1_000;
	await call("agent_start");
	await call("agent_end", {
		messages: [assistant("I will inspect the project.", 800, 200, "toolUse", 9_000, 100)],
	});
	await call("agent_start"); // retry/continuation must not reset elapsed time or usage
	const firstCandidate = assistant("", 1_950, 250);
	firstCandidate.content = [
		{ type: "thinking", thinking: "Preserve non-text content." },
		{ type: "text", text: "## Completed\n\n- Implemented **run summaries**." },
		{ type: "text", text: "More detail follows.\n\n[pi-run-summary]: # \"Implemented the requested completion summary.\"" },
	];
	const firstFinal = await finishMessage(firstCandidate);
	assert.deepEqual(
		firstFinal.content,
		[
			{ type: "thinking", thinking: "Preserve non-text content." },
			{ type: "text", text: "## Completed\n\n- Implemented **run summaries**." },
			{ type: "text", text: "More detail follows." },
		],
		"the marker is removed from the last text part without changing other content",
	);
	await call("agent_end", { messages: [firstFinal] });

	idle = false;
	Date.now = () => 30_000;
	await call("agent_settled");
	await flushTimers();
	assert.equal(notifications.length, 0, "a non-idle settled boundary postpones the toast");

	idle = true;
	await call("agent_settled");
	Date.now = () => 30_001;
	await call("agent_start");
	const latestFinal = await finishMessage(assistant(
		"Finished verification. Tests pass.\n\n[pi-run-summary]: # \"Verified the completion-summary lifecycle.\"\n",
		250,
		50,
	));
	await call("agent_end", { messages: [latestFinal] });
	await flushTimers();
	assert.equal(notifications.length, 0, "agent_start cancels deferred finalization");

	Date.now = () => 66_500;
	await call("agent_settled");
	await flushTimers();
	assert.deepEqual(notifications, [
		{
			message: "<muted>• Verified the completion-summary lifecycle.</muted>\n<dim>   3.0k ·  500 ·  1m 5s</dim>",
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
		"<muted>• The agent run was stopped.</muted>\n<dim>   15 ·  1 ·  <1s</dim>",
		"an empty final response clears stale prose and uses the stop-reason fallback",
	);

	Date.now = () => 125_000;
	await call("agent_start");
	const staleFinal = await finishMessage(assistant(
		"An earlier final response.\n\n[pi-run-summary]: # \"This outcome must not remain stale.\"\n",
		10,
		2,
	));
	await call("agent_end", { messages: [staleFinal] });
	await call("agent_start");
	const unmarkedFinal = await finishMessage(assistant("Latest answer wins. Extra detail follows.", 15, 3));
	await call("agent_end", { messages: [unmarkedFinal] });
	Date.now = () => 126_000;
	await call("agent_settled");
	await flushTimers();
	assert.equal(
		notifications.at(-1).message,
		"<muted>• Latest answer wins.</muted>\n<dim>   25 ·  5 ·  1s</dim>",
		"a later unmarked response clears an earlier generated summary",
	);

	Date.now = () => 130_000;
	await call("agent_start");
	const answeredFinal = await finishMessage(assistant(
		"Answered the request.\n\n[pi-run-summary]: # \"Answered without using the terminating tool preamble.\"",
		20,
		4,
	));
	await call("agent_end", { messages: [answeredFinal] });
	await call("agent_start");
	const terminatingToolTurn = await finishMessage(assistant(
		"I am now invoking the terminating tool.\n\n[pi-run-summary]: # \"Incorrect tool-turn outcome.\"",
		8,
		2,
		"toolUse",
	));
	await call("agent_end", { messages: [terminatingToolTurn] });
	Date.now = () => 131_000;
	await call("agent_settled");
	await flushTimers();
	assert.equal(
		notifications.at(-1).message,
		"<muted>• Answered without using the terminating tool preamble.</muted>\n<dim>   28 ·  6 ·  1s</dim>",
		"a terminating tool turn cannot replace the latest non-tool outcome",
	);

	for (const mode of ["rpc", "json", "print"]) {
		ctx.mode = mode;
		assert.equal(
			await call("before_agent_start", { systemPrompt: "Base system prompt" }),
			undefined,
			`${mode} mode does not request a generated summary`,
		);
		Date.now = () => 150_000;
		await call("agent_start");
		await call("agent_end", { messages: [assistant("Hidden outside the TUI.", 10, 2)] });
		Date.now = () => 151_000;
		await call("agent_settled");
		await flushTimers();
	}
	ctx.mode = "tui";
	assert.equal(notifications.length, 4, "RPC, JSON, and print modes do not emit completion notifications");

	Date.now = () => 200_000;
	await call("agent_start");
	await call("agent_end", { messages: [assistant("This toast must be cancelled.", 10, 2)] });
	await call("agent_settled");
	await call("session_shutdown");
	await flushTimers();
	assert.equal(notifications.length, 4, "session shutdown cancels a pending toast and discards run state");
} finally {
	Date.now = originalNow;
}

console.log("run summary ok — prompt protocol, marker stripping, lifecycle, two-line telemetry, and fallback");
