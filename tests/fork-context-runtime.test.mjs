import { unlinkSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { EXT, jiti } from "../packages/pi-subagents/test/e2e/env.mjs";
import { makeWorld, piSdk } from "../packages/pi-subagents/test/e2e/harness.mjs";

const world = await makeWorld("fork-context");
world.writeDef("scout", "You are the independent SCOUT_ROLE.");
const parent = piSdk.SessionManager.inMemory(world.project);
parent.appendMessage({ role: "user", content: [{ type: "text", text: "PARENT_SCHEMA_GREEN" }], timestamp: 1 });
parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "Parent considered the schema." }], api: "mock-api", provider: "mock", model: "mock-1", stopReason: "stop", timestamp: 2,
	usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } } });

for (const [packageName, extension] of [["pi-subagents", "subagents"], ["pi-teams", "teams"]]) {
	const base = join(EXT, "..", "..", "..", packageName, "extensions", extension);
	const { createCore } = await jiti.import(join(base, "core.ts"));
	const { createLayout } = await jiti.import(join(base, "store/layout.ts"));
	const { createSpawnTool } = await jiti.import(join(base, "tools/main-agent.ts"));
	test(`${packageName}: main chooses auto/focus/fork; actual SDK history and usage remain independent`, async t => {
		const layout = createLayout(world.project, { home: world.home, sessionId: `fork-${extension}` });
		let core = createCore({ layout, modelRuntime: world.modelRuntime, modelRegistry: world.modelRegistry, settingsManager: world.settingsManager });
		t.after(async () => core.dispose());
		const cases = [["auto-low", 10, undefined, "fork"], ["focus-low", 10, "focus", "focus"], ["fork-high", 90, "fork", "fork"], ["auto-thirty", 30, undefined, "focus"], ["auto-unknown", null, undefined, "focus"]];
		for (const [id, percent, mode, expected] of cases) {
			const ctx = { sessionManager: parent, model: world.modelRuntime.getModel("mock", "mock-1"), getContextUsage: () => ({ percent }) };
			const output = await createSpawnTool(() => core).execute(`spawn-${id}`, { type: "scout", id, label: id, task: `Inspect ${id}`, ...(mode ? { contextMode: mode } : {}) }, new AbortController().signal, () => {}, ctx);
			assert.equal(output.isError, undefined, JSON.stringify(output));
			assert.equal(JSON.parse(output.content[0].text).contextMode, expected);
			await core.whenIdle();
			const call = world.llmCalls.findLast(call => call.address === `scout/${id}`);
			assert.ok(call.systemPrompt.includes("SCOUT_ROLE"));
			assert.equal(call.historyText.includes("PARENT_SCHEMA_GREEN"), expected === "fork");
			const worker = (await core.status()).find(worker => worker.address === `scout/${id}`);
			assert.equal(worker.vitals.tokens, 15, "copied parent tokens are not worker usage");
			assert.equal(worker.vitals.turns, 1);
		}
		const taskless = await createSpawnTool(() => core).execute("taskless", { type: "scout", id: "taskless", label: "taskless", contextMode: "fork" }, new AbortController().signal, () => {}, { sessionManager: parent, getContextUsage: () => ({ percent: 80 }) });
		assert.equal(JSON.parse(taskless.content[0].text).contextMode, "fork");
		await core.dispose();
		core = createCore({ layout, modelRuntime: world.modelRuntime, modelRegistry: world.modelRegistry, settingsManager: world.settingsManager });
		await core.send({ to: "scout/taskless", text: "First task after reload" }); await core.whenIdle();
		assert.ok(world.llmCalls.findLast(call => call.address === "scout/taskless").historyText.includes("PARENT_SCHEMA_GREEN"));
		const count = parent.getEntries().length;
		parent.appendMessage({ role: "user", content: "NEW_MAIN_HISTORY_DO_NOT_RECOPY", timestamp: 3 });
		const reused = await createSpawnTool(() => core).execute("reuse", { type: "scout", id: "auto-low", label: "reuse", task: "Follow up", contextMode: "fork" }, new AbortController().signal, () => {}, { sessionManager: parent, getContextUsage: () => ({ percent: 10 }) });
		assert.equal(JSON.parse(reused.content[0].text).contextMode, "existing"); await core.whenIdle();
		assert.doesNotMatch(world.llmCalls.findLast(call => call.address === "scout/auto-low").historyText, /NEW_MAIN_HISTORY_DO_NOT_RECOPY/);
		assert.equal(parent.getEntries().length, count + 1, "worker copying never changes parent history");
		parent.branch(parent.getEntries()[count - 1].id);
		const missing = await core.peek("scout/taskless");
		assert.ok(missing.sessionFile.startsWith(world.scratch));
		await core.dispose(); unlinkSync(missing.sessionFile);
		core = createCore({ layout, modelRuntime: world.modelRuntime, modelRegistry: world.modelRegistry, settingsManager: world.settingsManager });
		const callsBefore = world.llmCalls.length;
		await core.send({ to: "scout/taskless", text: "Missing-history probe" }); await core.whenIdle();
		assert.equal(world.llmCalls.length, callsBefore, "missing fork history must never start an empty worker");
	});
}
