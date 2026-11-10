import { isBoardMessage } from "./messaging.mjs";
import { requireCondition as check } from "./errors.mjs";
import { recordRequest, recordResponse } from "./usage.mjs";
import { validateWorkerContext } from "./context/fork.mjs";
import { validateModelSelection, validateWorkerModels } from "./model-settings.mjs";

export const SESSION_FIELDS = {
	"sessions.configure": ["selection", "instructions", "codingTools"],
	"session.request": ["id", "workerId"],
	"session.usage": ["id", "workerId", "usage"],
	"session.bind": ["workerId", "sessionId", "sessionFile"],
	"session.turn.start": ["id", "workerId", "kind", "messageIds", "guidanceRevision"],
	"session.turn.end": ["id", "outcome"],
	"sessions.reconcile": ["settled"],
};

const RECONCILABLE = new Set(["paused", "pausing", "stopping", "failing"]);

function identifier(value) {
	check(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)
		&& !["owner", "system"].includes(value), "INPUT", "Invalid session identifier");
}

export function sessionWorker(state, workerId) {
	return state.sessions?.workers.find(worker => worker.workerId === workerId);
}

export function requireSessionIdle(state) {
	check(!state.sessions?.turns.length, "UNSETTLED", "Session turns must settle first");
}

/** Bound incoming work without truncating or acknowledging undispatched messages. */
export function turnMail(state, workerId) {
	const selected = [];
	let characters = 0;
	for (const message of pendingMail(state, workerId)) {
		if (selected.length && (selected.length >= 10 || characters + message.text.length > 32768)) break;
		selected.push(message);
		characters += message.text.length;
	}
	return selected;
}

/** Before configuration, retain the model-free worker contract. */
export function requireWorkerTurn(state, workerId) {
	if (!state.sessions) return;
	const turn = state.sessions.turns.find(turn => turn.workerId === workerId);
	check(state.status === "running" && turn?.kind === "prompt"
		&& turn.cycle === state.cycle && turn.generation === state.generation, "FENCED", "Current worker prompt turn required");
	check(turn.guidanceRevision === state.guidanceRevision, "GUIDANCE", "Worker turn must receive current guidance");
	return turn;
}

/** Eligibility only: inspecting mail never schedules or acknowledges delivery. */
export function pendingMail(state, workerId) {
	const worker = sessionWorker(state, workerId);
	if (!worker) return [];
	const unavailable = new Set(worker.delivered);
	for (const turn of state.sessions.turns) {
		if (turn.workerId === workerId) for (const id of turn.messageIds) unavailable.add(id);
	}
	return state.messages.filter(message => (message.to === workerId || isBoardMessage(message, state.workers) && message.from !== workerId)
		&& message.cycle === state.cycle && message.generation === state.generation
		&& !unavailable.has(message.id));
}

function configure(state, payload) {
	check(state.status === "paused" && !state.sessions, "STATE", "Configure sessions on a paused run once");
	check(!state.tasks.some(task => task.assignment) && !state.workspace?.operations.length, "UNSETTLED", "Settle work before configuring sessions");
	validateModelSelection(payload.selection, state.hostApprovals?.at(-1));
	check(typeof payload.instructions === "string" && payload.instructions.length <= 32768, "INPUT", "Invalid session instructions");
	check(Array.isArray(payload.codingTools) && new Set(payload.codingTools).size === payload.codingTools.length && payload.codingTools.every(name => ["read", "edit", "write", "bash"].includes(name)), "INPUT", "Unsupported or duplicate coding tools");
	state.sessions = { selection: structuredClone(payload.selection), instructions: payload.instructions, codingTools: [...payload.codingTools], workers: [], turns: [], history: [] };
	if (payload.workerContext !== undefined) state.sessions.workerContext = structuredClone(validateWorkerContext(payload.workerContext));
	if (payload.workerContexts !== undefined) {
		check(state.sessions.workerContext && Array.isArray(payload.workerContexts) && new Set(payload.workerContexts.map(item => item.workerId)).size === payload.workerContexts.length, "INPUT", "Invalid worker context overrides");
		for (const item of payload.workerContexts) check(item && Object.keys(item).sort().join() === "mode,workerId" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.workerId) && ["focus", "fork"].includes(item.mode), "INPUT", "Invalid worker context override");
		state.sessions.workerContexts = structuredClone(payload.workerContexts);
	}
	if (Object.hasOwn(payload, "workerModels")) state.sessions.workerModels = validateWorkerModels(payload.workerModels, state.hostApprovals?.at(-1));
}

function bind(state, payload) {
	identifier(payload.workerId); identifier(payload.sessionId);
	check(typeof payload.sessionFile === "string" && payload.sessionFile.length <= 255
		&& /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.jsonl$/.test(payload.sessionFile), "INPUT", "Session file must be a relative JSONL basename");
	check(state.workers.some(worker => worker.id === payload.workerId), "NOT_FOUND", "Worker does not exist");
	check(!state.sessions.workers.some(worker => worker.workerId === payload.workerId
		|| worker.sessionId === payload.sessionId || worker.sessionFile === payload.sessionFile), "DUPLICATE", "Worker session binding already exists");
	state.sessions.workers.push({ workerId: payload.workerId, sessionId: payload.sessionId, sessionFile: payload.sessionFile, delivered: [] });
}

function startTurn(state, event) {
	const p = event.payload;
	check(state.status === "running", "STATE", "Run is not accepting session work");
	check(state.elapsedMs < state.limits.durationMs, "TIME_LIMIT", "Run duration exhausted; pause required");
	identifier(p.id); identifier(p.workerId);
	check(["prompt", "compaction"].includes(p.kind), "INPUT", "Invalid session turn kind");
	check(Number.isSafeInteger(p.guidanceRevision) && p.guidanceRevision >= 0, "INPUT", "Invalid guidance revision");
	check(p.guidanceRevision === state.guidanceRevision, "GUIDANCE", "Session turn requires current guidance");
	check(Array.isArray(p.messageIds) && new Set(p.messageIds).size === p.messageIds.length, "INPUT", "Invalid session message identifiers");
	for (const id of p.messageIds) identifier(id);
	check(p.kind !== "compaction" || p.messageIds.length === 0, "INPUT", "Compaction cannot deliver mail");
	check(sessionWorker(state, p.workerId), "NOT_FOUND", "Worker session is not bound");
	const sessions = state.sessions;
	check(!sessions.turns.some(turn => turn.id === p.id) && !sessions.history.some(turn => turn.id === p.id), "DUPLICATE", "Session turn identifier was already used");
	check(!sessions.turns.some(turn => turn.workerId === p.workerId), "BUSY", "Worker already has an active session turn");
	check(sessions.turns.length < state.limits.active, "ACTIVE_LIMIT", "Active session limit reached");
	const eligible = new Set(pendingMail(state, p.workerId).map(message => message.id));
	check(p.messageIds.every(id => eligible.has(id)), "FENCED", "Mail is absent, stale, unrelated, or already delivered");
	sessions.turns.push({ ...structuredClone(p), cycle: state.cycle, generation: state.generation, startAt: event.atMs });
}

function endTurn(state, event) {
	const p = event.payload;
	identifier(p.id);
	check(["settled", "failed", "interrupted"].includes(p.outcome), "INPUT", "Invalid session turn outcome");
	const sessions = state.sessions;
	const turn = sessions.turns.find(turn => turn.id === p.id);
	check(turn, "FENCED", "Session turn is no longer active");
	// Cancellation advances the run generation before late settlement arrives.
	// Retire that turn, but never acknowledge its old mail in the new generation.
	if (p.outcome === "settled" && turn.cycle === state.cycle && turn.generation === state.generation) {
		sessionWorker(state, turn.workerId).delivered.push(...turn.messageIds);
	}
	sessions.turns = sessions.turns.filter(active => active.id !== p.id);
	sessions.history.push({ ...turn, outcome: p.outcome, endAt: event.atMs });
}

/** Mutates only the cloned state supplied after common schema/revision checks. */
export function reduceSession(state, event) {
	check(Object.hasOwn(SESSION_FIELDS, event.type), "INPUT", "Unsupported session event");
	const ownerOnly = ["sessions.configure", "sessions.reconcile"].includes(event.type);
	check(event.actor === (ownerOnly ? "owner" : "system"), "AUTHORITY", "Trusted session capability required");
	if (event.type === "sessions.configure") {
		configure(state, event.payload);
		return;
	}
	check(state.sessions, "STATE", "Sessions are not configured");
	switch (event.type) {
		case "session.request": recordRequest(state, event.payload); break;
		case "session.usage": recordResponse(state, event.payload); break;
		case "session.bind": bind(state, event.payload); break;
		case "session.turn.start": startTurn(state, event); break;
		case "session.turn.end": endTurn(state, event); break;
		case "sessions.reconcile":
			check(RECONCILABLE.has(state.status) && event.payload.settled === true, "STATE", "Explicit interrupted-session reconciliation required");
			for (const turn of state.sessions.turns) {
				state.sessions.history.push({ ...turn, outcome: "interrupted", endAt: event.atMs });
			}
			state.sessions.turns = [];
			break;
	}
}
