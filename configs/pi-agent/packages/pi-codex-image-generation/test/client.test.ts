import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	buildCodexEnvironment,
	prepareIsolatedCodexHome,
	runCodexImageGeneration,
	type RunCodexImageGenerationOptions,
} from "../extensions/codex-image-generation/client.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mNoAAAAASUVORK5CYII=", "base64");

function fakeOptions(mode = "success", extraEnv: Record<string, string> = {}): RunCodexImageGenerationOptions {
	return {
		command: process.execPath,
		appServerArgs: [fixturePath],
		timeoutMs: 2_000,
		env: { ...process.env, ...extraEnv, FAKE_CODEX_MODE: mode },
	};
}

async function assertTemporaryRootRemoved(requestLog: string): Promise<void> {
	const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const thread = requests.find((request) => request.method === "thread/start");
	assert.ok(thread?.params?.cwd, "thread/start request was not logged");
	await assert.rejects(lstat(dirname(thread.params.cwd)), /ENOENT/);
}

async function waitForLoggedMethod(requestLog: string, method: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const content = await readFile(requestLog, "utf8").catch(() => "");
		if (content.split("\n").some((line) => line.includes(`\"method\":\"${method}\"`))) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${method} in the fake app-server log`);
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const state = stat.match(/^\d+ \(.+\) ([A-Z]) /)?.[1];
			if (state === "Z" || state === "X") return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

test("generates one validated image through an isolated app-server turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-client-test-"));
	const requestLog = join(root, "requests.jsonl");
	try {
		const progress: string[] = [];
		const result = await runCodexImageGeneration("Draw a small blue square", [], {
			...fakeOptions("success", { FAKE_REQUEST_LOG: requestLog }),
			onProgress: (message) => progress.push(message),
		});
		assert.equal(result.mimeType, "image/png");
		assert.equal(result.byteLength, png.length);
		assert.deepEqual(Buffer.from(result.data, "base64"), png);
		assert.equal(result.revisedPrompt, "A revised image prompt");
		assert.match(progress.join("\n"), /Generating image/);

		const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const thread = requests.find((request) => request.method === "thread/start");
		assert.equal(thread.params.ephemeral, true);
		assert.equal(thread.params.sandbox, "read-only");
		assert.deepEqual(thread.params.environments, []);
		assert.deepEqual(thread.params.dynamicTools, []);
		assert.equal(thread.params.config["features.image_generation"], true);
		assert.equal(thread.params.config["features.shell_tool"], false);
		assert.equal(thread.params.config.web_search, "disabled");

		const turn = requests.find((request) => request.method === "turn/start");
		assert.deepEqual(turn.params.input, [{ type: "text", text: "Draw a small blue square", text_elements: [] }]);
		assert.equal(turn.params.sandboxPolicy.type, "readOnly");
		assert.equal(turn.params.sandboxPolicy.networkAccess, false);
		await assertTemporaryRootRemoved(requestLog);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("embeds edit inputs without exposing source paths to the nested turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-input-test-"));
	const source = join(root, "private-project-logo.png");
	const requestLog = join(root, "requests.jsonl");
	await writeFile(source, png);
	try {
		await runCodexImageGeneration("Add a third line", [source], {
			...fakeOptions("success", { FAKE_REQUEST_LOG: requestLog }),
		});
		const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const turn = requests.find((request) => request.method === "turn/start");
		const inputImage = turn.params.input.find((item: any) => item.type === "image");
		assert.match(inputImage.url, /^data:image\/png;base64,/);
		assert.deepEqual(Buffer.from(inputImage.url.split(",", 2)[1], "base64"), png);
		assert.doesNotMatch(JSON.stringify(turn), /private-project-logo/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fails closed on unsupported auth, provider capability, config, instructions, and turn items", async () => {
	const cases: Array<[string, RegExp]> = [
		["old-version", /requires Codex 0\.146\.0/],
		["api-auth", /requires a ChatGPT Codex login/],
		["capability-off", /does not support image generation/],
		["risky-config", /refused enabled external configuration/],
		["instruction-source", /refused inherited instruction sources/],
		["forbidden-item", /forbidden non-image item/],
		["server-request", /unsupported server request/],
		["duplicate-image", /more than one image/],
		["wrong-thread", /expected thread id/],
		["wrong-turn", /unexpected turn id/],
		["no-image", /without using native image generation/],
		["failed-turn", /simulated failure/],
		["failed-item", /item finished with status failed/],
		["bad-base64", /invalid base64/],
	];
	for (const [mode, pattern] of cases) {
		await assert.rejects(runCodexImageGeneration("test image", [], fakeOptions(mode)), pattern, mode);
	}
});

test("honors cancellation and timeout while removing temporary state", async () => {
	const preCancelled = new AbortController();
	preCancelled.abort();
	await assert.rejects(
		runCodexImageGeneration("Never starts", [], { ...fakeOptions(), signal: preCancelled.signal }),
		/image generation cancelled/,
	);

	const root = await mkdtemp(join(tmpdir(), "pi-image-lifecycle-test-"));
	try {
		const cancelLog = join(root, "cancel.jsonl");
		const active = new AbortController();
		const running = runCodexImageGeneration("Cancel while running", [], {
			...fakeOptions("hang", { FAKE_REQUEST_LOG: cancelLog }),
			signal: active.signal,
		});
		await waitForLoggedMethod(cancelLog, "thread/start");
		active.abort();
		await assert.rejects(running, /image generation cancelled/);
		await assertTemporaryRootRemoved(cancelLog);

		const timeoutLog = join(root, "timeout.jsonl");
		await assert.rejects(
			runCodexImageGeneration("Time out", [], {
				...fakeOptions("hang", { FAKE_REQUEST_LOG: timeoutLog }),
				timeoutMs: 1_000,
			}),
			/timed out after 1000ms/,
		);
		await assertTemporaryRootRemoved(timeoutLog);

		const failureLog = join(root, "failure.jsonl");
		await assert.rejects(
			runCodexImageGeneration("Fail", [], fakeOptions("failed-turn", { FAKE_REQUEST_LOG: failureLog })),
			/simulated failure/,
		);
		await assertTemporaryRootRemoved(failureLog);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("kills stubborn same-group descendants before returning success", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-process-group-test-"));
	const childPidFile = join(root, "child.pid");
	const requestLog = join(root, "requests.jsonl");
	try {
		await runCodexImageGeneration("Generate", [], fakeOptions("stubborn-descendant", {
			FAKE_CHILD_PID_FILE: childPidFile,
			FAKE_REQUEST_LOG: requestLog,
		}));
		const childPid = Number(await readFile(childPidFile, "utf8"));
		assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
		assert.equal(await waitForProcessExit(childPid), true, "stubborn descendant remained alive");
		await assertTemporaryRootRemoved(requestLog);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("validates prompt, input count, input size, and input format before network use", async () => {
	await assert.rejects(runCodexImageGeneration("   "), /cannot be empty/);
	await assert.rejects(runCodexImageGeneration("x".repeat(10_001)), /exceeds 10000 characters/);
	await assert.rejects(
		runCodexImageGeneration("too many", ["1", "2", "3", "4", "5"]),
		/at most 4 input images/,
	);

	const root = await mkdtemp(join(tmpdir(), "pi-image-validation-test-"));
	try {
		const text = join(root, "not-image.txt");
		await writeFile(text, "not an image");
		await assert.rejects(
			runCodexImageGeneration("bad input", [text], fakeOptions()),
			/Unsupported input image format/,
		);

		const oversized = join(root, "oversized.png");
		await writeFile(oversized, png);
		await truncate(oversized, 20 * 1024 * 1024 + 1);
		await assert.rejects(
			runCodexImageGeneration("oversized input", [oversized], fakeOptions()),
			/exceeds 20 MiB/,
		);

		const linked = join(root, "linked.png");
		await symlink(oversized, linked);
		await assert.rejects(
			runCodexImageGeneration("linked input", [linked], fakeOptions()),
			/cannot be a symbolic link/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("creates a clean temporary Codex home that bridges only existing authentication", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-codex-home-test-"));
	const sourceHome = join(root, "source");
	const tempRoot = join(root, "temporary");
	await Promise.all([
		mkdir(sourceHome, { recursive: true }),
		mkdir(tempRoot, { recursive: true }),
	]);
	await writeFile(join(sourceHome, "auth.json"), "test authentication material", { mode: 0o600 });
	await writeFile(join(sourceHome, "config.toml"), "[mcp_servers.unsafe]", { mode: 0o600 });
	try {
		const isolatedHome = await prepareIsolatedCodexHome({ CODEX_HOME: sourceHome }, tempRoot);
		const isolatedEntries = await readdir(isolatedHome);
		assert.ok(isolatedEntries.includes("auth.json"));
		assert.equal(isolatedEntries.includes("config.toml"), false);
		assert.ok(isolatedEntries.includes("xdg-config"));
		assert.ok(isolatedEntries.includes("tmp"));
		assert.equal(await readFile(join(isolatedHome, "auth.json"), "utf8"), "test authentication material");
		const isolatedAuth = await lstat(join(isolatedHome, "auth.json"));
		assert.ok(isolatedAuth.isSymbolicLink() || isolatedAuth.isFile());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("builds a minimal Codex environment without Pi offline state or unrelated secrets", () => {
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
		buildCodexEnvironment({ USERPROFILE: "/test-profile" }).CODEX_HOME,
		join("/test-profile", ".codex"),
	);

	assert.equal(
		buildCodexEnvironment({ HOME: "/home", CODEX_HOME: "/profiles/default", PI_CODEX_IMAGE_HOME: "/profiles/image" }).CODEX_HOME,
		"/profiles/image",
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

test("reports a missing Codex executable", async () => {
	await assert.rejects(
		runCodexImageGeneration("Cannot start", [], {
			command: "/definitely/not/a/codex-executable",
			timeoutMs: 500,
		}),
		/Codex CLI was not found/,
	);
});
