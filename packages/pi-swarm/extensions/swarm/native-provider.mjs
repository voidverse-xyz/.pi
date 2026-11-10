import { isDeepStrictEqual } from "node:util";
import { requireCondition as check } from "./errors.mjs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProviderCapability, PROVIDER_DATA_SCOPE } from "./provider-capability.mjs";

/** Reuse only the public host runtime; resolving a selection never looks up credentials. */
export function nativeModelRuntime({ modelRuntime, modelRegistry } = {}) {
	check((modelRuntime instanceof ModelRuntime && modelRegistry === undefined) ||
		(modelRegistry instanceof ModelRegistry && modelRuntime === undefined), "PROVIDER", "Supply one public Pi ModelRuntime or ModelRegistry");
	const runtime = modelRuntime ?? modelRegistry.runtime;
	check(runtime instanceof ModelRuntime, "PROVIDER", "The model registry does not expose a Pi ModelRuntime");
	return runtime;
}

export function createNativeSelection(modelRuntime, selection) {
	const runtime = nativeModelRuntime({ modelRuntime });
	const model = runtime.getModel(selection?.provider, selection?.modelId);
	check(model && model.api !== "pi-virtual" && (!model.type || model.type === "chat"), "PROVIDER", "An explicit physical chat model is required; automatic routing is disabled");
	check(getSupportedThinkingLevels(model).includes(selection.thinkingLevel), "MODEL", "Unsupported thinking selection");
	const providerCapability = createProviderCapability({
		version: 1, provider: model.provider, modelId: model.id,
		api: model.api, endpoint: informationalEndpoint(model.baseUrl), transport: "pi-native", outboundData: [...PROVIDER_DATA_SCOPE]
	});
	return Object.freeze({ modelRuntime: runtime, mainModel: structuredClone(model), thinkingLevel: selection.thinkingLevel, providerCapability });
}

/** Host-only model selection. Reuses the host's Pi runtime as is; never constructs or refreshes one.
 * Static public imports let Pi's normal loader supply its own SDK identity; dynamic bare
 * imports from native ESM bypass that mapping.
 */
export async function createNativeRuntime({ modelRuntime, modelRegistry, mainModel, thinkingLevel = "off", override } = {}) {
	const runtime = nativeModelRuntime({ modelRuntime, modelRegistry });
	const selected = override?.model ?? mainModel;
	const model = runtime.getModel(selected?.provider, selected?.id);
	check(model && model.api !== "pi-virtual" && (!model.type || model.type === "chat"), "PROVIDER", "An explicit physical chat model is required; automatic routing is disabled");
	check(isDeepStrictEqual(model, selected), "PROVIDER", "Selected model differs from the host catalog");
	return createNativeSelection(runtime, { provider: model.provider, modelId: model.id, thinkingLevel: override?.thinkingLevel ?? thinkingLevel });
}

// Informational catalog URL only. Omit credential-bearing/opaque routing metadata.
function informationalEndpoint(value) {
	try {
		const url = new URL(value);
		if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url.href;
	} catch { }
	return null;
}
