import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const codingAgentStub = fileURLToPath(new URL("./fixtures/pi-coding-agent.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: true,
	alias: {
		"@earendil-works/pi-coding-agent": codingAgentStub,
		"@earendil-works/pi-ai": join(piPackage, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
		typebox: join(piPackage, "node_modules", "typebox", "build", "index.mjs"),
	},
});
const extensionPath = fileURLToPath(new URL("../extensions/codex-image-generation/index.ts", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

test("registers a create-and-edit tool and returns a saved inline image", async () => {
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
		assert.equal(result.content[1].type, "image");
		assert.equal(result.content[1].mimeType, "image/png");
		assert.ok(result.content[1].data.length > 20);
		assert.deepEqual((await readFile(join(root, "generated.png"))).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		assert.ok(updates.length >= 1);
		assert.equal(result.details.inputImageCount, 0);
	} finally {
		if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previousCodexBin;
		if (previousImageHome === undefined) delete process.env.PI_CODEX_IMAGE_HOME;
		else process.env.PI_CODEX_IMAGE_HOME = previousImageHome;
		await rm(root, { recursive: true, force: true });
	}
});
