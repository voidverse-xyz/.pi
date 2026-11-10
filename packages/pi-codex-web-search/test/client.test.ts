import assert from "node:assert/strict";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	buildCodexEnvironment,
	prepareIsolatedCodexHome,
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

test("builds a minimal Codex environment and honors login-source overrides", () => {
	const environment = buildCodexEnvironment({
		HOME: "/test-home",
		PATH: "/bin",
		PI_OFFLINE: "1",
		SECRET_TOKEN: "secret",
	});
	assert.equal(environment.CODEX_HOME, join("/test-home", ".codex"));
	assert.equal(environment.PATH, "/bin");
	assert.equal(environment.PI_OFFLINE, undefined);
	assert.equal(environment.SECRET_TOKEN, undefined);

	assert.equal(
		buildCodexEnvironment({ USERPROFILE: "/windows-user" }, undefined, "win32").CODEX_HOME,
		join("/windows-user", ".codex"),
	);
	assert.equal(
		buildCodexEnvironment({ HOME: "/test-home", USERPROFILE: "/windows-user" }, undefined, "win32").CODEX_HOME,
		join("/windows-user", ".codex"),
	);
	assert.equal(
		buildCodexEnvironment({ HOME: "/test-home", USERPROFILE: "/windows-user" }, undefined, "linux").CODEX_HOME,
		join("/test-home", ".codex"),
	);
	assert.equal(
		buildCodexEnvironment({
			HOME: "/test-home",
			USERPROFILE: "/windows-user",
			CODEX_HOME: "/profiles/codex",
		}, undefined, "win32").CODEX_HOME,
		"/profiles/codex",
	);
	assert.equal(
		buildCodexEnvironment({
			HOME: "/test-home",
			USERPROFILE: "/windows-user",
			CODEX_HOME: "/profiles/codex",
			PI_CODEX_WEB_SEARCH_HOME: "/profiles/web-search",
		}, undefined, "win32").CODEX_HOME,
		"/profiles/web-search",
	);

	const isolated = buildCodexEnvironment({
		HOME: "/real-home",
		XDG_CONFIG_HOME: "/real-config",
		APPDATA: "/real-app-data",
		PATH: "/bin",
	}, "/isolated-codex-home");
	assert.equal(isolated.HOME, "/isolated-codex-home");
	assert.equal(isolated.CODEX_HOME, "/isolated-codex-home");
	assert.equal(isolated.XDG_CONFIG_HOME, join("/isolated-codex-home", "xdg-config"));
	assert.equal(isolated.APPDATA, join("/isolated-codex-home", "app-data"));
	assert.equal(isolated.PATH, "/bin");
});

test("discovers the Windows login from USERPROFILE before HOME", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-search-userprofile-test-"));
	const home = join(root, "home");
	const userProfile = join(root, "profile");
	const sourceHome = join(userProfile, ".codex");
	const tempRoot = join(root, "temporary");
	await Promise.all([
		mkdir(sourceHome, { recursive: true }),
		mkdir(tempRoot, { recursive: true }),
	]);
	await writeFile(join(sourceHome, "auth.json"), "test authentication material", { mode: 0o600 });
	try {
		const isolatedHome = await prepareIsolatedCodexHome({ HOME: home, USERPROFILE: userProfile }, tempRoot, "win32");
		assert.equal(await readFile(join(isolatedHome, "auth.json"), "utf8"), "test authentication material");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports missing Windows login material before creating runtime state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-search-missing-login-test-"));
	try {
		await assert.rejects(
			runCodexWebSearch("Fail before startup", {
				command: "should-not-run",
				sourceEnvironment: { USERPROFILE: join(root, "profile") },
				platform: "win32",
			}),
			/Codex web search requires a ChatGPT Codex login\. Run `codex login` first\./,
		);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("creates a clean temporary Codex home backed by the existing login", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-search-codex-home-test-"));
	const sourceHome = join(root, "source");
	const tempRoot = join(root, "temporary");
	await Promise.all([
		mkdir(sourceHome, { recursive: true }),
		mkdir(tempRoot, { recursive: true }),
	]);
	const sourceAuthPath = join(sourceHome, "auth.json");
	await writeFile(sourceAuthPath, "test authentication material", { mode: 0o600 });
	await writeFile(join(sourceHome, "config.toml"), "[mcp_servers.unsafe]", { mode: 0o600 });
	try {
		const isolatedHome = await prepareIsolatedCodexHome({ CODEX_HOME: sourceHome }, tempRoot);
		const isolatedEntries = await readdir(isolatedHome);
		assert.ok(isolatedEntries.includes("auth.json"));
		assert.equal(isolatedEntries.includes("config.toml"), false);
		assert.ok(isolatedEntries.includes("xdg-config"));
		assert.ok(isolatedEntries.includes("tmp"));

		const isolatedAuthPath = join(isolatedHome, "auth.json");
		assert.equal(await readFile(isolatedAuthPath, "utf8"), "test authentication material");
		await writeFile(isolatedAuthPath, "refreshed authentication material");
		assert.equal(await readFile(sourceAuthPath, "utf8"), "refreshed authentication material");
		const isolatedAuth = await lstat(isolatedAuthPath);
		assert.ok(isolatedAuth.isSymbolicLink() || isolatedAuth.isFile());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("keeps injected app-server environments independent of the real login", async () => {
	const result = await runCodexWebSearch("Use the injected server", {
		...fakeOptions(),
		sourceEnvironment: { USERPROFILE: "Z:\\missing-profile" },
		platform: "win32",
	});
	assert.match(result.answer, /current answer/);
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
		/could not establish clean MCP, hook, plugin, app, skill, and instruction configuration/,
	);
	await assert.rejects(
		runCodexWebSearch("Global instructions", fakeOptions("inherited-instructions")),
		/refused unexpected inherited instruction sources/,
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
			env: { PATH: process.env.PATH },
		}),
		/Codex CLI was not found/,
	);
});

test("rejects empty and oversized queries before starting Codex", async () => {
	await assert.rejects(runCodexWebSearch("   "), /cannot be empty/);
	await assert.rejects(runCodexWebSearch("x".repeat(4_001)), /exceeds 4000 characters/);
});
