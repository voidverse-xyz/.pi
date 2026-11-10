import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
	resolveWslExecutable,
	saveWindowsOutput,
	validateWindowsOutput,
	validateWindowsOutputPath,
} from "../extensions/codex-image-generation/windows-output.ts";

const windowsOnly = { skip: process.platform !== "win32" };
const nonWindowsOnly = { skip: process.platform === "win32" };
const mappedPathExecutor = (async (_command: string, args: string[]) => ({
	stdout: `${args.at(-1)?.replaceAll("\\", "/")}\n`,
	stderr: "",
})) as any;

async function writeFakeWslExecutable(root: string, body: string): Promise<string> {
	const wslExecutable = join(root, "wsl.exe");
	await writeFile(wslExecutable, `#!/usr/bin/env node\n${body}\n`);
	await chmod(wslExecutable, 0o700);
	return wslExecutable;
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) return;
		await delay(10);
	}
	throw new Error(`Timed out waiting for test marker: ${path}`);
}

function asynchronouslyFailingSpawn(code: string): any {
	return () => {
		const child = new EventEmitter() as any;
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => true;
		queueMicrotask(() => {
			const error = Object.assign(new Error("synthetic spawn failure"), { code });
			child.emit("error", error);
		});
		return child;
	};
}

test("rejects ambiguous and reserved Windows output paths", () => {
	validateWindowsOutputPath("images/result.png");
	for (const path of [
		"../result.png",
		"C:\\result.png",
		"\\\\server\\share\\result.png",
		"images/result.png:stream",
		"images/result.png.",
		"images/CON.png",
	]) {
		assert.throws(() => validateWindowsOutputPath(path));
	}
});

test("resolves WSL only beneath a local Windows SystemRoot", async () => {
	const checkedPaths: string[] = [];
	const resolved = await resolveWslExecutable(
		{ SystemDrive: "C:", SystemRoot: "C:\\Windows" },
		async (path) => checkedPaths.push(path),
	);
	assert.equal(resolved, "C:\\Windows\\System32\\wsl.exe");
	assert.deepEqual(checkedPaths, [resolved]);

	for (const systemRoot of [
		".",
		"D:\\Windows",
		"\\\\server\\share\\Windows",
		"\\\\?\\C:\\Windows",
		"C:\\Windows\\..\\workspace",
	]) {
		await assert.rejects(
			resolveWslExecutable({ SystemDrive: "C:", SystemRoot: systemRoot }, async () => undefined),
			/Secure image output on Windows requires WSL with Python 3/,
		);
	}
	await assert.rejects(
		resolveWslExecutable({}, async () => undefined),
		/Secure image output on Windows requires WSL with Python 3/,
	);
	await assert.rejects(
		resolveWslExecutable({ SystemDrive: "C:", SystemRoot: "C:\\Windows" }, async () => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		}),
		/Secure image output on Windows requires WSL with Python 3/,
	);
});

test("normalizes asynchronous WSL startup failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-windows-spawn-test-"));
	try {
		const commonOptions = {
			execFile: mappedPathExecutor,
			wslExecutable: "C:\\Windows\\System32\\wsl.exe",
		};
		await assert.rejects(
			validateWindowsOutput(
				await realpath(root),
				join(root, "result.png"),
				"result.png",
				false,
				undefined,
				{ ...commonOptions, spawn: asynchronouslyFailingSpawn("ENOENT") },
			),
			/Secure image output on Windows requires WSL with Python 3/,
		);
		await assert.rejects(
			validateWindowsOutput(
				await realpath(root),
				join(root, "result.png"),
				"result.png",
				false,
				undefined,
				{ ...commonOptions, spawn: asynchronouslyFailingSpawn("EACCES") },
			),
			/Windows image-output helper failed to start/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writes and atomically replaces an image through the WSL helper", windowsOnly, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-windows-output-test-"));
	try {
		await mkdir(join(root, "nested"));
		const approvedRoot = await realpath(root);
		const target = join(root, "nested", "result.png");
		await validateWindowsOutput(approvedRoot, target, "nested/result.png", false);
		await saveWindowsOutput(approvedRoot, target, "nested/result.png", Buffer.from("first"), false);
		await assert.rejects(
			saveWindowsOutput(approvedRoot, target, "nested/result.png", Buffer.from("blocked"), false),
			/Output already exists/,
		);
		await saveWindowsOutput(approvedRoot, target, "nested/result.png", Buffer.from("second"), true);
		assert.equal(await readFile(target, "utf8"), "second");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects Windows symlink parents and targets", windowsOnly, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-windows-confine-test-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-image-windows-outside-test-"));
	try {
		const approvedRoot = await realpath(root);
		await symlink(outside, join(root, "linked-parent"), "dir");
		await assert.rejects(
			saveWindowsOutput(
				approvedRoot,
				join(root, "linked-parent", "escape.png"),
				"linked-parent/escape.png",
				Buffer.from("escape"),
				false,
			),
			/escaped the approved path/,
		);
		assert.equal(existsSync(join(outside, "escape.png")), false);

		const target = join(root, "target.png");
		await writeFile(target, "original");
		await symlink(target, join(root, "linked-output.png"), "file");
		await assert.rejects(
			saveWindowsOutput(
				approvedRoot,
				join(root, "linked-output.png"),
				"linked-output.png",
				Buffer.from("replacement"),
				true,
			),
			/Refusing to replace symbolic link/,
		);
		assert.equal(await readFile(target, "utf8"), "original");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("times out if the helper stalls after commit authorization", nonWindowsOnly, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-windows-timeout-test-"));
	try {
		const fakeWsl = await writeFakeWslExecutable(root, `
const args = process.argv.slice(2);
if (args[0] === "--exec" && args[1] === "wslpath") {
	process.stdout.write(args.at(-1).replace(/\\\\/g, "/") + "\\n");
	process.exit(0);
}
process.stdout.write("READY\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	if (chunk.includes("COMMIT\\n")) setInterval(() => undefined, 1_000);
});
`);
		const target = join(root, "stalled.png");
		await assert.rejects(
			saveWindowsOutput(
				await realpath(root),
				target,
				"stalled.png",
				Buffer.from("stalled"),
				false,
				undefined,
				{ wslExecutable: fakeWsl, helperTimeoutMs: 50, terminationGraceMs: 25 },
			),
			/Windows image-output helper timed out/,
		);
		assert.equal(existsSync(target), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sends CANCEL and terminates a stalled helper before commit", nonWindowsOnly, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-windows-cancel-test-"));
	const readyMarker = join(root, "payload-ready");
	const cancelMarker = join(root, "cancel-received");
	try {
		const fakeWsl = await writeFakeWslExecutable(root, `
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--exec" && args[1] === "wslpath") {
	process.stdout.write(args.at(-1).replace(/\\\\/g, "/") + "\\n");
	process.exit(0);
}
let input = Buffer.alloc(0);
let expectedBytes;
let payloadReady = false;
process.stdin.on("data", (chunk) => {
	input = Buffer.concat([input, chunk]);
	if (expectedBytes === undefined) {
		const newline = input.indexOf(10);
		if (newline < 0) return;
		expectedBytes = JSON.parse(input.subarray(0, newline)).byteLength;
		input = input.subarray(newline + 1);
	}
	if (!payloadReady && input.length >= expectedBytes) {
		input = input.subarray(expectedBytes);
		payloadReady = true;
		fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");
	}
	if (payloadReady && input.toString().includes("CANCEL\\n")) {
		fs.writeFileSync(${JSON.stringify(cancelMarker)}, "cancelled");
	}
});
setInterval(() => undefined, 1_000);
`);
		const controller = new AbortController();
		const result = saveWindowsOutput(
			await realpath(root),
			join(root, "cancelled.png"),
			"cancelled.png",
			Buffer.from("cancelled"),
			false,
			controller.signal,
			{ wslExecutable: fakeWsl, helperTimeoutMs: 30_000, terminationGraceMs: 50 },
		);
		await waitForFile(readyMarker);
		controller.abort();
		await assert.rejects(result, /image generation cancelled/);
		await waitForFile(cancelMarker);
		assert.equal(existsSync(join(root, "cancelled.png")), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("treats COMMIT as the cancellation point of no return", nonWindowsOnly, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-windows-commit-test-"));
	const commitMarker = join(root, "commit-received");
	try {
		const fakeWsl = await writeFakeWslExecutable(root, `
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--exec" && args[1] === "wslpath") {
	process.stdout.write(args.at(-1).replace(/\\\\/g, "/") + "\\n");
	process.exit(0);
}
process.stdout.write("READY\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	if (!chunk.includes("COMMIT\\n")) return;
	fs.writeFileSync(${JSON.stringify(commitMarker)}, "committed");
	setTimeout(() => {
		process.stdout.write("OK\\n");
		process.exit(0);
	}, 100);
});
`);
		const controller = new AbortController();
		const result = saveWindowsOutput(
			await realpath(root),
			join(root, "committed.png"),
			"committed.png",
			Buffer.from("committed"),
			false,
			controller.signal,
			{ wslExecutable: fakeWsl, helperTimeoutMs: 2_000, terminationGraceMs: 25 },
		);
		await waitForFile(commitMarker);
		controller.abort();
		await result;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
