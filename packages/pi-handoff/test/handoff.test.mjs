#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "extensions", "handoff", "index.ts");
const CORE = join(HERE, "..", "extensions", "handoff", "core.ts");
const helpers = await import(pathToFileURL(CORE).href);

function userEntry(id, content) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	};
}

test("handoff keeps only the latest compaction summary and retained tail", () => {
	const branch = [
		userEntry("old", "discarded history"),
		userEntry("kept", "retained context"),
		{
			type: "compaction",
			id: "compact",
			parentId: "kept",
			timestamp: "2026-01-01T00:01:00.000Z",
			summary: "summary of old history",
			firstKeptEntryId: "kept",
			tokensBefore: 100_000,
		},
		userEntry("new", "recent context"),
	];

	const messages = helpers.getHandoffMessages(branch);

	assert.deepEqual(messages.map((message) => message.role), ["compactionSummary", "user", "user"]);
	assert.equal(messages[0].summary, "summary of old history");
	assert.equal(messages[1].content, "retained context");
	assert.equal(messages[2].content, "recent context");
});

test("handoff preserves prior custom handoff context", () => {
	const messages = helpers.getHandoffMessages([
		{
			type: "custom_message",
			id: "handoff",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "handoff",
			content: "Prior handoff summary",
			display: true,
		},
	]);

	assert.equal(messages.length, 1);
	assert.equal(messages[0].role, "user");
	assert.equal(messages[0].content[0].text, "Prior handoff summary");
});

test("optional focus is omitted when blank", () => {
	assert.equal(
		helpers.buildSummaryPrompt("conversation", ""),
		"## Conversation transcript\n\nconversation",
	);
	assert.match(helpers.buildSummaryPrompt("conversation", "fix auth"), /Requested focus[\s\S]*fix auth/);
});

test("session names are bounded", () => {
	assert.equal(helpers.buildSessionName(undefined), "Handoff");
	assert.ok(helpers.buildSessionName("x".repeat(100)).length <= 80);
});

test("summary input estimate uses Pi's four-characters-per-token heuristic", () => {
	assert.equal(helpers.estimateSummaryInputTokens("12345", "123456789"), 5);
});

test("generation status shows the estimated input and output limit", () => {
	assert.equal(
		helpers.buildGenerationStatus("gpt-test", 12_345, 6_000),
		"Generating handoff summary with gpt-test... · Estimated input: ~12k tokens · output limit: 6.0k",
	);
});

test("usage notice includes cache tokens in the reported total", () => {
	assert.equal(
		helpers.buildUsageNotice({
			input: 10_000,
			output: 500,
			cacheRead: 2_000,
			cacheWrite: 100,
			totalTokens: 12_600,
		}),
		"Handoff summary used 10,000 input + 2,000 cache read + 100 cache write + 500 output = 12,600 tokens.",
	);
});

test("usage notice calculates a total when the provider omits one", () => {
	assert.match(
		helpers.buildUsageNotice({ input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
		/= 1,200 tokens\.$/,
	);
});

test("extension loads and passes offline lifecycle checks in the installed Pi runtime", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-handoff-test-agent-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const child = spawn(
		process.env.PI_BIN ?? "pi",
		[
			"--mode", "rpc",
			"--no-session",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-e", EXTENSION,
			"-e", join(HERE, "fixtures", "runtime-check.ts"),
		],
		{
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const rpc = await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let buffer = "";
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error(`Runtime checks timed out: ${stdout}\n${stderr}`));
		}, 15_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			buffer += chunk;
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				try {
					const record = JSON.parse(line);
					if (record.id === "regression-check" || record.type === "extension_error") child.stdin.end();
				} catch (error) {
					clearTimeout(timeout);
					child.kill();
					reject(error);
				}
			}
		});
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => {
			clearTimeout(timeout);
			resolve({ error, stdout, stderr });
		});
		child.once("close", (status) => {
			clearTimeout(timeout);
			resolve({ status, stdout, stderr });
		});
		child.once("spawn", () => {
			child.stdin.write([
				'{"id":"load-check","type":"get_state"}',
				'{"id":"command-check","type":"get_commands"}',
				'{"id":"regression-check","type":"prompt","message":"/handoff-regression-check"}',
				"",
			].join("\n"));
		});
	});
	if (rpc.error?.code === "ENOENT") {
		t.skip("Pi executable not found; set PI_BIN to run the runtime load test.");
		return;
	}
	assert.ifError(rpc.error);
	assert.equal(rpc.status, 0, rpc.stderr || rpc.stdout);

	const records = rpc.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	assert.equal(records.find((record) => record.id === "load-check")?.success, true);
	assert.equal(records.some((record) => record.type === "extension_error"), false, rpc.stdout);
	assert.ok(records.find((record) => record.id === "command-check")?.data.commands.some(
		(command) => command.name === "handoff",
	), rpc.stdout);
	assert.ok(records.some((record) => record.type === "extension_ui_request"
		&& record.method === "notify" && record.message === "Handoff regression checks passed"), rpc.stdout);
	assert.equal(records.find((record) => record.id === "regression-check")?.success, true, rpc.stdout);
});
