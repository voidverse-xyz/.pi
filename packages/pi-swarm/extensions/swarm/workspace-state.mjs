import { requireCondition as check } from "./errors.mjs";
import { validId } from "./store/files.mjs";

export const WORKSPACE_FIELDS = {
	"workspace.enable": ["fingerprint"],
	"workspace.observe": ["fingerprint"],
	"workspace.start": ["id", "taskId", "assignmentId", "kind", "command", "paths", "before"],
	"workspace.finish": ["id", "after", "exitCode", "outcome"],
	"workspace.uncertain": ["id"],
	"workspace.reconcile": ["fingerprint", "settled"],
	"workspace.candidate": ["taskId", "assignmentId", "fingerprint", "receipts"],
};

function digest(value) {
	check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "INPUT", "Invalid workspace fingerprint");
}
function taskFor(state, id) {
	const task = state.tasks.find(task => task.id === id);
	check(task, "NOT_FOUND", "Task does not exist");
	return task;
}

/** Conservative relevance: every workspace change invalidates all older candidates. */
export function invalidateCandidates(state, fingerprint) {
	const workspace = state.workspace;
	if (!workspace) return;
	workspace.fingerprint = fingerprint;
	for (const candidate of workspace.candidates) {
		if (candidate.fingerprint === fingerprint && candidate.guidanceRevision === state.guidanceRevision) continue;
		const task = taskFor(state, candidate.taskId);
		task.candidate = null;
		if (task.pending?.kind === "review" || task.pending?.kind === "submit") task.pending = null;
		if (!task.assignment && ["done", "submitted"].includes(task.status)) task.status = "ready";
	}
	workspace.candidates = workspace.candidates.filter(candidate => candidate.fingerprint === fingerprint && candidate.guidanceRevision === state.guidanceRevision);
}

export function candidateFor(state, taskId) {
	return state.workspace?.candidates.find(candidate => candidate.taskId === taskId);
}

export function requireCandidate(state, taskId, assignmentId) {
	if (!state.workspace) return;
	const candidate = candidateFor(state, taskId);
	check(candidate && candidate.fingerprint === state.workspace.fingerprint && candidate.guidanceRevision === state.guidanceRevision, "EVIDENCE", "Current workspace candidate and verification receipts required");
	if (assignmentId !== undefined) check(candidate.assignmentId === assignmentId, "EVIDENCE", "Candidate belongs to an earlier build assignment");
}

function receiptRejection(state, receipt, fingerprint) {
	if (!receipt) return "missing-receipt";
	if (receipt.outcome !== "succeeded") return "unsuccessful-outcome";
	if (receipt.exitCode !== 0) return "unsuccessful-exit";
	if (receipt.cycle !== state.cycle) return "wrong-cycle";
	if (receipt.generation !== state.generation) return "wrong-generation";
	if (receipt.guidanceRevision !== state.guidanceRevision) return "changed-guidance";
	if (receipt.before !== fingerprint && receipt.after !== fingerprint) return "stale-before-and-after";
	if (receipt.before !== fingerprint) return "stale-before";
	if (receipt.after !== fingerprint) return "stale-after";
	return null;
}

function receiptUsable(state, receipt, fingerprint) {
	return receiptRejection(state, receipt, fingerprint) === null;
}

export function requireFinalEvidence(state, evidenceId) {
	if (!state.workspace) return;
	const receipt = state.workspace.receipts.find(receipt => receipt.id === evidenceId);
	check(receipt?.kind === "final" && receiptUsable(state, receipt, state.workspace.fingerprint), "EVIDENCE", "Successful, current final-check execution required");
	check(state.tasks.every(task => task.status === "done"), "INCOMPLETE", "Workspace changed after review");
	for (const task of state.tasks) requireCandidate(state, task.id);
}

function attributeContribution(state, operation) {
	if (!operation.workerId) return;
	// Evidence covers the whole checkout, so independence must cover it too.
	if (!state.workspace.contributors.includes(operation.workerId)) state.workspace.contributors.push(operation.workerId);
	const task = taskFor(state, operation.taskId);
	if (!task.contributors.includes(operation.workerId)) task.contributors.push(operation.workerId);
	if (task.assignment?.kind === "review") {
		task.assignment.kind = "build";
		task.status = "assigned";
		task.pending = null;
		task.candidate = null;
		state.workspace.candidates = state.workspace.candidates.filter(candidate => candidate.taskId !== task.id);
	}
}

/** Called only after common event/revision/authority checks by the run reducer. */
export function reduceWorkspace(state, event) {
	const p = event.payload;
	if (event.type === "workspace.enable") {
		check(event.actor === "owner" && state.status === "paused" && !state.workspace, "STATE", "Enable workspace safeguards on a paused run once");
		check(!state.tasks.some(task => task.assignment), "UNSETTLED", "Settle assignments before enabling workspace safeguards");
		digest(p.fingerprint);
		state.workspace = { fingerprint: p.fingerprint, operations: [], receipts: [], candidates: [], contributors: [] };
		// Legacy mock verdicts cannot become real verification by enabling this layer.
		for (const task of state.tasks) {
			if (["submitted", "done"].includes(task.status)) task.status = "ready";
			task.candidate = null;
		}
		return;
	}
	check(state.workspace, "STATE", "Workspace safeguards are not enabled");
	const workspace = state.workspace;
	check(event.actor === (event.type === "workspace.reconcile" ? "owner" : "system"), "AUTHORITY", "Trusted workspace capability required");
	switch (event.type) {
		case "workspace.observe":
			digest(p.fingerprint);
			invalidateCandidates(state, p.fingerprint);
			break;
		case "workspace.start": {
			check(validId(p.id) && ![...workspace.operations, ...workspace.receipts].some(operation => operation.id === p.id), "DUPLICATE", "Execution identifier is invalid or already used");
			digest(p.before);
			check(["write", "edit", "shell", "final"].includes(p.kind), "INPUT", "Unknown workspace operation");
			check(Array.isArray(p.paths) && p.paths.every(path => typeof path === "string" && path.length > 0), "INPUT", "Invalid execution paths");
			if (["shell", "final"].includes(p.kind)) check(typeof p.command === "string" && p.command.trim(), "INPUT", "Command required");
			else check(p.command === null && p.paths.length > 0, "INPUT", "Mutation paths required");
			let workerId = null;
			if (p.kind === "final") {
				check(state.status === "verifying" && p.taskId === null && p.assignmentId === null, "STATE", "Final checks require the verification phase");
				check(workspace.operations.length === 0, "UNSETTLED", "Other operations remain active");
			} else {
				check(state.status === "running", "STATE", "Run is not accepting workspace work");
				const task = taskFor(state, p.taskId);
				check(task.assignment?.id === p.assignmentId && task.assignment.generation === state.generation && !task.pending, "FENCED", "Assignment is not current");
				workerId = task.assignment.workerId;
				check(state.workers.find(worker => worker.id === workerId)?.guidanceRevision === state.guidanceRevision, "GUIDANCE", "Current guidance must be acknowledged");
			}
			invalidateCandidates(state, p.before);
			workspace.operations.push({ ...structuredClone(p), workerId, cycle: state.cycle, generation: state.generation, guidanceRevision: state.guidanceRevision, startedAt: event.atMs, uncertain: false });
			break;
		}
		case "workspace.uncertain": {
			const operation = workspace.operations.find(operation => operation.id === p.id);
			check(operation, "NOT_FOUND", "Execution does not exist");
			operation.uncertain = true;
			break;
		}
		case "workspace.finish": {
			const operation = workspace.operations.find(operation => operation.id === p.id);
			check(operation, "FENCED", "Execution is no longer active");
			check(["succeeded", "failed", "cancelled", "unknown"].includes(p.outcome), "INPUT", "Invalid execution outcome");
			check(p.exitCode === null || Number.isInteger(p.exitCode) && p.exitCode >= 0, "INPUT", "Invalid exit code");
			if (p.after !== null) digest(p.after);
			check(p.after !== null || p.outcome === "unknown", "INPUT", "Missing final fingerprint requires uncertain outcome");
			const outcome = operation.uncertain ? "unknown" : operation.generation !== state.generation || operation.guidanceRevision !== state.guidanceRevision ? "cancelled" : p.outcome;
			const changed = operation.before !== p.after;
			invalidateCandidates(state, p.after);
			if (operation.taskId && (changed || outcome === "unknown" || ["write", "edit"].includes(operation.kind) && outcome === "succeeded")) attributeContribution(state, operation);
			workspace.operations = workspace.operations.filter(operation => operation.id !== p.id);
			workspace.receipts.push({ ...operation, after: p.after, exitCode: p.exitCode, outcome, finishedAt: event.atMs });
			break;
		}
		case "workspace.candidate": {
			check(state.status === "running" && workspace.operations.length === 0, "UNSETTLED", "Candidate capture requires settled workspace operations");
			const task = taskFor(state, p.taskId);
			check(task.assignment?.id === p.assignmentId && task.assignment.kind === "build" && !task.pending, "FENCED", "Current build assignment required");
			digest(p.fingerprint);
			check(p.fingerprint === workspace.fingerprint, "STALE", "Workspace changed before submission");
			check(Array.isArray(p.receipts) && p.receipts.length > 0 && new Set(p.receipts).size === p.receipts.length, "EVIDENCE", "Verification receipts required");
			for (const id of p.receipts) {
				const receipt = workspace.receipts.find(receipt => receipt.id === id);
				const reason = !receipt ? "missing-receipt" : receipt.kind !== "shell" ? "wrong-kind"
					: receipt.taskId !== p.taskId ? "wrong-task" : receipt.assignmentId !== p.assignmentId ? "wrong-assignment"
						: receiptRejection(state, receipt, p.fingerprint);
				check(reason === null, "EVIDENCE", `Verification receipt rejected: ${reason}`);
			}
			workspace.candidates = workspace.candidates.filter(candidate => candidate.taskId !== task.id);
			workspace.candidates.push({ ...structuredClone(p), guidanceRevision: state.guidanceRevision });
			break;
		}
		case "workspace.reconcile":
			check(["paused", "pausing", "stopping", "failing"].includes(state.status) && p.settled === true, "STATE", "Explicit interrupted-execution reconciliation required");
			digest(p.fingerprint);
			for (const operation of workspace.operations) {
				attributeContribution(state, operation);
				workspace.receipts.push({ ...operation, after: p.fingerprint, exitCode: null, outcome: "unknown", finishedAt: event.atMs });
			}
			workspace.operations = [];
			invalidateCandidates(state, p.fingerprint);
			break;
	}
}
