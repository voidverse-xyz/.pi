import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { getModel, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import planExtension from "./index.ts";
import { sdkAliases } from "../../../../tests/runtime.mjs";
import { createMockRuntime } from "../../../pi-swarm/test/sdk-env.mjs";
import { createProgress } from "../../../pi-swarm/extensions/swarm/progress.mjs";

const apiRoot = dirname(sdkAliases()["@earendil-works/pi-ai"]);
const { stream } = await import(pathToFileURL(join(apiRoot, "api/openai-codex-responses.js")).href);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Real provider serialization, stopped at onPayload before headers/transport. */
async function payload(context, options) {
	const model = getModel("openai-codex", "gpt-6-luna");
	assert.ok(model, "The managed SDK must expose the requested Luna descriptor");
	const fixtureToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } })).toString("base64")}.fixture`;
	let body;
	const response = stream(model, context, { ...options, apiKey: fixtureToken, sessionId: "offline-prefix-audit", onPayload: value => {
		body = structuredClone(value); throw new Error("Offline payload captured before transport");
	} });
	await response.result();
	assert.ok(body, "No headers or transport may run before the capture hook");
	return body;
}

async function fixture(t, initialState) {
	const root = mkdtempSync(join(tmpdir(), "pi-prefix-audit-"));
	const cwd = join(root, "project"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
	for (const directory of [cwd, agentDir, sessionDir]) mkdirSync(directory);
	const mock = await createMockRuntime(() => ({ text: "READY" }));
	const state = { run: { runId: "prefix-fixture", status: "running", objective: "Read-only prefix audit", workers: [], tasks: [], messages: [], sessions: { turns: [] }, workspace: { operations: [] } } };
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
	let ctx, progress;
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Read-only prefix audit. Reply READY. Never call tools or create workers.", extensionFactories: [planExtension, pi => {
			progress = createProgress(pi, () => ctx);
			pi.on("session_start", (_event, context) => { ctx = context; progress.bind({ snapshot: () => state, subscribe: () => () => {} }); });
		}] });
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	const manager = SessionManager.create(cwd, sessionDir);
	if (initialState) manager.appendCustomEntry("plan-mode.state", initialState);
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: mock.modelRuntime, model: mock.model, thinkingLevel: "low", tools: ["read"],
		sessionManager: manager, settingsManager, resourceLoader: loader });
	await session.bindExtensions({});
	t.after(() => { progress.dispose(); session.dispose(); rmSync(root, { recursive: true, force: true }); });
	return { ...mock, session, manager, state, progress };
}

async function until(predicate) {
	for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
	assert.fail("Offline native mail wake did not settle");
}

test("normal owner input and real Swarm mail wake preserve serialized Codex prefix", async t => {
	const f = await fixture(t);
	await f.session.prompt("First audit input. Reply READY.");
	await f.session.prompt("Second audit input. Reply READY.");
	f.state.run.messages.push({ id: "audit-mail", from: "worker", to: "owner", text: "Audit mail only. Reply READY.", cycle: 1, generation: 0 });
	f.progress.launched(); await until(() => f.calls.length === 3 && f.session.isIdle);
	f.state.run.messages.push({ id: "audit-mail-2", from: "worker", to: "owner", text: "Second audit mail only.", cycle: 1, generation: 0 });
	f.progress.input(); await until(() => f.calls.length === 4 && f.session.isIdle);
	await f.session.prompt("Return to ordinary input. Reply READY.");
	const bodies = await Promise.all(f.calls.map(call => payload(call.context, call.options)));
	for (const [index, body] of bodies.entries()) t.diagnostic(JSON.stringify({ request: index + 1, instructionsHash: hash(body.instructions), toolsHash: hash(body.tools ?? []), inputItems: body.input.length }));
	assert.ok(bodies.some(body => body.tools?.length || body.input.some(item => item.type === "additional_tools")), "actual tool declarations are part of the audited prefix");
	for (let i = 1; i < bodies.length; i++) {
		assert.equal(bodies[i].instructions, bodies[0].instructions, "unchanged mode must not rewrite leading instructions on mail wakes");
		assert.equal(hash(bodies[i].tools ?? []), hash(bodies[0].tools ?? []));
		assert.deepEqual(bodies[i].input.slice(0, bodies[i - 1].input.length), bodies[i - 1].input, "prior conversation/tool declarations remain a reusable exact prefix");
	}
	assert.match(getCurrentSystemPrompt(f.calls[2].context.messages), /Off for this run/);
});

test("idle Quick-mode custom wake receives current restrictions rather than historical Off instructions", async t => {
	const f = await fixture(t);
	await f.session.prompt("First audit input.");
	await f.session.prompt("/quick on");
	f.state.run.messages.push({ id: "quick-mail", from: "worker", to: "owner", text: "Read-only audit mail.", cycle: 1, generation: 0 });
	f.progress.launched(); await until(() => f.calls.length === 2 && f.session.isIdle);
	assert.match(getCurrentSystemPrompt(f.calls[1].context.messages), /Quick mode is active/);
	assert.equal(f.calls.length, 2, "no extra normalization model turn");
});


test("a cold Plan custom wake receives Plan instructions without planning guidance and drops a legacy template selection", async t => {
	const f = await fixture(t, { mode: "plan", selectedPlanSkill: "explicit-template" });
	f.state.run.messages.push({ id: "cold-plan", from: "worker", to: "owner", text: "Read-only audit wake.", cycle: 1, generation: 0 });
	f.progress.launched(); await until(() => f.calls.length === 1 && f.session.isIdle);
	const instructions = getCurrentSystemPrompt(f.calls[0].context.messages);
	assert.match(instructions, /Plan mode is active/);
	assert.match(instructions, /save_plan/);
	assert.doesNotMatch(instructions, /explicit-template|plan_template|planning skill/);
});
