import { SwarmError } from "./errors.mjs";

import { usageTotals, aggregateUsageLimitReason, workerUsageBlockers } from "./usage.mjs";

const executing = new Set(["running", "verifying", "pausing", "stopping", "failing"]);
const knownCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function validateWarningThreshold(value = 0.2) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 0.5) throw new SwarmError("INPUT", "Warning threshold must be between 0 and 0.5");
	return value;
}

/** Presentation only: never advances the reducer clock or changes admission. */
export function budgetStatus(snapshot, warningThreshold = 0.2) {
	validateWarningThreshold(warningThreshold);
	const run = snapshot.run;
	const allowance = (used, allowed, admission) => {
		used = knownCount(used); allowed = knownCount(allowed);
		const remaining = used !== null && allowed !== null ? Math.max(0, allowed - used) : null;
		return { used, allowed, remaining, state: remaining === null ? "unknown" : remaining === 0 ? "exhausted" : remaining / allowed <= warningThreshold ? "near" : "available", blocks: remaining === 0 ? admission : null };
	};
	const usage = usageTotals(run);
	return {
		warningThreshold,
		modelRequests: allowance(usage.measured ? usage.total.requests : null, run.limits?.modelRequests, "new worker model requests"),
		uncachedInputTokens: allowance(usage.measured ? usage.total.input : null, run.limits?.uncachedInputTokens, "new worker model requests after measured response"),
		outputTokens: allowance(usage.measured ? usage.total.output : null, run.limits?.outputTokens, "new worker model requests after measured response"),
		usageBlocker: aggregateUsageLimitReason(run), workerUsageBlockers: workerUsageBlockers(run),
		duration: { ...allowance(run.elapsedMs, run.limits?.durationMs, "new execution"), sampledAtMs: run.lastAtMs ?? null, accounting: "journal event active time", advancing: executing.has(run.status), deadline: null, observation: executing.has(run.status) ? "Unsampled active time may remain since sampledAtMs; next event charges it." : "Active-time allowance is paused." },
		workers: allowance(run.workers?.length, run.limits?.agents, "new worker identities"),
		taskCreations: allowance(run.tasksCreated, run.limits?.tasks, "new tasks"),
		nativeTurns: allowance(run.sessions?.turns?.length, run.limits?.active, "new native turns"),
		assignedTasks: (run.tasks ?? []).filter(task => task.assignment).length,
		queuedWorkers: Array.isArray(snapshot.driver?.queued) ? snapshot.driver.queued.length : null,
		runtimeActiveWorkers: Array.isArray(snapshot.driver?.active) ? snapshot.driver.active.length : null,
		sdkIdle: typeof snapshot.driver?.sdkIdle === "boolean" ? snapshot.driver.sdkIdle : null,
	};
}

export function failureAllowance(task, allowed, warningThreshold = 0.2) {
	const used = knownCount(task.failures);
	allowed = knownCount(allowed);
	const remaining = used !== null && allowed !== null ? Math.max(0, allowed - used) : null;
	return { used, allowed, remaining, state: remaining === null ? "unknown" : remaining === 0 ? "exhausted" : remaining / allowed <= warningThreshold ? "near" : "available", pendingSettlement: Boolean(task.pending), blockedAdmission: remaining === 0 };
}
