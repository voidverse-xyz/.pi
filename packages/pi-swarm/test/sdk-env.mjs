import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const mockSelection = Object.freeze({ provider: "swarm-mock", modelId: "scripted", thinkingLevel: "off" });

function waitForAbort(signal) {
	if (!signal) throw new Error("Mock stream requires an abort signal");
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

/** Each request consumes one step, or invokes script({model, context, options, index}). */
export async function createMockRuntime(script = []) {
	const calls = [];
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsPath: null,
		refreshOnCreate: false, allowModelNetwork: false,
	});
	modelRuntime.registerProvider("swarm-mock", {
		name: "Swarm offline mock", api: "swarm-mock", baseUrl: "https://swarm-mock.invalid", apiKey: "offline-mock",
		models: [{
			id: "scripted", name: "Scripted mock", reasoning: true, input: ["text"],
			contextWindow: 128000, maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
		streamSimple(model, context, options = {}) {
			const stream = createAssistantMessageEventStream();
			const capturedContext = {
				...context, messages: structuredClone(context.messages),
				tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
			};
			const request = { model, context: capturedContext, options, index: calls.length };
			calls.push(request);
			const output = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: {
					input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending", timestamp: Date.now(),
			};
			(async () => {
				try {
					stream.push({ type: "start", partial: output });
					const step = typeof script === "function" ? await script(request) : script[request.index];
					if (!step) throw new Error(`Mock script exhausted at request ${request.index}`);
					if (step.waitForAbort) await waitForAbort(options.signal);
					options.signal?.throwIfAborted();
					if (step.error) throw new Error(step.error);
					if (step.usage) output.usage = structuredClone(step.usage);
					if (step.text !== undefined) {
						output.content.push({ type: "text", text: "" });
						stream.push({ type: "text_start", contentIndex: 0, partial: output });
						output.content[0].text = step.text;
						stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: output });
						stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: output });
					}
					for (const call of step.toolCalls ?? []) {
						const contentIndex = output.content.length;
						const toolCall = { type: "toolCall", id: call.id ?? `mock-${request.index}-${contentIndex}`, name: call.name, arguments: {} };
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						toolCall.arguments = structuredClone(call.arguments ?? {});
						stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
						stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					}
					output.stopReason = step.toolCalls?.length ? "toolUse" : "stop";
					stream.push({ type: "done", reason: output.stopReason, message: output });
				} catch (error) {
					output.stopReason = options.signal?.aborted ? "aborted" : "error";
					output.errorMessage = error.message;
					stream.push({ type: "error", reason: output.stopReason, error: output });
				} finally { stream.end(); }
			})();
			return stream;
		},
	});
	return { modelRuntime, model: modelRuntime.getModel("swarm-mock", "scripted"), selection: { ...mockSelection }, calls };
}
