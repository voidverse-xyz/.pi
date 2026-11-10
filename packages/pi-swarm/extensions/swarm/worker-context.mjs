import { isBoardMessage } from "./messaging.mjs";
import { budgetStatus, failureAllowance } from "./status.mjs";
import { usageTotals } from "./usage.mjs";

/** Bounded work data. Authority/guidance is never summarized or truncated. */
export function taskRows(tasks, offset = 0, limit = 20) {
	return tasks.slice(offset, offset + limit).map(task => ({
		id: task.id, title: task.title?.slice(0, 512), titleTruncated: (task.title?.length ?? 0) > 512, criteria: task.criteria, dependencies: task.dependencies,
		status: task.status, assignment: task.assignment ? { workerId: task.assignment.workerId, kind: task.assignment.kind } : null,
		pendingSettlement: Boolean(task.pending), blocker: task.blocker, failures: task.failures,
		candidateAvailable: Boolean(task.candidate), reviews: task.reviews?.length ?? 0,
	}));
}

export function workerStatus(state, workerId, coordination) {
	const ordered = [...state.tasks].sort((a, b) => Number(b.assignment?.workerId === workerId) - Number(a.assignment?.workerId === workerId));
	return {
		status: state.status, revision: state.revision, cycle: state.cycle, generation: state.generation,
		guidanceRevision: state.guidanceRevision, guidance: state.guidance,
		budgets: budgetStatus({ run: state }), usage: usageTotals(state),
		workers: state.workers.map(worker => ({ id: worker.id, specialization: worker.specialization })),
		tasks: taskRows(ordered), taskCount: ordered.length, tasksTruncated: ordered.length > 20,
		exhaustedTaskCount: state.tasks.filter(task => failureAllowance(task, state.limits.attempts).blockedAdmission).length,
		messageCount: state.messages.length, coordination,
		details: "swarm_tasks for task pages/details; swarm_history for conversations",
	};
}

export function incomingMessages(state, workerId, messages) {
	return messages.filter(message => message.to === workerId || isBoardMessage(message, state.workers) && message.from !== workerId)
		.map(message => ({ id: message.id, from: message.from, to: message.to, topic: message.topic, text: message.text, cycle: message.cycle }));
}
