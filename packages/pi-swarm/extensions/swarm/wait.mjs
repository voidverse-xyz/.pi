import { requireCondition as check } from "./errors.mjs";
import { aggregateUsageLimitReason, workerUsageBlockers } from "./usage.mjs";

/** Ignore clock ticks and routine mail/counter changes; observe settled task states. */
export function transitionKey(snapshot) {
	const run = snapshot?.run;
	return JSON.stringify(run ? { status: run.status, cycle: run.cycle, generation: run.generation, guidanceRevision: run.guidanceRevision, ownershipHeld: snapshot.ownershipHeld ?? null,
		tasks: run.tasks.map(task => ({ id: task.id, status: task.status, blocker: task.blocker ?? null })),
		uncertain: run.workspace?.operations.filter(operation => operation.uncertain).length ?? null,
		errors: Boolean(snapshot.errors?.length || snapshot.driver?.errors?.length), usageBlocker: aggregateUsageLimitReason(run), workerUsageBlockers: workerUsageBlockers(run),
	} : { status: "unattached" });
}

export function waitForChange(source, { timeoutMs = 60000, signal } = {}) {
	check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000, "INPUT", "Wait must be between 1 and 60000 ms");
	const initial = transitionKey(source.snapshot());
	if (signal?.aborted) return Promise.resolve({ changed: false, reason: "cancelled" });
	return new Promise(resolve => {
		let timer, unsubscribe, finished = false;
		const finish = (changed, reason) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer); unsubscribe?.(); signal?.removeEventListener("abort", abort);
			resolve({ changed, reason });
		};
		const abort = () => finish(false, "cancelled");
		unsubscribe = source.subscribe(() => { if (transitionKey(source.snapshot()) !== initial) finish(true, "material change"); });
		if (finished) { unsubscribe?.(); return; }
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => finish(false, "timeout; stop polling and use native mail or the local watcher"), timeoutMs);
		if (signal?.aborted) abort();
		else if (transitionKey(source.snapshot()) !== initial) finish(true, "material change");
	});
}
