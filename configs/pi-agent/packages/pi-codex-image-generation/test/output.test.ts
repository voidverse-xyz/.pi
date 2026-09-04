import assert from "node:assert/strict";
import { existsSync, renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

function findPiPackage(): string {
	const home = process.env.HOME ?? "";
	const candidates = [
		process.env.PI_SDK_DIR,
		join(home, ".local/lib/node_modules/@earendil-works/pi-coding-agent"),
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "dist", "index.js"))) return candidate;
	}
	throw new Error("@earendil-works/pi-coding-agent not found; install Pi globally or set PI_SDK_DIR");
}

const piPackage = findPiPackage();
const jitiModuleUrl = pathToFileURL(join(piPackage, "node_modules", "jiti", "lib", "jiti.mjs"));
const { createJiti } = await import(jitiModuleUrl.href);
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: true,
	alias: {
		"@earendil-works/pi-coding-agent": join(
			piPackage,
			"dist",
			"core",
			"tools",
			"file-mutation-queue.js",
		),
	},
});
const outputPath = fileURLToPath(new URL("../extensions/codex-image-generation/output.ts", import.meta.url));
const { saveGeneratedImage, validateOutputRequest } = await jiti.import(outputPath) as typeof import("../extensions/codex-image-generation/output.ts");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mNoAAAAASUVORK5CYII=", "base64");
const image = {
	data: png.toString("base64"),
	mimeType: "image/png" as const,
	byteLength: png.length,
	status: "completed",
};

test("atomically writes generated images and requires explicit overwrite", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-output-test-"));
	try {
		await mkdir(join(root, "nested"));
		await validateOutputRequest(root, "nested/result.png", false);
		const saved = await saveGeneratedImage(root, "nested/result.png", image, false);
		assert.equal(saved.displayPath, join("nested", "result.png"));
		assert.deepEqual(await readFile(saved.absolutePath), png);

		await assert.rejects(
			saveGeneratedImage(root, "nested/result.png", image, false),
			/Output already exists/,
		);
		await writeFile(saved.absolutePath, "old");
		await assert.rejects(
			validateOutputRequest(root, "nested/result.png", false),
			/Output already exists/,
		);
		await saveGeneratedImage(root, "nested/result.png", image, true);
		assert.deepEqual(await readFile(saved.absolutePath), png);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("confines output to cwd and rejects symlink escapes and symlink targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-confine-test-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-image-outside-test-"));
	try {
		await assert.rejects(saveGeneratedImage(root, "../escape.png", image, false), /must stay within/);

		await symlink(outside, join(root, "linked-parent"));
		await assert.rejects(
			saveGeneratedImage(root, "linked-parent/escape.png", image, false),
			/resolves outside/,
		);

		const target = join(root, "target.png");
		await writeFile(target, png);
		await symlink(target, join(root, "linked-output.png"));
		await assert.rejects(
			saveGeneratedImage(root, "linked-output.png", image, true),
			/Refusing to replace symbolic link/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("rejects an ancestor swapped to an outside symlink before the parent is anchored", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-ancestor-race-test-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-image-ancestor-race-outside-"));
	await mkdir(join(root, "container", "parent"), { recursive: true });
	await mkdir(join(outside, "parent"));
	let abortChecks = 0;
	const swapBeforeAnchor = {
		get aborted() {
			abortChecks += 1;
			if (abortChecks === 2) {
				renameSync(join(root, "container"), join(root, "container-original"));
				symlinkSync(outside, join(root, "container"), "dir");
			}
			return false;
		},
	} as AbortSignal;
	try {
		await assert.rejects(
			saveGeneratedImage(root, "container/parent/result.png", image, false, swapBeforeAnchor),
			/escaped the approved path/,
		);
		assert.equal(existsSync(join(outside, "parent", "result.png")), false);
		assert.deepEqual(await readdir(join(outside, "parent")), []);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("requires an existing output parent and a matching image suffix", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-extension-test-"));
	try {
		await assert.rejects(saveGeneratedImage(root, "missing/result.png", image, false), /parent directory must already exist/);
		await assert.rejects(saveGeneratedImage(root, "result.txt", image, false), /must end in/);
		await assert.rejects(saveGeneratedImage(root, "result.jpg", image, false), /output path requests image\/jpeg/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("honors cancellation before and immediately after writing the temporary image", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-output-cancel-test-"));
	try {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			saveGeneratedImage(root, "cancelled-early.png", image, false, controller.signal),
			/image generation cancelled/,
		);

		let abortChecks = 0;
		const abortBeforeCommit = {
			get aborted() {
				abortChecks += 1;
				return abortChecks >= 4;
			},
		} as AbortSignal;
		await assert.rejects(
			saveGeneratedImage(root, "cancelled-before-commit.png", image, false, abortBeforeCommit),
			/image generation cancelled/,
		);
		assert.equal(existsSync(join(root, "cancelled-early.png")), false);
		assert.equal(existsSync(join(root, "cancelled-before-commit.png")), false);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
