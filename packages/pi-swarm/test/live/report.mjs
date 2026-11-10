// Offline-testable reporting/cleanup; no SDK, configuration, or provider access.
export async function finishTrial({ host, started, writeResult, onFailure }) {
	let settlement;
	try {
		settlement = await host.pause({ stop: true, timeoutMs: 10000 });
	} catch (error) {
		onFailure("cleanup", error);
		return;
	}
	try {
		const snapshot = host.snapshot();
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		let responses = 0;
		for (const worker of snapshot.run?.workers ?? []) {
			for (const entry of host.history(worker.id)) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				responses++;
				for (const key of Object.keys(usage)) usage[key] += entry.message.usage?.[key] ?? 0;
			}
		}
		const result = {
			status: snapshot.run?.status, elapsedMs: started ? Date.now() - started : 0,
			responses, usage, cost: "unknown", settled: settlement.settled,
			tasks: snapshot.run?.tasks.map(task => ({ id: task.id, status: task.status, failures: task.failures,
				reviews: task.reviews.map(review => ({ workerId: review.workerId, approved: review.approved })) })),
			pendingTurns: snapshot.run?.sessions.turns.length,
			pendingOperations: snapshot.run?.workspace.operations.length,
		};
		await writeResult(result);
	} catch (error) {
		onFailure("reporting", error);
	} finally {
		if (settlement.settled) {
			try { await host.close(); }
			catch (error) { onFailure("cleanup", error); }
		} else onFailure("cleanup", { code: "UNSETTLED" });
	}
}
