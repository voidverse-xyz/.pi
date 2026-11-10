import { requireCondition as check } from "./errors.mjs";

export const USAGE_LIMITS = ["modelRequests", "uncachedInputTokens", "outputTokens", "workerModelRequests", "workerUncachedInputTokens", "workerOutputTokens"];
const fields = ["input", "cacheRead", "cacheWrite", "output"];

/** Measured worker usage only; reasoning is already included in output. */
export function usageTotals(state) {
	const workers = state.sessions?.usage ?? [];
	const total = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unknownResponses: 0, pendingResponses: 0, unresolvedResponses: 0 };
	for (const worker of workers) {
		for (const key of ["requests", ...fields, "unknownResponses"]) total[key] += worker[key];
		total.pendingResponses += worker.pending.length;
		if (!state.sessions.turns.some(turn => turn.workerId === worker.workerId)) total.unresolvedResponses += worker.pending.length;
	}
	return { scope: "instrumented worker requests; owner usage excluded", measured: Boolean(state.sessions?.usage), total,
		workers: workers.map(({ pending, completed, ...worker }) => {
			const configured = state.limits ?? {};
			const values = [["modelRequests", "workerModelRequests", worker.requests], ["uncachedInputTokens", "workerUncachedInputTokens", worker.input], ["outputTokens", "workerOutputTokens", worker.output]];
			const budgets = Object.fromEntries(values.filter(([, key]) => configured[key] !== undefined).map(([name, key, used]) => {
				const allowed = configured[key], remaining = Math.max(0, allowed - used);
				return [name, { used, allowed, remaining, state: remaining === 0 ? "exhausted" : remaining / allowed <= 0.2 ? "near" : "available" }];
			}));
			return { ...worker, pendingResponses: pending.length, ...(Object.keys(budgets).length ? { budgets } : {}) };
		}) };
}

/** Limits shared by every worker, independent of worker identity. */
export function aggregateUsageLimitReason(state) {
	const { total } = usageTotals(state);
	const limits = state.limits ?? {};
	if (limits.modelRequests !== undefined && total.requests >= limits.modelRequests) return "modelRequests";
	const tokenLimited = limits.uncachedInputTokens !== undefined || limits.outputTokens !== undefined;
	if (tokenLimited && (total.unknownResponses || total.unresolvedResponses)) return "unmeasured response";
	if (limits.uncachedInputTokens !== undefined && total.input >= limits.uncachedInputTokens) return "uncachedInputTokens";
	if (limits.outputTokens !== undefined && total.output >= limits.outputTokens) return "outputTokens";
	return null;
}

/** Only this worker's limits; callers must also check aggregate limits. */
export function workerUsageLimitReason(state, workerId) {
	const limits = state.limits ?? {};
	for (const worker of state.sessions?.usage ?? []) {
		if (worker.workerId !== workerId) continue;
		if (limits.workerModelRequests !== undefined && worker.requests >= limits.workerModelRequests) return `${worker.workerId}: workerModelRequests`;
		const tokenLimited = limits.workerUncachedInputTokens !== undefined || limits.workerOutputTokens !== undefined;
		if (tokenLimited && (worker.unknownResponses || worker.pending.length && !state.sessions.turns.some(turn => turn.workerId === worker.workerId))) return `${worker.workerId}: unmeasured response`;
		if (limits.workerUncachedInputTokens !== undefined && worker.input >= limits.workerUncachedInputTokens) return `${worker.workerId}: workerUncachedInputTokens`;
		if (limits.workerOutputTokens !== undefined && worker.output >= limits.workerOutputTokens) return `${worker.workerId}: workerOutputTokens`;
	}
	return null;
}

/** Worker-specific blockers are visible without presenting them as a run-wide stop. */
export function workerUsageBlockers(state) {
	return (state.sessions?.usage ?? []).map(({ workerId }) => ({ workerId, reason: workerUsageLimitReason(state, workerId) }))
		.filter(row => row.reason !== null);
}

/** Combined status preserved for existing callers. */
export function usageLimitReason(state) {
	const aggregate = aggregateUsageLimitReason(state);
	if (aggregate) return aggregate;
	for (const worker of state.sessions?.usage ?? []) {
		const reason = workerUsageLimitReason(state, worker.workerId);
		if (reason) return reason;
	}
	return null;
}

export function recordRequest(state, payload) {
	check(state.status === "running" && state.sessions.turns.some(turn => turn.workerId === payload.workerId), "FENCED", "A current worker turn is required");
	check(!aggregateUsageLimitReason(state), "USAGE_LIMIT", "Aggregate model allowance exhausted or unmeasured");
	check(!workerUsageLimitReason(state, payload.workerId), "USAGE_LIMIT", "Worker model allowance exhausted or unmeasured");
	check(typeof payload.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(payload.id), "INPUT", "Invalid request identifier");
	state.sessions.usage ??= [];
	let worker = state.sessions.usage.find(row => row.workerId === payload.workerId);
	if (!worker) {
		worker = { workerId: payload.workerId, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unknownResponses: 0, pending: [], completed: [] };
		state.sessions.usage.push(worker);
	}
	check(!state.sessions.usage.some(row => row.pending.includes(payload.id) || row.completed.includes(payload.id)), "DUPLICATE", "Request identifier already recorded");
	worker.requests++;
	worker.pending.push(payload.id);
}

export function recordResponse(state, payload) {
	const worker = state.sessions.usage?.find(row => row.workerId === payload.workerId);
	check(worker?.pending.includes(payload.id), "STATE", "Response must match an outstanding request");
	if (payload.usage === null) worker.unknownResponses++;
	else {
		check(payload.usage && Object.keys(payload.usage).sort().join() === [...fields].sort().join(), "INPUT", "Invalid usage fields");
		for (const key of fields) {
			check(Number.isSafeInteger(payload.usage[key]) && payload.usage[key] >= 0, "INPUT", "Invalid measured token count");
			worker[key] += payload.usage[key];
			check(Number.isSafeInteger(worker[key]), "INPUT", "Usage counter overflow");
		}
	}
	worker.pending = worker.pending.filter(id => id !== payload.id);
	worker.completed.push(payload.id);
}

export function measuredUsage(message) {
	if (["error", "aborted"].includes(message?.stopReason)) return null;
	const usage = message?.usage;
	if (!usage || fields.some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0)) return null;
	return Object.fromEntries(fields.map(key => [key, usage[key]]));
}
