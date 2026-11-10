// Offline host fixture: real public Pi auth/registry dispatch, no HTTP adapter or mock runtime.
import {
	createAssistantMessageEventStream, createProvider, envApiKeyAuth, InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { guardNetwork } from "../network-guard.mjs";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const resourceKey = Symbol.for("swarm.terminal.native-guard");

export async function createNativeWorker(record, nextStep) {
	let resource = globalThis[resourceKey];
	if (!resource) {
		resource = { cleanup: [], sequence: 0 };
		guardNetwork({ after: callback => resource.cleanup.push(callback) });
		globalThis[resourceKey] = resource;
	}
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("terminal-native", () => ({ type: "api_key", key: "memory-only-fixture-key" }));
	const source = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const model = { id: "native-scripted", name: "Native scripted fixture", provider: "terminal-native", api: "openai-responses",
		baseUrl: "https://native.invalid/v1", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192,
		headers: { "X-Fixture": "native-host" }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const dispatch = (selected, context, options) => {
		assert.equal(options.apiKey, "memory-only-fixture-key");
		assert.equal(options.headers["X-Fixture"], "native-host");
		assert.equal(selected.api, "openai-responses");
		assert.equal(selected.provider, model.provider);
		const id = ++resource.sequence;
		record({ type: "native-request", id, provider: selected.provider, model: selected.id, api: selected.api,
			authVerified: true, headersVerified: true, messages: context.messages });
		const stream = createAssistantMessageEventStream();
		const message = { role: "assistant", content: [], api: selected.api, provider: selected.provider, model: selected.id,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
		void (async () => {
			try {
				stream.push({ type: "start", partial: message });
				const step = await nextStep({ options });
				if (step.waitForAbort && !options.signal.aborted) await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
				options.signal.throwIfAborted();
				for (const [index, call] of (step.toolCalls ?? []).entries()) {
					const toolCall = { type: "toolCall", id: `native-${id}-${index}`, name: call.name, arguments: call.arguments };
					message.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
				}
				record({ type: "native-response", id, tools: step.toolCalls ?? [] });
				message.stopReason = step.toolCalls?.length ? "toolUse" : "stop";
				stream.push({ type: "done", reason: message.stopReason, message });
			} catch (error) {
				if (options.signal.aborted) {
					record({ type: "native-draining", id });
					await new Promise(resolve => setTimeout(resolve, 250));
				}
				message.stopReason = options.signal.aborted ? "aborted" : "error";
				message.errorMessage = error.message;
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} finally {
				stream.end();
				record({ type: "native-settled", id });
			}
		})();
		return stream;
	};
	source.registerNativeProvider(createProvider({ id: model.provider, auth: { apiKey: envApiKeyAuth("Fixture", []) },
		models: [model], api: { stream: dispatch, streamSimple: dispatch } }));
	record({ type: "native-binding", source: "ModelRegistry", api: model.api });
	return { modelRegistry: new ModelRegistry(source), mainModel: source.getModel(model.provider, model.id),
		close() {
			for (const callback of resource.cleanup) callback();
			delete globalThis[resourceKey];
			record({ type: "native-network-guard", attempts: 0 });
		} };
}
