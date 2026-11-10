/** Select one bounded handoff per board transition; workers retain task ownership decisions. */
export function coordinationHandoffs(state, unavailable = new Set(), seen = new Set(), preferredWorkerId) {
	if (state.status !== "running" || state.workspace?.operations.some(operation => operation.uncertain)) return [];
	const idle = state.workers.filter(worker => !unavailable.has(worker.id) && !state.tasks.some(task => task.assignment?.workerId === worker.id));
	const handoffs = [];
	const reserved = new Set();
	const offer = (key, candidates, reason) => {
		if (seen.has(key)) return;
		const worker = candidates.find(candidate => !reserved.has(candidate.id));
		if (!worker) return;
		reserved.add(worker.id);
		handoffs.push({ key, workerId: worker.id, reason });
	};
	const prefix = `${state.cycle}:${state.generation}:${state.guidanceRevision}`;
	const preferred = [...idle].sort((a, b) => Number(b.id === preferredWorkerId) - Number(a.id === preferredWorkerId));
	for (const task of state.tasks) {
		if (task.assignment || task.pending || task.failures >= state.limits.attempts || task.blocker) continue;
		const candidate = state.workspace?.candidates.find(candidate => candidate.taskId === task.id);
		const key = JSON.stringify([prefix, task.id, task.status, task.failures, candidate?.assignmentId, candidate?.fingerprint]);
		if (task.status === "submitted") {
			const independent = state.workers.filter(worker => !task.contributors.includes(worker.id) && !state.workspace?.contributors.includes(worker.id));
			if (independent.length) {
				offer(key, idle.filter(worker => independent.some(peer => peer.id === worker.id)), `Candidate ${task.id} has settled. Claim its independent review and coordinate directly with its contributors.`);
			} else {
				offer(key, preferred, `Candidate ${task.id} has settled and needs an independent reviewer. Recruit a suitable peer within approved limits, or escalate the capacity blocker to @main; do not self-approve.`);
			}
		}
	}
	for (const task of state.tasks) {
		if (task.status !== "ready" || task.assignment || task.pending || task.blocker || task.failures >= state.limits.attempts) continue;
		if (!task.dependencies.every(id => state.tasks.find(dependency => dependency.id === id)?.status === "done")) continue;
		const score = worker => task.contributors.includes(worker.id) ? 2 : Number(state.tasks.some(item => item.contributors.includes(worker.id)));
		const candidates = [...preferred].sort((a, b) => score(b) - score(a));
		offer(JSON.stringify([prefix, task.id, "ready", task.failures]), candidates, `Task ${task.id} is ready and its dependencies have settled. Claim suitable work and coordinate with peers without asking main to assign it.`);
	}
	if (!unavailable.size && !state.sessions?.turns.length && state.tasks.length && state.tasks.every(task => task.status === "done" && !task.assignment && !task.pending) && !state.workspace?.operations.length) {
		offer(`${prefix}:final:${state.workspace?.fingerprint}`, preferred, "All board tasks have passed independent review. Check acceptance-criterion coverage and request swarm_finish with an appropriate final verification command; report any gaps honestly.");
	}
	return handoffs;
}
