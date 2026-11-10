import { createPiJiti, dependencyRoot, findPiPackage } from "../../../tests/runtime.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";


const piPackage = findPiPackage();
const codingAgentStub = fileURLToPath(new URL("./fixtures/pi-coding-agent.mjs", import.meta.url));
const jiti = await createPiJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": codingAgentStub } });
const extensionPath = fileURLToPath(new URL("../extensions/codex-image-generation/index.ts", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

test("returns text-only generation/edit metadata in every mode, with a TUI-only preview and explicit read support", async () => {
	const extension = await jiti.import(extensionPath) as { default: (pi: { registerTool(tool: unknown): void }) => void };
	const tools: any[] = [];
	extension.default({ registerTool: (tool) => tools.push(tool) });
	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.equal(tool.name, "image_generation");
	assert.match(tool.description, /native image-generation capability/);
	assert.ok(tool.parameters.properties.prompt);
	assert.ok(tool.parameters.properties.outputPath);
	assert.ok(tool.parameters.properties.inputImages);
	assert.ok(tool.parameters.properties.overwrite);
	if (process.platform === "win32") return;

	const root = await mkdtemp(join(tmpdir(), "pi-image-extension-test-"));
	const shim = join(root, "codex-shim");
	const codexHome = join(root, "codex-home-source");
	const previousCodexBin = process.env.CODEX_BIN;
	const previousImageHome = process.env.PI_CODEX_IMAGE_HOME;
	try {
		await mkdir(codexHome);
		await writeFile(join(codexHome, "auth.json"), "test authentication material", { mode: 0o600 });
		await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`);
		await chmod(shim, 0o700);
		process.env.CODEX_BIN = shim;
		process.env.PI_CODEX_IMAGE_HOME = codexHome;

		const cancelled = new AbortController();
		cancelled.abort();
		await assert.rejects(
			tool.execute(
				"cancelled-output",
				{ prompt: "Must not start", outputPath: "cancelled.png", overwrite: false },
				cancelled.signal,
				undefined,
				{ cwd: root },
			),
			/image generation cancelled/,
		);
		assert.equal(existsSync(join(root, "cancelled.png")), false);

		await assert.rejects(
			tool.execute(
				"invalid-output",
				{ prompt: "Must not start", outputPath: "missing/generated.png", overwrite: false },
				undefined,
				undefined,
				{ cwd: root },
			),
			/output parent directory must already exist/i,
		);

		const updates: any[] = [];
		const result = await tool.execute(
			"call-1",
			{ prompt: "Draw a blue pixel", outputPath: "generated.png", overwrite: false },
			undefined,
			(update: unknown) => updates.push(update),
			{ cwd: root },
		);
		assert.match(result.content[0].text, /Generated image: generated\.png/);
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0].type, "text");
		assert.equal(result.details.previewData, undefined);
		assert.deepEqual((await readFile(join(root, "generated.png"))).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		assert.ok(updates.length >= 1);
		assert.equal(result.details.inputImageCount, 0);
		assert.ok(updates.every((update) => update.content.every((part) => part.type === "text")));

		const { createReadTool } = await import(pathToFileURL(join(piPackage, "dist/core/tools/read.js")).href);
		const { Image, getCapabilities, setCapabilities } = await import(pathToFileURL(join(dependencyRoot("@earendil-works/pi-tui", piPackage), "dist/index.js")).href);
		const theme = { fg: (_color: string, text: string) => text };
		for (const mode of ["print", "json", "rpc", "tui"]) {
			for (const editing of [false, true]) {
				const outputPath = `${mode}-${editing ? "edited" : "generated"}.png`;
				const response = await tool.execute(outputPath, {
					prompt: editing ? "Make the pixel red" : "Draw a blue pixel",
					outputPath,
					inputImages: editing ? ["generated.png"] : [],
				}, undefined, undefined, { cwd: root, mode });
				const bytes = await readFile(join(root, outputPath));
				assert.deepEqual(response.content, [{ type: "text", text:
					`${editing ? "Edited" : "Generated"} image: ${outputPath}\nMIME: image/png\nBytes: ${bytes.length}\nStatus: completed`,
				}]);
				assert.equal(response.details.path, outputPath);
				assert.equal(response.details.mimeType, "image/png");
				assert.equal(response.details.byteLength, bytes.length);
				assert.equal(response.details.status, "completed");
				assert.equal(response.details.inputImageCount, editing ? 1 : 0);
				assert.equal(response.details.revisedPrompt, "A revised image prompt");
				assert.equal(response.details.previewData, mode === "tui" ? bytes.toString("base64") : undefined);
				assert.ok(!JSON.stringify(response.content).includes(bytes.toString("base64")));

				// The renderer also works after session serialization, without reading a path.
				const restored = JSON.parse(JSON.stringify(response));
				const preview = tool.renderResult(restored, { isPartial: false, expanded: false }, theme, { showImages: true });
				assert.equal(preview.children.some((child) => child instanceof Image), mode === "tui");
				if (mode === "tui") {
					const capabilities = getCapabilities();
					try {
						setCapabilities({ ...capabilities, images: "kitty" });
						assert.ok(preview.render(80).some((line) => line.includes("\x1b_G")));
						setCapabilities({ ...capabilities, images: null });
						preview.invalidate();
						assert.ok(preview.render(80).some((line) => line.includes("image/png")));
					} finally {
						setCapabilities(capabilities);
					}
				}
				for (const context of [{ showImages: false }, { showImages: true, isError: true }]) {
					const hidden = tool.renderResult(restored, { isPartial: false }, theme, context);
					assert.equal(hidden.children.length, 1);
				}
				const explicitRead = await createReadTool(root).execute("inspect", { path: outputPath });
				assert.ok(explicitRead.content.some((part) => part.type === "image" && part.mimeType === "image/png"));
			}
		}
		const progress = tool.renderResult(updates[0], { isPartial: true }, theme, { showImages: true });
		assert.equal(progress.children.length, 1);
	} finally {
		if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previousCodexBin;
		if (previousImageHome === undefined) delete process.env.PI_CODEX_IMAGE_HOME;
		else process.env.PI_CODEX_IMAGE_HOME = previousImageHome;
		await rm(root, { recursive: true, force: true });
	}
});
