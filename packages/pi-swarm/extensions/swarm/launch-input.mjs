import { requireCondition as check } from "./errors.mjs";

/** Main-selected settings are proposed as data; none of these fields grants consent. */
export async function requestLaunchSpecification(_ctx, input, _signal, current) {
	if (!current()) return;
	check(input && Object.keys(input).every(key => ["objective", "criteria", "scope", "limits", "codingTools", "instructions", "model", "workerModels", "initialWorker", "contextMode", "workerContext", "workerContexts"].includes(key)), "INPUT", "Unsupported launch setting");
	check(typeof input.objective === "string" && input.objective.trim().length > 0 && input.objective.length <= 32768,
		"INPUT", "The main agent must supply a complete objective");
	return {
		objective: input.objective,
		criteria: input.criteria ?? ["Satisfy the behavior and verification requirements in the approved objective."],
		scope: input.scope ?? ["Work only on the requested task; honor the objective's file and dependency constraints."],
		...Object.fromEntries(["limits", "codingTools", "instructions", "model", "workerModels", "initialWorker", "workerContext", "workerContexts"].filter(key => input[key] !== undefined).map(key => [key, input[key]]))
	};
}
