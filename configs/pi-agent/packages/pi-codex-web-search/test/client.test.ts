import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	buildCodexEnvironment,
	runCodexWebSearch,
	type RunCodexWebSearchOptions,
} from "../extensions/codex-web-search/client.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

function fakeOptions(mode = "success"): RunCodexWebSearchOptions {
	return {
		command: process.execPath,
		appServerArgs: [fixturePath],
		timeoutMs: 2_000,
		env: { ...process.env, FAKE_CODEX_MODE: mode },
	};
}

test("selects a dedicated Codex home and honors only the web-search override", () => {
	assert.equal(
		buildCodexEnvironment({ HOME: "/test-home" }).CODEX_HOME,
		join("/test-home", ".codex", "web-search"),
	);
	assert.equal(
		buildCodexEnvironment({ USERPROFILE: "/test-profile" }).CODEX_HOME,
		join("/test-profile", ".codex", "web-search"),
	);
	assert.equal(
		buildCodexEnvironment({ HOME: "/test-home", CODEX_HOME: "/profiles/codex" }).CODEX_HOME,
		join("/test-home", ".codex", "web-search"),
	);
	assert.equal(
		buildCodexEnvironment({
			HOME: "/test-home",
			CODEX_HOME: "/profiles/codex",
			PI_CODEX_WEB_SEARCH_HOME: "/profiles/web-search",
		}).CODEX_HOME,
		"/profiles/web-search",
	);
});

test("runs an isolated Codex search and normalizes structured sources", async () => {
	const progress: Array<{ message: string; sources: string[] }> = [];
	const result = await runCodexWebSearch("What is current?", {
		...fakeOptions(),
		onProgress: (message, sources) => progress.push({
			message,
			sources: sources.map((source) => source.url),
		}),
	});

	assert.match(result.answer, /current answer/);
	assert.deepEqual(result.sources, [
		{
			title: "Primary source",
			url: "https://example.com/primary",
			provenance: "retrieved",
			snippet: "Primary evidence",
		},
		{
			title: "Secondary source",
			url: "https://example.org/secondary",
			provenance: "reported",
		},
	]);
	assert.deepEqual(progress, [
		{ message: "Searching the web with Codex…", sources: [] },
		{ message: "Codex completed 1 web search…", sources: ["https://example.com/primary"] },
	]);
});

test("preserves a plain-text answer when an older Codex ignores outputSchema", async () => {
	const result = await runCodexWebSearch("Use the fallback", fakeOptions("plain"));

	assert.match(result.answer, /^A plain fallback answer/);
	assert.deepEqual(result.sources.map((source) => source.url), [
		"https://example.com/primary",
		"https://example.org/secondary",
	]);
});

test("requires a Codex version with the verified isolation protocol", async () => {
	await assert.rejects(
		runCodexWebSearch("Old Codex", fakeOptions("old-version")),
		/requires Codex 0\.145\.0 or newer/,
	);
});

test("requires a ChatGPT-backed Codex login", async () => {
	await assert.rejects(
		runCodexWebSearch("Search while logged out", fakeOptions("logged-out")),
		/Codex web search requires a ChatGPT Codex login/,
	);
	await assert.rejects(
		runCodexWebSearch("Search with a personal access token", fakeOptions("personal-access-token")),
		/Codex web search requires a ChatGPT Codex login/,
	);
});

test("refuses inherited Codex tool configuration and instruction sources", async () => {
	await assert.rejects(
		runCodexWebSearch("Configured MCP", fakeOptions("risky-config")),
		/refused inherited MCP, hook, plugin, app, skill, or instruction configuration/,
	);
	await assert.rejects(
		runCodexWebSearch("Global instructions", fakeOptions("inherited-instructions")),
		/refused inherited instruction sources/,
	);
});

test("fails closed when Codex reports a non-search item", async () => {
	await assert.rejects(
		runCodexWebSearch("Try a forbidden tool", fakeOptions("forbidden")),
		/forbidden non-search item: commandExecution/,
	);
});

test("handles a forbidden notification that arrives before the turn/start response", async () => {
	await assert.rejects(
		runCodexWebSearch("Trigger the early race", fakeOptions("early-forbidden")),
		/forbidden non-search item: commandExecution/,
	);
});

test("validates the turn/start id even when a successful turn completes first", async () => {
	const result = await runCodexWebSearch("Complete before start response", fakeOptions("early-success"));
	assert.match(result.answer, /current answer/);

	await assert.rejects(
		runCodexWebSearch("Reject mismatched start response", fakeOptions("early-success-wrong-start")),
		/turn\/start returned an unexpected turn id/,
	);
});

test("rejects every known non-search family and unknown future items", async () => {
	const cases = [
		["unknown-item", "futureExecutableTool"],
		["collab-item", "collabAgentToolCall"],
		["dynamic-item", "dynamicToolCall"],
		["image-item", "imageGeneration"],
		["sleep-item", "sleep"],
	] as const;
	for (const [mode, itemType] of cases) {
		await assert.rejects(
			runCodexWebSearch(`Reject ${itemType}`, fakeOptions(mode)),
			new RegExp(`forbidden non-search item: ${itemType}`),
		);
	}
});

test("rejects events without the exact thread and turn ids", async () => {
	await assert.rejects(
		runCodexWebSearch("Missing thread", fakeOptions("missing-thread")),
		/without the expected thread id/,
	);
	await assert.rejects(
		runCodexWebSearch("Wrong turn", fakeOptions("wrong-turn")),
		/unexpected turn id/,
	);
});

test("rejects unexpected server-initiated requests", async () => {
	await assert.rejects(
		runCodexWebSearch("Unexpected approval", fakeOptions("server-request")),
		/unsupported server request: item\/permissions\/requestApproval/,
	);
});

test("requires an actual web search and at least one public source URL", async () => {
	await assert.rejects(
		runCodexWebSearch("Skip the search", fakeOptions("no-search")),
		/without using native web search/,
	);
	await assert.rejects(
		runCodexWebSearch("Return no citations", fakeOptions("no-source")),
		/without source URLs/,
	);
});

test("turns malformed structured output and progress callback errors into rejections", async () => {
	await assert.rejects(
		runCodexWebSearch("Blank structured answer", fakeOptions("whitespace-answer")),
		/empty web-search answer/,
	);
	await assert.rejects(
		runCodexWebSearch("Throw from progress", {
			...fakeOptions(),
			onProgress() {
				throw new Error("progress failed");
			},
		}),
		/progress failed/,
	);
});

test("fails promptly on malformed and oversized JSON-RPC records", async () => {
	await assert.rejects(
		runCodexWebSearch("Malformed protocol", fakeOptions("malformed-json")),
		/emitted malformed JSON/,
	);
	await assert.rejects(
		runCodexWebSearch("Oversized protocol", fakeOptions("oversized-json")),
		/oversized protocol message/,
	);
});

test("terminates a stalled Codex search at the configured timeout", async () => {
	await assert.rejects(
		runCodexWebSearch("Never finishes", { ...fakeOptions("hang"), timeoutMs: 75 }),
		/timed out after 75ms/,
	);
});

test("waits for a SIGTERM-resistant subprocess to be killed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-web-search-test-"));
	const pidFile = join(directory, "pid");
	try {
		const controller = new AbortController();
		const options = fakeOptions("stubborn-hang");
		options.signal = controller.signal;
		options.env = { ...options.env, FAKE_CODEX_PID_FILE: pidFile };
		const running = runCodexWebSearch("Force process cleanup", options);

		let pid = 0;
		for (let attempt = 0; attempt < 100 && !pid; attempt++) {
			try {
				pid = Number(await readFile(pidFile, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		assert.ok(pid > 0, "fake Codex process did not publish its pid");
		controller.abort();
		await assert.rejects(running, /web search cancelled/);
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("honors cancellation before startup and during a running search", async () => {
	const preCancelled = new AbortController();
	preCancelled.abort();
	await assert.rejects(
		runCodexWebSearch("Never starts", { ...fakeOptions(), signal: preCancelled.signal }),
		/web search cancelled/,
	);

	const active = new AbortController();
	const running = runCodexWebSearch("Cancel while running", {
		...fakeOptions("hang"),
		signal: active.signal,
	});
	setTimeout(() => active.abort(), 40);
	await assert.rejects(running, /web search cancelled/);
});

test("reports a missing Codex executable without reading credential files", async () => {
	await assert.rejects(
		runCodexWebSearch("Cannot start", {
			command: "/definitely/not/a/codex-executable",
			timeoutMs: 500,
		}),
		/Codex CLI was not found/,
	);
});

test("rejects empty and oversized queries before starting Codex", async () => {
	await assert.rejects(runCodexWebSearch("   "), /cannot be empty/);
	await assert.rejects(runCodexWebSearch("x".repeat(4_001)), /exceeds 4000 characters/);
});
