import {
	SessionManager,
	SettingsManager,
	createAgentSession,
	createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, resolve } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { invariant, privateDirectory } from "./store/files.mjs";
import { assertProviderSelection, providerDescriptor } from "./provider-capability.mjs";
import { seedWorkerSession, workerContextInstructions, assertWorkerContextReady } from "./context/fork.mjs";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function canonicalPath(path) {
	invariant(typeof path === "string" && isAbsolute(path) && resolve(path) === path,
		"Session paths must be absolute and canonical");
	invariant(realpathSync(path) === path, "Session paths must not contain aliases or symlinks");
	return path;
}

/** Read the active branch of native history without constructing a session or exposing a manager. */
export function readSessionHistory(path, cwd, sessionId) {
	const sessionDir = dirname(path);
	const found = findSessionFile(sessionDir, cwd, sessionId, path);
	if (found === undefined) return [];
	const manager = SessionManager.open(found, sessionDir);
	invariant(manager.getSessionId() === sessionId && manager.getCwd() === cwd, "Session history identity changed");
	return manager.getBranch();
}

// This is deliberately not DefaultResourceLoader: even a reload cannot discover local resources.
function isolatedLoader(systemPrompt) {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => { throw new Error("Swarm resource discovery is disabled"); },
		reload: async () => { },
	};
}

function openManager(cwd, sessionDir, sessionId, sessionFile) {
	if (sessionFile === undefined) return SessionManager.create(cwd, sessionDir);
	invariant(dirname(sessionFile) === sessionDir, "Session file must be inside its private directory");
	const found = findSessionFile(sessionDir, cwd, sessionId, sessionFile);
	if (found === undefined) return SessionManager.create(cwd, sessionDir, { id: sessionId });
	const manager = SessionManager.open(found, sessionDir);
	invariant(manager.getSessionId() === sessionId && manager.getCwd() === cwd, "SDK changed session identity");
	return manager;
}

// Pi writes a session file only once it holds a prompt. A worker bound before its first prompt has
// no file yet, and if it was reopened first, that prompt lands in a new file with the same session ID.
function findSessionFile(sessionDir, cwd, sessionId, sessionFile) {
	const found = existsSync(sessionFile) ? sessionFile : SessionManager.findById(cwd, sessionId, sessionDir);
	return found === undefined ? undefined : canonicalPath(found);
}

/** Non-discovering SDK factory for offline mocks or the host's own Pi model runtime.
 * `admitRequest` runs before every model request the session makes. */
export async function createSdkSession({ cwd, sessionDir, sessionId, sessionFile, modelRuntime, selection, systemPrompt, customTools, providerCapability, admitRequest, observeResponse, workerContext }) {
	// Gate before directories, sessions, authentication lookup, or fallback selection.
	const native = providerCapability !== undefined && providerDescriptor(providerCapability).transport === "pi-native";
	if (providerCapability) assertProviderSelection(providerCapability, selection, modelRuntime);
	invariant(native || selection?.provider === "swarm-mock", "This phase only supports the swarm-mock provider");
	invariant(typeof selection.modelId === "string" && THINKING_LEVELS.has(selection.thinkingLevel), "Explicit model and thinking selection required");
	invariant(modelRuntime && typeof modelRuntime.getModel === "function", "Model runtime required");
	const model = modelRuntime.getModel(selection.provider, selection.modelId);
	const modelApi = model?.api;
	invariant(native || (model?.provider === "swarm-mock" && model.api === "swarm-mock" && model.id === selection.modelId),
		"Selected swarm-mock model/API unavailable; fallback is disabled");
	invariant(admitRequest === undefined || typeof admitRequest === "function", "Invalid request admission");
	invariant(typeof systemPrompt === "string" && systemPrompt.trim().length > 0, "Explicit system prompt required");
	invariant(Array.isArray(customTools), "Explicit custom tools required");
	const names = customTools.map((tool) => {
		invariant(tool && typeof tool.name === "string" && tool.name.length > 0 && typeof tool.execute === "function",
			"Invalid custom tool");
		return tool.name;
	});
	invariant(new Set(names).size === names.length, "Duplicate custom tool name");
	canonicalPath(cwd);
	invariant(lstatSync(cwd).isDirectory(), "Workspace must be a directory");
	invariant(typeof sessionDir === "string" && isAbsolute(sessionDir) && resolve(sessionDir) === sessionDir,
		"Session directory must be absolute and canonical");
	canonicalPath(dirname(sessionDir));
	privateDirectory(sessionDir);
	canonicalPath(sessionDir);
	const manager = openManager(cwd, sessionDir, sessionId, sessionFile);
	assertWorkerContextReady(manager);
	invariant(sessionFile === undefined || workerContext?.mode !== "fork" || workerContextInstructions(manager).length > 0,
		"Fork worker history is missing; existing workers cannot be silently reseeded");
	seedWorkerSession(manager, workerContext);
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd, agentDir: sessionDir, modelRuntime, model, thinkingLevel: selection.thinkingLevel,
		scopedModels: [{ model, thinkingLevel: selection.thinkingLevel }],
		sessionManager: manager, settingsManager, resourceLoader: isolatedLoader([systemPrompt, ...workerContextInstructions(manager)].join("\n\n")),
		tools: names, customTools,
	});
	const pinned = Object.freeze({ ...selection });
	const matchesModel = actual => actual?.id === pinned.modelId && actual?.api === modelApi && actual?.provider === pinned.provider;
	const validatePin = () => {
		if (providerCapability) assertProviderSelection(providerCapability, pinned, modelRuntime);
		invariant(matchesModel(session.model) && session.thinkingLevel === pinned.thinkingLevel,
			"SDK changed the approved model/thinking selection");
	};
	try {
		invariant(!modelFallbackMessage && session.isIdle, "SDK model fallback or busy restore is disabled");
		// Pi can restore its last journaled model instead of the explicit factory model.
		// Change it through public idle APIs so native history records the new pin.
		if (!matchesModel(session.model)) await session.setModel(model);
		invariant(session.getAvailableThinkingLevels().includes(pinned.thinkingLevel), "Approved thinking level is unsupported");
		if (session.thinkingLevel !== pinned.thinkingLevel) session.setThinkingLevel(pinned.thinkingLevel);
		validatePin();
		// This boundary covers initial requests, follow-ups, retries and compaction.
		const stream = session.agent.streamFunction;
		let usageObservation = Promise.resolve();
		session.agent.streamFunction = async (...request) => {
			validatePin();
			invariant(matchesModel(request[0]) && (request[2]?.reasoning ?? "off") === pinned.thinkingLevel,
				"Provider request changed the approved model/thinking metadata");
			await usageObservation;
			const requestId = await admitRequest?.();
			validatePin();
			invariant(matchesModel(request[0]) && (request[2]?.reasoning ?? "off") === pinned.thinkingLevel,
				"Provider request changed the approved model/thinking metadata");
			request[2]?.signal?.throwIfAborted();
			let response;
			try { response = await stream(...request); }
			catch (error) { if (observeResponse) await observeResponse(requestId, null); throw error; }
			if (observeResponse) {
				const responseObservation = response.result().then(
					message => observeResponse(requestId, message),
					() => observeResponse(requestId, null),
				);
				// Native compaction may issue multiple requests; retain every observation.
				usageObservation = Promise.all([usageObservation, responseObservation]).then(() => undefined);
				// Retain failures for the next gate/final flush without an unhandled rejection.
				void usageObservation.catch(() => {});
			}
			return response;
		};
		const tools = session.getAllTools();
		invariant(tools.length === names.length && tools.every((tool) => names.includes(tool.name) && tool.sourceInfo?.source === "sdk"),
			"SDK exposed a tool outside the custom tool boundary");
		invariant(session.getActiveToolNames().length === names.length &&
			session.getActiveToolNames().every((name) => names.includes(name)), "SDK changed the custom tool allowlist");
		return { session, manager, flushUsage: () => usageObservation, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() };
	} catch (error) {
		session.dispose();
		throw error;
	}
}
