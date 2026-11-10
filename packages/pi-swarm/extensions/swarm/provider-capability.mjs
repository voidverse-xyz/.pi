import { requireCondition as check } from "./errors.mjs";

// These categories describe the complete context, not a promise to filter sensitive text.
export const PROVIDER_DATA_SCOPE = Object.freeze([
	"objective-and-guidance", "host-instructions", "workspace-content", "tool-definitions-and-results",
	"worker-history", "peer-messages", "compaction-summaries",
]);
const capabilities = new WeakMap();
const fields = "api,endpoint,modelId,outboundData,provider,transport,version";

/** Pure, serializable agreement. Never resolves credentials, catalogs, or model settings. */
export function validateProviderDescriptor(value) {
	check(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === fields,
		"PROVIDER", "Invalid provider descriptor fields");
	check(value.version === 1, "PROVIDER", "Unsupported provider descriptor version");
	const identityPattern = value.transport === "pi-native" ? /^[^\x00-\x20\x7f]{1,512}$/ : /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
	for (const key of ["provider", "modelId", "api"]) {
		check(typeof value[key] === "string" && identityPattern.test(value[key]),
			"PROVIDER", "Invalid provider identity");
	}
	check(["scripted-memory", "pi-native"].includes(value.transport), "PROVIDER", "Unknown transport");
	check(Array.isArray(value.outboundData) && value.outboundData.length === PROVIDER_DATA_SCOPE.length &&
		PROVIDER_DATA_SCOPE.every((scope, index) => value.outboundData[index] === scope),
		"PROVIDER", "The complete worker context data scope must be declared");
	if (value.transport === "scripted-memory") {
		check(value.provider === "swarm-mock" && value.api === "swarm-mock" && value.endpoint === "https://swarm-mock.invalid",
			"PROVIDER", "Scripted transport requires the offline mock identity and endpoint");
	} else if (value.transport === "pi-native") {
		check(value.api !== "pi-virtual", "PROVIDER", "Virtual model routing is unsupported");
		if (value.endpoint !== null) {
			let endpoint;
			try { endpoint = new URL(value.endpoint); } catch { check(false, "PROVIDER", "Invalid informational endpoint"); }
			check(typeof value.endpoint === "string" && value.endpoint.length <= 2048 &&
				["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.href === value.endpoint,
				"PROVIDER", "Invalid informational endpoint");
		}
	}
	return value;
}

/** Host-only configuration capability, NOT human approval or network execution authority. */
export function createProviderCapability(descriptor) {
	validateProviderDescriptor(descriptor);
	const copy = structuredClone(descriptor);
	Object.freeze(copy.outboundData);
	Object.freeze(copy);
	const capability = Object.freeze({ descriptor: copy });
	capabilities.set(capability, copy);
	return capability;
}

export function providerDescriptor(capability) {
	const descriptor = capabilities.get(capability);
	check(descriptor, "PROVIDER", "A host-created provider capability is required; serialized descriptors are not capabilities");
	return descriptor;
}

export function assertProviderSelection(capability, selection, modelRuntime) {
	const descriptor = providerDescriptor(capability);
	// Keep this before ANY runtime method. Default SDK runtimes may resolve ambient auth,
	// OAuth, proxies, provider overrides and request-level model substitutions.
	check(selection?.provider === descriptor.provider && selection.modelId === descriptor.modelId,
		"PROVIDER", "Model selection differs from the immutable provider agreement");
	const model = modelRuntime?.getModel(descriptor.provider, descriptor.modelId);
	check(model?.provider === descriptor.provider && model.id === descriptor.modelId && model.api === descriptor.api,
		"PROVIDER", "Provider/model/API substitution denied");
	if (descriptor.transport === "pi-native") return model;
	// The offline mock has one fixed catalog entry.
	check(model.baseUrl === descriptor.endpoint, "PROVIDER", "Provider endpoint substitution denied");
	check(model.headers === undefined && model.samplingParams === undefined && model.compat === undefined,
		"PROVIDER", "Provider header, routing, and payload overrides are unsupported");
	return model;
}
