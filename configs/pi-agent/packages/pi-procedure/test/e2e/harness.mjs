/**
 * test/e2e/harness.mjs — shared world + scripted mock LLM for the phase files.
 *
 * makeWorld(name) wipes and rebuilds a scratch world (home + project dirs) and
 * returns paths plus makeRunOptions() for ProcedureRun wired to a mock provider.
 * Only the LLM is mocked: real fs, real AgentSessions, real scheduler/journal.
 *
 * The mock matches scripted replies by the agent's label (parsed from the
 * appended identity in the system prompt) and consumes scripts in order; a
 * reply can be plain text, tool calls, or carry delayMs to hold the turn open
 * (for concurrency/stop timing tests). Unscripted calls answer MOCK_DEFAULT_n.
 *
 * NOTE (pi 0.80.10): createAgentSession takes `modelRuntime` — the old
 * ModelRegistry.inMemory harness idiom no longer exists. We build a real
 * ModelRuntime rooted in the fake home and registerProvider() a mock with a
 * custom streamSimple.
 */

import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

export const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
export const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));

const { createProcedureLayout } = await jiti.import(join(EXT, "journal/layout.ts"));
const { ProcedureRun } = await jiti.import(join(EXT, "run.ts"));
const { runAgent } = await jiti.import(join(EXT, "runner/agent-runner.ts"));
const { Scheduler } = await jiti.import(join(EXT, "runner/scheduler.ts"));
const { makeSystemDenyCheck, makeCommandDenyCheck } = await jiti.import(join(EXT, "sandbox/system-deny.ts"));
const { ModelRuntime } = await jiti.import(join(PI_PKG, "dist/core/model-runtime.js"));

export { ProcedureRun };

export async function makeWorld(name) {
	const scratch = join(WORLDS, `${name}-world`);
	rmSync(scratch, { recursive: true, force: true });
	const home = join(scratch, "home");
	const project = join(scratch, "project");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });

	// ---------------------------------------------------------------- mock LLM
	const llmCalls = [];
	const scripts = [];
	let callSeq = 0;
	let concurrent = 0;
	let maxObservedConcurrent = 0;

	function labelOf(systemPrompt) {
		const m = systemPrompt.match(/You are "([^"]+)", a one-shot worker agent/);
		return m ? m[1] : "?";
	}
	function lastUserText(messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				const c = messages[i].content;
				return typeof c === "string" ? c : c.map((x) => x.text ?? "").join("\n");
			}
		}
		return "";
	}
	function mockStream(model, context) {
		const stream = piAi.createAssistantMessageEventStream();
		(async () => {
			concurrent++;
			maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrent);
			try {
				const call = {
					label: labelOf(context.systemPrompt ?? ""),
					systemPrompt: context.systemPrompt ?? "",
					lastUserText: lastUserText(context.messages),
					messageCount: context.messages.length,
				};
				llmCalls.push(call);
				let spec = { text: `MOCK_DEFAULT_${llmCalls.length}` };
				for (let i = 0; i < scripts.length; i++) {
					if (scripts[i].match(call)) {
						spec = scripts.splice(i, 1)[0].reply(call);
						break;
					}
				}
				const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
				const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
				if (spec.tools) {
					if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
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
					if (!thinking && spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
					const content = [
						...(thinking ? [{ type: "thinking", thinking }] : []),
						{ type: "text", text: spec.text },
					];
					const output = { ...base, content, stopReason: "stop" };
					stream.push({ type: "start", partial: output });
					if (thinking) {
						stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: output });
						stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial: output });
						if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
					}
					const textIndex = thinking ? 1 : 0;
					stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
					stream.push({ type: "text_delta", contentIndex: textIndex, delta: spec.text, partial: output });
					stream.push({ type: "text_end", contentIndex: textIndex, content: spec.text, partial: output });
					stream.push({ type: "done", reason: "stop", message: output });
				}
			} finally {
				concurrent--;
			}
			stream.end();
		})();
		return stream;
	}

	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	modelRuntime.registerProvider("mock", {
		name: "Mock",
		baseUrl: "http://mock.invalid",
		apiKey: "k",
		api: "openai-completions",
		streamSimple: mockStream,
		models: [
			{ id: "mock-1", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 },
		],
	});
	const registry = new piSdk.ModelRegistry(modelRuntime);
	await registry.refresh();
	const model = registry.find("mock", "mock-1");
	if (!model) throw new Error("mock model did not register");

	const layout = createProcedureLayout(project, { home });

	/** Build ProcedureRunOptions for a run in this world. */
	function makeRunOptions(overrides = {}) {
		const protectedDirs = [layout.proceduresStateRoot, layout.globalProceduresDir, layout.projectProceduresDir];
		return {
			args: undefined,
			layout,
			scheduler: new Scheduler(overrides.maxConcurrent ?? 4),
			confirm: async () => ({ approved: false, note: "denied by test default" }),
			systemDeny: makeSystemDenyCheck(protectedDirs, realpathSync),
			systemDenyCommand: makeCommandDenyCheck(protectedDirs, realpathSync, home),
			defaultModel: model,
			modelRuntime,
			resolveModel: (ref) => {
				const found = ref === "mock/mock-1" ? model : undefined;
				if (!found) throw new Error(`unknown model "${ref}"`);
				return found;
			},
			runAgentImpl: runAgent,
			...overrides,
		};
	}

	return {
		scratch,
		home,
		project,
		agentDir,
		layout,
		model,
		modelRuntime,
		llmCalls,
		scripts,
		makeRunOptions,
		get maxObservedConcurrent() {
			return maxObservedConcurrent;
		},
	};
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
