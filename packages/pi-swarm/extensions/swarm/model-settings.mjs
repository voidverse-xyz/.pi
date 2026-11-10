import { validId } from "./store/files.mjs";
import { requireCondition as check } from "./errors.mjs";

const SELECTION_FIELDS = ["provider", "modelId", "thinkingLevel"];
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Resolve partial proposal settings without borrowing ambient host settings later. */
export function resolveModelSettings(modelInput, workerModelsInput, defaultSelection, currentWorkerModels = []) {
	const model = resolveSelection(modelInput, defaultSelection);
	const workerModels = normalizeWorkerModels(workerModelsInput === undefined ? currentWorkerModels : workerModelsInput, model);
	return { model, workerModels };
}

export function effectiveWorkerSelection(sessions, workerId) {
	return sessions?.workerModels?.find(entry => entry.workerId === workerId)?.selection ?? sessions?.selection;
}

export function providerAgreements(approval) {
	return approval?.providers ?? (approval?.provider ? [approval.provider] : []);
}

export function validateModelSelection(value, approval) {
	validateSelection(value);
	check(value.provider === "swarm-mock" || providerAgreements(approval).some(provider =>
		provider.transport === "pi-native" && value.provider === provider.provider && value.modelId === provider.modelId),
		"INPUT", "Non-mock selection requires a matching host provider agreement");
}

export function validateWorkerModels(value, approval) {
	const normalized = normalizeWorkerModels(value);
	for (const entry of normalized) validateModelSelection(entry.selection, approval);
	return normalized;
}

function resolveSelection(input, fallback) {
	check(input === undefined || input !== null && typeof input === "object" && !Array.isArray(input), "INPUT", "Invalid model selection");
	if (input !== undefined) check(Object.keys(input).every(key => SELECTION_FIELDS.includes(key)), "INPUT", "Unexpected selection fields");
	const value = { ...fallback, ...input };
	validateSelection(value);
	return value;
}

function validateSelection(value) {
	check(value !== null && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).sort().join() === "modelId,provider,thinkingLevel", "INPUT", "Unexpected or missing selection fields");
	for (const key of ["provider", "modelId"]) check(typeof value[key] === "string" && value[key].trim().length > 0 && value[key].length <= 32768, "INPUT", `Invalid ${key}`);
	check(THINKING_LEVELS.has(value.thinkingLevel), "INPUT", "Invalid thinking level");
}

function normalizeWorkerModels(input, fallback) {
	check(Array.isArray(input), "INPUT", "Worker models must be an array");
	const seen = new Set();
	const entries = input.map(entry => {
		check(entry !== null && typeof entry === "object" && !Array.isArray(entry)
			&& Object.keys(entry).sort().join() === "selection,workerId", "INPUT", "Invalid worker model entry");
		check(validId(entry.workerId) && !["owner", "system"].includes(entry.workerId), "INPUT", "Invalid worker identifier");
		check(!seen.has(entry.workerId), "DUPLICATE", "Duplicate worker model override");
		seen.add(entry.workerId);
		if (fallback === undefined) validateSelection(entry.selection);
		return { workerId: entry.workerId, selection: resolveSelection(entry.selection, fallback) };
	});
	return entries.sort((a, b) => a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0);
}
