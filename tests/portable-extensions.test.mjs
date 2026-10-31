import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createPiJiti, findPiPackage } from "./runtime.mjs";
import { makeWorld, piSdk } from "../packages/pi-subagents/test/e2e/harness.mjs";
import { createMockRuntime } from "../packages/pi-swarm/test/sdk-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { loadExtensions } = await import(pathToFileURL(join(findPiPackage(), "dist/core/extensions/loader.js")).href);
const packages = [["pi-subagents", "subagents", 7], ["pi-teams", "teams", 9], ["pi-swarm", "swarm", 5]];

for (const [name, extension, toolCount] of packages) test(`${name} runs alone with its bundled fork helper`, async t => {
	const temporary = mkdtempSync(join(tmpdir(), "pi-portable-extension-"));
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const directory = join(temporary, name);
	cpSync(join(root, "packages", name), directory, { recursive: true });
	const base = join(directory, "extensions", extension);
	for (const file of walk(join(directory, "extensions"))) {
		if (!/\.(?:ts|mjs|mts|js)$/.test(file)) continue;
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
			const target = resolve(dirname(file), match[1]);
			assert.ok(target.startsWith(directory + sep), `${name}: runtime import escapes its package: ${match[1]}`);
			assert.ok(existsSync(target), `${name}: missing local dependency: ${match[1]}`);
		}
	}
	const agentDir = join(temporary, "agent"); mkdirSync(agentDir);
	const loaded = await loadExtensions([join(directory, "extensions", name === "pi-swarm" ? "index.ts" : `${extension}/index.ts`)], agentDir);
	assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
	assert.equal(loaded.extensions[0].tools.size, toolCount);
	const jiti = await createPiJiti(import.meta.url, { moduleCache: false });
	const { captureWorkerContext } = await jiti.import(join(base, "context/fork.mjs"));
	const parent = piSdk.SessionManager.inMemory(temporary);
	parent.appendMessage({ role: "user", content: "STANDALONE_FORK_BACKGROUND", timestamp: 1 });
	const ctx = { sessionManager: parent, getContextUsage: () => ({ percent: 10 }) };
	if (name === "pi-swarm") {
		const mock = await createMockRuntime(() => ({ text: "Standalone worker reply" }));
		const { createSdkSession } = await jiti.import(join(base, "sdk-session.mjs"));
		const opened = await createSdkSession({ cwd: temporary, sessionDir: join(temporary, "sessions"), modelRuntime: mock.modelRuntime, selection: mock.selection, systemPrompt: "Standalone bounded worker", customTools: [], workerContext: captureWorkerContext(ctx) });
		t.after(() => opened.session.dispose());
		await opened.session.prompt("Handle this new assignment");
		assert.match(JSON.stringify(mock.calls[0].context.messages), /STANDALONE_FORK_BACKGROUND/);
	} else {
		const world = await makeWorld(`portable-${name}`); world.writeDef("scout", "Standalone scout");
		const { createLayout } = await jiti.import(join(base, "store/layout.ts"));
		const { createCore } = await jiti.import(join(base, "core.ts"));
		const { createSpawnTool } = await jiti.import(join(base, "tools/main-agent.ts"));
		const layout = createLayout(world.project, { home: world.home, sessionId: `portable-${extension}` });
		const core = createCore({ layout, modelRuntime: world.modelRuntime, modelRegistry: world.modelRegistry, settingsManager: world.settingsManager });
		t.after(() => core.dispose());
		const output = await createSpawnTool(() => core).execute("spawn", { type: "scout", label: "standalone", task: "New standalone assignment", contextMode: "fork" }, new AbortController().signal, () => {}, ctx);
		assert.equal(JSON.parse(output.content[0].text).contextMode, "fork"); await core.whenIdle();
		assert.match(world.llmCalls[0].historyText, /STANDALONE_FORK_BACKGROUND/);
	}
});

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}
