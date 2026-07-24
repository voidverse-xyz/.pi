/**
 * test/e2e/harness.mjs — shared world + scripted mock LLM for the phase files.
 *
 * makeWorld(name) wipes and rebuilds a scratch world (home + project dirs, type
 * def dirs) and returns paths plus a factory for cores wired to a mock provider.
 * Only the LLM is mocked: real fs, real session files, real scheduler/mail.
 *
 * The mock matches scripted replies by agent address + last user text; a reply
 * can be plain text, tool calls, or carry delayMs to hold the turn open (for
 * concurrency/steer/cancel timing tests).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestModelRuntime, EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

export const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
export const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));

const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));

export async function makeWorld(name) {
	const scratch = join(WORLDS, `${name}-world`);
	rmSync(scratch, { recursive: true, force: true });
	const home = join(scratch, "home");
	const project = join(scratch, "project");
	const globalDefs = join(home, ".pi", "agent", "subagents");
	const projectDefs = join(project, ".pi", "subagents");
	mkdirSync(globalDefs, { recursive: true });
	mkdirSync(projectDefs, { recursive: true });

	/** Write a global type def; extraFrontmatter lines land verbatim (for foreign keys). */
	const writeDef = (defName, body, extraFrontmatter = []) => {
		writeFileSync(
			join(globalDefs, `${defName}.md`),
			["---", `name: ${defName}`, `description: ${defName}`, "model: mock/mock-1", "projectContext: false", ...extraFrontmatter, "---", body].join("\n"),
		);
	};

	// ---------------------------------------------------------------- mock LLM
	const llmCalls = [];
	let callSeq = 0;
	const scripts = [];
	function lastUserText(messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				const c = messages[i].content;
				return typeof c === "string" ? c : c.map((x) => x.text ?? "").join("\n");
			}
		}
		return "";
	}
	function addressOf(systemPrompt) {
		const m = systemPrompt.match(/address `([^`]+)`/);
		return m ? m[1] : "?";
	}
	function mockStream(model, context) {
		const stream = piAi.createAssistantMessageEventStream();
		(async () => {
			const call = {
				address: addressOf(context.systemPrompt ?? ""),
				systemPrompt: context.systemPrompt ?? "",
				lastUserText: lastUserText(context.messages),
				messageCount: context.messages.length,
				historyText: JSON.stringify(context.messages),
			};
			llmCalls.push(call);
			let spec = { text: `MOCK_DEFAULT_${llmCalls.length}` };
			for (let i = 0; i < scripts.length; i++) {
				if (scripts[i].match(call)) {
					spec = scripts.splice(i, 1)[0].reply(call);
					break;
				}
			}
			if (spec.delayMs && (spec.tools || !spec.thinking)) await new Promise((r) => setTimeout(r, spec.delayMs));
			const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
			const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
			if (spec.tools) {
				const thinking = typeof spec.thinking === "string" ? spec.thinking : "";
				const toolCalls = spec.tools.map((t) => ({ type: "toolCall", id: `call_${++callSeq}`, name: t.name, arguments: t.args }));
				const content = [
					...(thinking ? [{ type: "thinking", thinking }] : []),
					...toolCalls,
				];
				const output = { ...base, content, stopReason: "toolUse" };
				stream.push({ type: "start", partial: output });
				if (thinking) {
					stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
					stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: output });
					stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial: output });
				}
				const toolOffset = thinking ? 1 : 0;
				toolCalls.forEach((toolCall, i) => {
					stream.push({ type: "toolcall_start", contentIndex: i + toolOffset, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: i + toolOffset, toolCall, partial: output });
				});
				stream.push({ type: "done", reason: "toolUse", message: output });
			} else {
				const thinking = typeof spec.thinking === "string" ? spec.thinking : "";
				const content = [
					...(thinking ? [{ type: "thinking", thinking }] : []),
					{ type: "text", text: spec.text },
				];
				const output = { ...base, content, stopReason: "stop" };
				stream.push({ type: "start", partial: output });
				if (thinking) {
					stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
					stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: output });
					if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
					stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial: output });
				}
				const textIndex = thinking ? 1 : 0;
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
				stream.push({ type: "text_delta", contentIndex: textIndex, delta: spec.text, partial: output });
				stream.push({ type: "text_end", contentIndex: textIndex, content: spec.text, partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
			}
			stream.end();
		})();
		return stream;
	}

	const settingsManager = piSdk.SettingsManager.create(project, join(home, ".pi", "agent"));
	const { modelRuntime, modelRegistry } = await createTestModelRuntime(piSdk, {
		cwd: project,
		agentDir: join(home, ".pi", "agent"),
		settingsManager,
		providers: {
			mock: {
				baseUrl: "http://mock.invalid", apiKey: "k", api: "mock-api", streamSimple: mockStream,
				models: [{ id: "mock-1", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
			},
		},
	});

	const makeLayout = (sessionId) => createLayout(project, { home, sessionId });
	const makeCore = (layout, extra = {}) => createCore({ layout, modelRuntime, modelRegistry, settingsManager, ...extra });

	return { scratch, home, project, globalDefs, projectDefs, writeDef, llmCalls, scripts, modelRuntime, modelRegistry, settingsManager, makeLayout, makeCore };
}

let passed = 0;
export async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}
export function summary(phase) {
	console.log(`\n${phase}: ${passed} checks passed.`);
}

/** Poll until fn() is truthy or timeoutMs elapses (returns the last value). */
export async function until(fn, timeoutMs = 3000, stepMs = 20) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() >= deadline) return value;
		await new Promise((r) => setTimeout(r, stepMs));
	}
}
