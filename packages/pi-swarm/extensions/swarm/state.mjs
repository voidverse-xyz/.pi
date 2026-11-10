import { createHash } from "node:crypto";
import { USAGE_LIMITS } from "./usage.mjs";
import { validId } from "./store/files.mjs";
import { recipientId } from "./messaging.mjs";
import { requireCondition } from "./errors.mjs";
import { validateApproval } from "./approval-state.mjs";
import { validateModelSelection, validateWorkerModels } from "./model-settings.mjs";
import { SESSION_FIELDS, reduceSession, requireSessionIdle, requireWorkerTurn } from "./session-state.mjs";
import { WORKSPACE_FIELDS, invalidateCandidates, reduceWorkspace, requireCandidate, requireFinalEvidence } from "./workspace-state.mjs";

export { SwarmError, requireCondition } from "./errors.mjs";

export const DEFAULT_LIMITS = Object.freeze({ agents: 8, active: 4, tasks: 100, attempts: 3, durationMs: 60 * 60 * 1000 });
const EXECUTING = new Set(["running", "verifying", "pausing", "stopping", "failing"]);
const RESTARTABLE = new Set(["paused", "stopped", "completed", "failed"]);
const WORKER_ACTIONS = new Set(["worker.create", "worker.ack", "task.create", "task.claim", "task.submit", "task.review", "task.fail", "task.yield", "task.unblock", "message.send"]);
const FIELDS = {
	...WORKSPACE_FIELDS,
	...SESSION_FIELDS,
	"host.attest": ["evidence", "operationIds", "turnIds", "fingerprint"],
	"host.approve": ["approval"], "host.continue": ["restart", "reconciled", "approval"],
	"host.configure": ["selection", "workerModels", "approval"],
	"run.create": ["runId", "ownerSessionId", "workspaceRoot", "objective", "criteria", "scope", "limits"],
	"run.resume": ["reconciled"], "run.restart": ["reconciled"], "run.pause": [], "run.stop": [],
	"run.adopt": ["ownerSessionId"],
	"run.fail": ["reason"], "run.recover": [], "run.tick": [], "run.settle": [],
	"run.verify": [], "run.complete": ["evidence"], "run.redirect": ["text"], "limits.update": ["limits"],
	"worker.create": ["id", "specialization", "brief", "reason", "workloadRevision"], "worker.ack": ["revision"],
	"task.create": ["id", "title", "criteria", "dependencies"], "task.claim": ["taskId", "kind", "assignmentId"],
	"task.submit": ["taskId", "summary"], "task.review": ["taskId", "approved", "summary"],
	"task.fail": ["taskId", "reason"], "task.yield": ["taskId", "blocker"], "task.unblock": ["taskId"],
	"assignment.settle": ["taskId", "assignmentId"], "message.send": ["to", "text"],
};

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
}

function text(value, name) {
	requireCondition(typeof value === "string" && value.trim().length > 0 && value.length <= 32768, "INPUT", `Invalid ${name}`);
}
function id(value) { requireCondition(validId(value) && !["owner", "system"].includes(value), "INPUT", "Invalid identifier"); }
function integer(value, name, minimum = 0) {
	requireCondition(Number.isSafeInteger(value) && value >= minimum, "INPUT", `Invalid ${name}`);
}
function exactKeys(object, names) {
	requireCondition(object !== null && typeof object === "object" && !Array.isArray(object), "INPUT", "Expected object");
	requireCondition(Object.keys(object).sort().join() === [...names].sort().join(), "INPUT", "Unexpected or missing fields");
}
function textList(value, name) {
	requireCondition(Array.isArray(value) && value.length > 0, "INPUT", `Invalid ${name}`);
	for (const item of value) text(item, name);
}
function limits(value) {
	exactKeys(value, [...Object.keys(DEFAULT_LIMITS), ...USAGE_LIMITS.filter(key => Object.hasOwn(value, key))]);
	for (const [key, count] of Object.entries(value)) integer(count, key, 1);
	requireCondition(value.active <= value.agents, "INPUT", "Active limit exceeds total agent limit");
	return structuredClone(value);
}
function activeAssignments(state) { return state.tasks.filter(task => task.assignment !== null); }
function taskById(state, taskId) {
	const task = state.tasks.find(item => item.id === taskId);
	requireCondition(task, "NOT_FOUND", "Task does not exist");
	return task;
}
function workerById(state, workerId) {
	const worker = state.workers.find(item => item.id === workerId);
	requireCondition(worker, "NOT_FOUND", "Worker does not exist");
	return worker;
}
function requireIdle(state) {
	requireSessionIdle(state);
	requireCondition(activeAssignments(state).length === 0, "UNSETTLED", "Assignments must settle first");
	requireCondition(!state.workspace?.operations.length, "UNSETTLED", "Workspace operations must settle first");
}
function requireRunning(state) {
	requireCondition(state.status === "running", "STATE", "Run is not accepting task work");
	requireCondition(state.elapsedMs < state.limits.durationMs, "TIME_LIMIT", "Run duration exhausted; pause required");
}
function assignedTask(state, event, kind) {
	const task = taskById(state, event.payload.taskId);
	requireCondition(task.assignment?.workerId === event.actor, "OWNERSHIP", "Task belongs to another worker");
	requireCondition(task.assignment.generation === state.generation, "FENCED", "Assignment generation expired");
	if (kind) requireCondition(task.assignment.kind === kind, "STATE", "Wrong assignment kind");
	requireCondition(task.pending === null, "STATE", "Assignment already reported; await settlement");
	return task;
}
function drain(state, status) {
	state.status = status;
	state.generation += 1;
}
function applyFailure(state, task, reason) {
	task.candidate = null;
	if (state.workspace) state.workspace.candidates = state.workspace.candidates.filter(candidate => candidate.taskId !== task.id);
	task.failures += 1;
	task.failureHistory.push({ cycle: state.cycle, reason });
	task.status = task.failures >= state.limits.attempts ? "blocked" : "ready";
	task.blocker = task.status === "blocked" ? "attempt-limit" : null;
}

function create(event) {
	requireCondition(event.type === "run.create" && event.actor === "owner", "STATE", "First event must be owner-approved creation");
	requireCondition(event.expectedRevision === 0 && event.cycle === 1 && event.generation === 0, "REVISION", "Invalid initial counters");
	const p = event.payload;
	id(p.runId); text(p.ownerSessionId, "owner session"); text(p.workspaceRoot, "workspace");
	text(p.objective, "objective"); textList(p.criteria, "criteria"); textList(p.scope, "scope");
	return {
		version: 1, runId: p.runId, ownerSessionId: p.ownerSessionId, workspaceRoot: p.workspaceRoot,
		objective: p.objective, criteria: [...p.criteria], scope: [...p.scope], limits: limits(p.limits),
		status: "paused", revision: 1, cycle: 1, generation: 0, lastAtMs: event.atMs, elapsedMs: 0,
		cycles: [], tasksCreated: 0, workers: [], tasks: [], assignmentIds: [], messages: [], guidance: [],
		guidanceRevision: 0, completionEvidence: null, failureReason: null, workspace: null, sessions: null, hostApprovals: [],
	};
}

/** Pure transition validation. No IO, clocks, model calls, or hidden mutations. */
export function reduceEvent(previous, event) {
	exactKeys(event, ["version", "operationId", "actor", "expectedRevision", "cycle", "generation", "atMs", "type", "payload"]);
	requireCondition(event.version === 1 && Object.hasOwn(FIELDS, event.type), "INPUT", "Unsupported event version/type");
	id(event.operationId); text(event.actor, "actor"); integer(event.expectedRevision, "revision");
	integer(event.cycle, "cycle", 1); integer(event.generation, "generation"); integer(event.atMs, "timestamp");
	let payloadFields = FIELDS[event.type];
	if (event.type === "message.send" && event.payload && Object.hasOwn(event.payload, "topic")) payloadFields = [...payloadFields, "topic"];
	if (event.type === "sessions.configure" && event.payload) for (const key of ["workerModels", "workerContext", "workerContexts"]) {
		if (Object.hasOwn(event.payload, key)) payloadFields = [...payloadFields, key];
	}
	exactKeys(event.payload, payloadFields);
	if (previous === null) return create(event);

	requireCondition(event.type !== "run.create", "STATE", "Run already exists");
	requireCondition(event.expectedRevision === previous.revision, "REVISION", "State revision changed");
	requireCondition(event.cycle === previous.cycle && event.generation === previous.generation, "FENCED", "Execution cycle or generation expired");
	requireCondition(event.atMs >= previous.lastAtMs, "CLOCK", "Clock moved backwards; reconcile before continuing");
	if (event.type === "host.continue") {
		requireCondition(event.actor === "owner" && typeof event.payload.restart === "boolean", "AUTHORITY", "Host continuation approval required");
		const action = event.payload.restart ? "restart" : "resume";
		validateApproval(event.payload.approval, action, previous.hostApprovals);
		const next = reduceEvent(previous, { ...event, type: `run.${action}`, payload: { reconciled: event.payload.reconciled } });
		next.hostApprovals.push(structuredClone(event.payload.approval));
		return next;
	}
	const state = structuredClone(previous);
	// Recovery cannot infer how long a crashed process ran after its last durable
	// checkpoint. Offline time must not be billed as active execution time.
	if (EXECUTING.has(state.status) && event.type !== "run.recover") state.elapsedMs += event.atMs - state.lastAtMs;
	integer(state.elapsedMs, "elapsed time");
	state.lastAtMs = event.atMs;
	const p = event.payload;
	const isWorker = event.actor !== "owner" && event.actor !== "system";
	if (isWorker) {
		const worker = workerById(state, event.actor);
		requireWorkerTurn(state, event.actor);
		requireCondition(WORKER_ACTIONS.has(event.type), "AUTHORITY", "Worker cannot authorize lifecycle changes");
		requireRunning(state);
		if (event.type !== "worker.ack") {
			requireCondition(worker.guidanceRevision === state.guidanceRevision, "GUIDANCE", "Read and acknowledge current user guidance first");
		}
	}
	const ownerOnly = ["run.adopt", "run.resume", "run.restart", "run.redirect", "limits.update"];
	if (ownerOnly.includes(event.type)) requireCondition(event.actor === "owner", "AUTHORITY", "Explicit user authorization required");
	const systemOnly = ["assignment.settle", "run.settle", "run.recover", "run.verify", "run.complete"];
	if (systemOnly.includes(event.type)) requireCondition(event.actor === "system", "AUTHORITY", "Trusted runtime settlement required");

	switch (event.type) {
		case "host.attest": {
			requireCondition(event.actor === "owner" && ["paused", "pausing", "stopping", "failing"].includes(state.status), "AUTHORITY", "Paused host settlement attestation required");
			text(p.evidence, "settlement evidence");
			requireCondition(p.evidence.length <= 4096 && typeof p.fingerprint === "string" && /^[a-f0-9]{64}$/.test(p.fingerprint), "INPUT", "Invalid settlement attestation");
			for (const [ids, records] of [[p.operationIds, state.workspace?.operations ?? []], [p.turnIds, state.sessions?.turns ?? []]]) {
				requireCondition(Array.isArray(ids) && JSON.stringify([...ids].sort()) === JSON.stringify(records.map(item => item.id).sort()), "STALE", "Attestation must identify all current unresolved execution");
			}
			state.settlementAttestations ??= [];
			state.settlementAttestations.push({ ...structuredClone(p), atMs: event.atMs, cycle: state.cycle, generation: state.generation, authority: "user-established-settlement" });
			break;
		}
		case "host.configure": {
			requireCondition(event.actor === "owner", "AUTHORITY", "Explicit user configuration approval required");
			requireCondition(["running", "paused"].includes(state.status) && state.sessions, "STATE", "Configure requires a running or paused configured run");
			requireSessionIdle(state);
			requireCondition(!state.workspace?.operations.length, "UNSETTLED", "Workspace operations must settle first");
			validateApproval(p.approval, "configure", state.hostApprovals);
			validateModelSelection(p.selection, p.approval);
			const workerModels = validateWorkerModels(p.workerModels, p.approval);
			const specification = { objective: state.objective, criteria: state.criteria, scope: state.scope,
				limits: state.limits, model: p.selection, codingTools: state.sessions.codingTools,
				instructions: state.sessions.instructions, workerModels,
				...(state.sessions.workerContext !== undefined ? { workerContext: state.sessions.workerContext } : {}),
				...(state.sessions.workerContexts !== undefined ? { workerContexts: state.sessions.workerContexts } : {}) };
			const fingerprint = createHash("sha256").update(JSON.stringify(canonical(specification))).digest("hex");
			requireCondition(p.approval.specificationFingerprint === fingerprint, "SCOPE", "Configuration does not match approved specification");
			state.sessions.selection = structuredClone(p.selection);
			state.sessions.workerModels = workerModels;
			state.hostApprovals.push(structuredClone(p.approval));
			break;
		}
		case "host.approve":
			requireCondition(event.actor === "owner" && state.status === "paused", "AUTHORITY", "Paused launch approval required");
			requireIdle(state);
			validateApproval(p.approval, "launch", state.hostApprovals);
			state.hostApprovals.push(structuredClone(p.approval));
			break;
		case "run.resume":
			requireCondition(state.status === "paused" && p.reconciled === true, "STATE", "Resume requires paused, reconciled state");
			requireIdle(state);
			requireCondition(state.elapsedMs < state.limits.durationMs, "TIME_LIMIT", "Extend time or explicitly restart");
			state.status = "running";
			break;
		case "run.restart": {
			requireCondition(RESTARTABLE.has(state.status) && p.reconciled === true, "STATE", "Restart requires settled, reconciled state");
			requireIdle(state);
			const carried = state.tasks.filter(task => task.status !== "done" && task.status !== "cancelled");
			requireCondition(carried.length <= state.limits.tasks, "TASK_LIMIT", "Carried work exceeds configured task limit");
			state.cycles.push({ cycle: state.cycle, elapsedMs: state.elapsedMs, tasksCreated: state.tasksCreated, status: state.status, completionEvidence: state.completionEvidence });
			state.cycle += 1;
			state.generation += 1;
			state.elapsedMs = 0;
			if (state.sessions?.usage) state.sessions.usage = [];
			state.tasksCreated = carried.length;
			state.status = "running";
			state.completionEvidence = null;
			state.failureReason = null;
			for (const task of carried) {
				task.failures = 0;
				if (task.status === "interrupted" || task.blocker === "attempt-limit") {
					task.status = task.candidate ? "submitted" : "ready";
					task.blocker = null;
				}
			}
			break;
		}
		case "run.pause":
			requireCondition(["running", "verifying"].includes(state.status), "STATE", "Cannot pause this state");
			drain(state, "pausing");
			break;
		case "run.stop":
			requireCondition(["running", "verifying", "paused", "pausing"].includes(state.status), "STATE", "Cannot stop this state");
			drain(state, "stopping");
			break;
		case "run.fail":
			text(p.reason, "failure reason");
			requireCondition(!["stopped", "completed", "failed"].includes(state.status), "STATE", "Run already settled");
			state.failureReason = p.reason;
			drain(state, "failing");
			break;
		case "run.adopt":
			requireCondition(!["running", "verifying"].includes(state.status), "STATE", "Fence the prior controller before adopting a run");
			text(p.ownerSessionId, "owner session");
			state.ownerSessionId = p.ownerSessionId;
			break;
		case "run.recover":
			requireCondition(EXECUTING.has(state.status), "STATE", "Run does not need recovery reconciliation");
			if (["running", "verifying"].includes(state.status)) drain(state, "pausing");
			else state.generation += 1;
			break;
		case "run.tick":
			if (["running", "verifying"].includes(state.status) && state.elapsedMs >= state.limits.durationMs) drain(state, "pausing");
			break;
		case "run.settle":
			requireIdle(state);
			requireCondition(["pausing", "stopping", "failing"].includes(state.status), "STATE", "No pending lifecycle settlement");
			state.status = { pausing: "paused", stopping: "stopped", failing: "failed" }[state.status];
			break;
		case "run.verify":
			requireRunning(state); requireIdle(state);
			requireCondition(state.tasks.length > 0 && state.tasks.every(task => task.status === "done"), "INCOMPLETE", "All tasks must complete first");
			state.status = "verifying";
			break;
		case "run.complete":
			requireCondition(state.status === "verifying", "STATE", "Final verification required"); requireIdle(state);
			requireCondition(state.elapsedMs < state.limits.durationMs, "TIME_LIMIT", "Verification time exhausted");
			text(p.evidence, "verification evidence reference");
			requireFinalEvidence(state, p.evidence);
			state.completionEvidence = p.evidence;
			state.status = "completed";
			break;
		case "run.redirect":
			text(p.text, "user guidance");
			state.guidanceRevision += 1;
			state.guidance.push({ revision: state.guidanceRevision, text: p.text });
			if (state.workspace) invalidateCandidates(state, state.workspace.fingerprint);
			break;
		case "limits.update": {
			const next = limits(p.limits);
			requireCondition(next.agents >= state.workers.length && next.active >= (state.sessions ? state.sessions.turns.length : activeAssignments(state).length) && next.tasks >= state.tasksCreated, "CAPACITY", "Limits below retained work");
			state.limits = next;
			break;
		}
		case "worker.create":
			requireRunning(state); id(p.id); text(p.specialization, "specialization"); text(p.brief, "brief"); text(p.reason, "recruitment reason");
			requireCondition(p.workloadRevision === previous.revision, "REVISION", "Refresh workload before recruiting");
			requireCondition(state.workers.length < state.limits.agents, "AGENT_LIMIT", "Agent limit reached");
			requireCondition(!state.workers.some(worker => worker.id === p.id), "DUPLICATE", "Worker already exists");
			state.workers.push({ id: p.id, specialization: p.specialization, brief: p.brief, reason: p.reason, guidanceRevision: state.guidanceRevision });
			break;
		case "worker.ack": {
			requireCondition(isWorker && p.revision === state.guidanceRevision, "GUIDANCE", "Acknowledge the current guidance revision");
			workerById(state, event.actor).guidanceRevision = p.revision;
			break;
		}
		case "task.create": {
			requireRunning(state); id(p.id); text(p.title, "task title");
			requireCondition(state.tasksCreated < state.limits.tasks, "TASK_LIMIT", "Task ceiling reached; existing work may continue");
			requireCondition(!state.tasks.some(task => task.id === p.id), "DUPLICATE", "Task already exists");
			requireCondition(Array.isArray(p.criteria) && p.criteria.length > 0 && p.criteria.every(index => Number.isInteger(index) && index >= 0 && index < state.criteria.length), "SCOPE", "Task must reference approved acceptance criteria");
			requireCondition(Array.isArray(p.dependencies) && new Set(p.dependencies).size === p.dependencies.length, "INPUT", "Invalid dependencies");
			for (const dependency of p.dependencies) taskById(state, dependency);
			// Dependencies only point to already-created tasks; this makes cycles impossible.
			state.tasks.push({ id: p.id, title: p.title, criteria: [...p.criteria], dependencies: [...p.dependencies], status: "ready", assignment: null, pending: null, contributors: [], failures: 0, failureHistory: [], blocker: null, candidate: null, reviews: [] });
			state.tasksCreated += 1;
			break;
		}
		case "task.claim": {
			requireRunning(state); requireCondition(isWorker, "AUTHORITY", "Only a bound worker may claim tasks"); id(p.assignmentId);
			const task = taskById(state, p.taskId);
			requireCondition(!state.assignmentIds.includes(p.assignmentId), "DUPLICATE", "Assignment token was already used");
			requireCondition(state.sessions || activeAssignments(state).length < state.limits.active, "ACTIVE_LIMIT", "Active worker limit reached");
			requireCondition(!state.tasks.some(item => item.assignment?.workerId === event.actor), "BUSY", "Worker already has active work");
			requireCondition(!task.assignment && task.failures < state.limits.attempts, "OWNERSHIP", "Task unavailable");
			requireCondition(task.dependencies.every(dependency => taskById(state, dependency).status === "done"), "DEPENDENCY", "Dependencies are unfinished");
			if (p.kind === "build") {
				requireCondition(task.status === "ready", "STATE", "Task not ready to build");
				if (!task.contributors.includes(event.actor)) task.contributors.push(event.actor);
				task.status = "assigned";
			} else {
				requireCondition(p.kind === "review" && task.status === "submitted", "STATE", "Task not ready to review");
				requireCondition(!task.contributors.includes(event.actor) && !state.workspace?.contributors.includes(event.actor), "INDEPENDENCE", "Contributor cannot independently approve this workspace candidate");
				task.status = "reviewing";
			}
			state.assignmentIds.push(p.assignmentId);
			task.assignment = { id: p.assignmentId, workerId: event.actor, kind: p.kind, generation: state.generation };
			break;
		}
		case "task.submit": {
			const task = assignedTask(state, event, "build"); text(p.summary, "candidate summary");
			requireCandidate(state, task.id, task.assignment.id);
			task.pending = { kind: "submit", summary: p.summary };
			break;
		}
		case "task.review": {
			const task = assignedTask(state, event, "review"); text(p.summary, "review summary");
			requireCandidate(state, task.id);
			requireCondition(typeof p.approved === "boolean", "INPUT", "Invalid review verdict");
			task.pending = { kind: "review", approved: p.approved, summary: p.summary };
			break;
		}
		case "task.fail": {
			const task = assignedTask(state, event); text(p.reason, "failure reason");
			task.pending = { kind: "failure", reason: p.reason };
			break;
		}
		case "task.yield": {
			const task = assignedTask(state, event);
			requireCondition(p.blocker === null || typeof p.blocker === "string", "INPUT", "Invalid blocker");
			task.pending = { kind: "yield", blocker: p.blocker };
			break;
		}
		case "task.unblock": {
			requireRunning(state);
			const task = taskById(state, p.taskId);
			requireCondition(["blocked", "interrupted"].includes(task.status) && task.failures < state.limits.attempts && !task.assignment, "STATE", "Cannot unblock this task");
			task.status = task.candidate ? "submitted" : "ready";
			task.blocker = null;
			break;
		}
		case "assignment.settle": {
			const task = taskById(state, p.taskId);
			requireCondition(task.assignment?.id === p.assignmentId, "FENCED", "Assignment token does not match");
			const assignment = task.assignment;
			requireCondition(!state.sessions?.turns.some(turn => turn.workerId === assignment.workerId), "UNSETTLED", "Worker session must settle first");
			requireCondition(!state.workspace?.operations.some(operation => operation.assignmentId === assignment.id), "UNSETTLED", "Assignment still has workspace execution");
			const pending = task.pending;
			if (state.status !== "running" || assignment.generation !== state.generation) {
				task.status = "interrupted";
				task.blocker = "reconciliation-required";
			} else {
				requireCondition(pending, "STATE", "Assignment has not reported");
				switch (pending.kind) {
					case "submit": requireCandidate(state, task.id, assignment.id); task.candidate = pending.summary; task.status = "submitted"; break;
					case "review":
						requireCandidate(state, task.id);
						task.reviews.push({ cycle: state.cycle, workerId: assignment.workerId, approved: pending.approved, summary: pending.summary });
						if (pending.approved) task.status = "done";
						else { task.candidate = null; applyFailure(state, task, pending.summary); }
						break;
					case "failure": applyFailure(state, task, pending.reason); break;
					case "yield":
						task.status = pending.blocker ? "blocked" : assignment.kind === "review" && task.candidate ? "submitted" : "ready";
						task.blocker = pending.blocker;
						break;
				}
			}
			task.assignment = null;
			task.pending = null;
			break;
		}
		case "message.send": {
			text(p.text, "message");
			const to = recipientId(p.to, state.workers);
			if (p.topic !== undefined) requireCondition(typeof p.topic === "string" && p.topic.trim().length > 0 && p.topic.length <= 128, "INPUT", "Invalid topic");
			requireCondition(to !== "@board" || p.topic !== undefined, "INPUT", "Board messages require a topic");
			if (!["owner", "@board"].includes(to)) workerById(state, to);
			state.messages.push({ id: event.operationId, from: event.actor, to, text: p.text, cycle: state.cycle, generation: state.generation, ...(p.topic !== undefined ? { topic: p.topic.trim() } : {}) });
			break;
		}
		default:
			if (Object.hasOwn(SESSION_FIELDS, event.type)) reduceSession(state, event);
			else reduceWorkspace(state, event);
	}
	state.revision += 1;
	return state;
}
