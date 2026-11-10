import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_FIELDS, reduceSession, sessionWorker, pendingMail, requireSessionIdle, requireWorkerTurn } from "../extensions/swarm/session-state.mjs";

const code = expected => error => error.code === expected;
const selection = { provider: "swarm-mock", modelId: "test-model", thinkingLevel: "medium" };
const configuration = () => ({ selection: { ...selection }, instructions: "Use the shared board.", codingTools: [] });
const binding = (workerId = "builder") => ({ workerId, sessionId: `session-${workerId}`, sessionFile: `2026-01-01_${workerId}.jsonl` });
const turn = (id = "turn-1", workerId = "builder", messageIds = []) => ({ id, workerId, kind: "prompt", messageIds, guidanceRevision: 2 });
const mail = (id, to = "builder", cycle = 1, generation = 3) => ({ id, from: "owner", to, text: id, cycle, generation });

function fixture() {
	return {
		status: "paused", cycle: 1, generation: 3, guidanceRevision: 2, elapsedMs: 0,
		limits: { active: 2, durationMs: 1000 }, workers: [{ id: "builder" }, { id: "reviewer" }, { id: "third" }],
		tasks: [], messages: [], workspace: null, sessions: null,
	};
}

function event(type, payload, actor = type.startsWith("sessions.") ? "owner" : "system", atMs = 10) {
	return { type, payload, actor, atMs };
}

// The parent reducer owns envelope/payload exactness, cloning and revision checks.
function apply(previous, type, payload, actor, atMs) {
	const state = structuredClone(previous);
	reduceSession(state, event(type, payload, actor, atMs));
	return state;
}

function configured() {
	let state = apply(fixture(), "sessions.configure", configuration());
	for (const worker of state.workers) state = apply(state, "session.bind", binding(worker.id));
	state.status = "running";
	return state;
}

function reject(state, type, payload, expected, actor) {
	const before = structuredClone(state);
	assert.throws(() => apply(state, type, payload, actor), code(expected));
	assert.deepEqual(state, before);
}

test("session field map is the exact public payload contract", () => {
	assert.deepEqual(SESSION_FIELDS, {
		"session.request": ["id", "workerId"],
		"session.usage": ["id", "workerId", "usage"],
		"sessions.configure": ["selection", "instructions", "codingTools"],
		"session.bind": ["workerId", "sessionId", "sessionFile"],
		"session.turn.start": ["id", "workerId", "kind", "messageIds", "guidanceRevision"],
		"session.turn.end": ["id", "outcome"],
		"sessions.reconcile": ["settled"],
	});
});

test("configuration snapshots the approved selection and instructions once", () => {
	const previous = fixture();
	const payload = configuration();
	const state = apply(previous, "sessions.configure", payload);
	payload.selection.modelId = "changed";
	assert.equal(previous.sessions, null);
	assert.deepEqual(state.sessions, { selection, instructions: "Use the shared board.", codingTools: [], workers: [], turns: [], history: [] });
	reject(state, "sessions.configure", configuration(), "STATE");
	assert.equal(apply(fixture(), "sessions.configure", { selection, instructions: "", codingTools: [] }).sessions.instructions, "");
});

test("configuration requires paused, idle work and owner authority", () => {
	for (const status of ["running", "verifying", "pausing", "stopping", "failing", "stopped", "completed", "failed"]) {
		reject({ ...fixture(), status }, "sessions.configure", configuration(), "STATE");
	}
	reject({ ...fixture(), tasks: [{ assignment: { id: "assignment" } }] }, "sessions.configure", configuration(), "UNSETTLED");
	reject({ ...fixture(), workspace: { operations: [{ id: "operation" }] } }, "sessions.configure", configuration(), "UNSETTLED");
	for (const actor of ["system", "builder"]) reject(fixture(), "sessions.configure", configuration(), "AUTHORITY", actor);
});

test("nested selection validation rejects omitted, additional and malformed values", () => {
	const invalid = [null, [], "model", {}, { ...selection, extra: true }, { provider: "swarm-mock", modelId: "model" },
		{ ...selection, provider: "live-provider" }, { ...selection, modelId: " " }, { ...selection, modelId: 3 },
		{ ...selection, modelId: "m".repeat(32769) }, { ...selection, thinkingLevel: "maximum" }, { ...selection, thinkingLevel: null }];
	for (const value of invalid) reject(fixture(), "sessions.configure", { selection: value, instructions: "" }, "INPUT");
	for (const instructions of [null, {}, 1, "x".repeat(32769)]) reject(fixture(), "sessions.configure", { selection, instructions }, "INPUT");
	for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
		assert.equal(apply(fixture(), "sessions.configure", { selection: { ...selection, thinkingLevel }, instructions: "", codingTools: [] }).sessions.selection.thinkingLevel, thinkingLevel);
	}
});

test("binding is immutable and requires an existing worker with unique session identity and file", () => {
	const state = apply(fixture(), "sessions.configure", configuration());
	const bound = apply(state, "session.bind", binding());
	assert.deepEqual(sessionWorker(bound, "builder"), { ...binding(), delivered: [] });
	assert.equal(sessionWorker(bound, "missing"), undefined);
	reject(bound, "session.bind", binding(), "DUPLICATE");
	reject(bound, "session.bind", { ...binding(), sessionId: "replacement", sessionFile: "replacement.jsonl" }, "DUPLICATE");
	reject(bound, "session.bind", { ...binding("reviewer"), sessionId: binding().sessionId }, "DUPLICATE");
	reject(bound, "session.bind", { ...binding("reviewer"), sessionFile: binding().sessionFile }, "DUPLICATE");
	reject(state, "session.bind", binding("missing"), "NOT_FOUND");
});

test("binding rejects unsafe identifiers and non-basename session files", () => {
	const state = apply(fixture(), "sessions.configure", configuration());
	for (const sessionFile of ["../session.jsonl", "/session.jsonl", "a/session.jsonl", "a\\session.jsonl", "C:session.jsonl", ".jsonl", "file.json", "file.jsonl\n", "file\0.jsonl", "a".repeat(256) + ".jsonl", 1]) {
		reject(state, "session.bind", { ...binding(), sessionFile }, "INPUT");
	}
	for (const sessionId of ["", "owner", "system", "../session", "a".repeat(81), null]) {
		reject(state, "session.bind", { ...binding(), sessionId }, "INPUT");
	}
});

test("session operations require configuration and trusted actor capabilities", () => {
	for (const [type, payload] of [["session.bind", binding()], ["session.turn.start", turn()], ["session.turn.end", { id: "turn-1", outcome: "settled" }], ["sessions.reconcile", { settled: true }]]) {
		reject(fixture(), type, payload, "STATE");
		for (const actor of type === "sessions.reconcile" ? ["system", "builder"] : ["owner", "builder"]) {
			reject(configured(), type, payload, "AUTHORITY", actor);
		}
	}
	reject(configured(), "session.unknown", {}, "INPUT");
});

test("prompt intent snapshots context and caller-owned arrays without consuming delivery", () => {
	const state = configured();
	state.messages.push(mail("mail-1"));
	const payload = turn("turn-1", "builder", ["mail-1"]);
	const started = apply(state, "session.turn.start", payload, "system", 21);
	payload.messageIds.push("changed");
	assert.deepEqual(started.sessions.turns, [{ ...turn("turn-1", "builder", ["mail-1"]), cycle: 1, generation: 3, startAt: 21 }]);
	assert.deepEqual(sessionWorker(started, "builder").delivered, []);
	assert.deepEqual(pendingMail(started, "builder"), []);
	assert.deepEqual(pendingMail(state, "builder"), [mail("mail-1")]);
	assert.deepEqual(requireWorkerTurn(started, "builder"), started.sessions.turns[0]);
});

test("turn start requires running state, available time and a bound worker", () => {
	for (const status of ["paused", "pausing", "stopping", "failing", "verifying", "stopped", "completed", "failed"]) {
		reject({ ...configured(), status }, "session.turn.start", turn(), "STATE");
	}
	reject({ ...configured(), elapsedMs: 1000 }, "session.turn.start", turn(), "TIME_LIMIT");
	const unbound = configured();
	unbound.sessions.workers = [];
	reject(unbound, "session.turn.start", turn(), "NOT_FOUND");
});

test("turn payload kinds, mail arrays, identifiers and guidance are validated", () => {
	for (const patch of [{ id: "" }, { workerId: 1 }, { kind: "tool" }, { messageIds: "mail-1" }, { messageIds: ["mail-1", "mail-1"] }, { messageIds: [null] }, { guidanceRevision: "2" }, { guidanceRevision: -1 }, { guidanceRevision: 0.5 }]) {
		reject(configured(), "session.turn.start", { ...turn(), ...patch }, "INPUT");
	}
	reject(configured(), "session.turn.start", { ...turn(), guidanceRevision: 1 }, "GUIDANCE");
});

test("one active turn per worker and global capacity count both prompts and compactions", () => {
	let state = apply(configured(), "session.turn.start", turn());
	reject(state, "session.turn.start", turn("turn-2"), "BUSY");
	state = apply(state, "session.turn.start", { ...turn("compact", "reviewer"), kind: "compaction" });
	assert.equal(state.sessions.turns.length, 2);
	reject(state, "session.turn.start", turn("turn-3", "third"), "ACTIVE_LIMIT");
	state = apply(state, "session.turn.end", { id: "compact", outcome: "settled" });
	assert.equal(apply(state, "session.turn.start", turn("turn-3", "third")).sessions.turns.length, 2);
});

test("compaction cannot deliver mail or authorize worker task mutations", () => {
	const state = configured();
	state.messages.push(mail("mail-1"));
	reject(state, "session.turn.start", { ...turn("compact", "builder", ["mail-1"]), kind: "compaction" }, "INPUT");
	const compacting = apply(state, "session.turn.start", { ...turn("compact"), kind: "compaction" });
	assert.throws(() => requireWorkerTurn(compacting, "builder"), code("FENCED"));
	assert.deepEqual(pendingMail(compacting, "builder"), [mail("mail-1")]);
});

test("turn identifiers cannot be reused by another worker, after settlement, or across cycles", () => {
	let state = apply(configured(), "session.turn.start", turn());
	reject(state, "session.turn.start", turn("turn-1", "reviewer"), "DUPLICATE");
	state = apply(state, "session.turn.end", { id: "turn-1", outcome: "failed" });
	reject(state, "session.turn.start", turn(), "DUPLICATE");
	state.cycle += 1;
	state.generation += 1;
	reject(state, "session.turn.start", turn("turn-1", "reviewer"), "DUPLICATE");
});

test("pending mail is target, cycle and generation fenced, excluding delivered and inflight IDs", () => {
	let state = configured();
	state.messages = [mail("current"), mail("old-cycle", "builder", 0), mail("old-generation", "builder", 1, 2), mail("peer", "reviewer"), mail("owner", "owner"), mail("delivered"), mail("legacy")];
	delete state.messages.at(-1).generation;
	sessionWorker(state, "builder").delivered.push("delivered");
	assert.deepEqual(pendingMail(state, "builder").map(message => message.id), ["current"]);
	assert.deepEqual(pendingMail(state, "missing"), []);
	for (const id of ["absent", "old-cycle", "old-generation", "peer", "delivered", "legacy"]) {
		reject(state, "session.turn.start", turn("turn-1", "builder", [id]), "FENCED");
	}
	state = apply(state, "session.turn.start", turn("turn-1", "builder", ["current"]));
	assert.deepEqual(pendingMail(state, "builder"), []);
	assert.deepEqual(pendingMail(state, "reviewer").map(message => message.id), ["peer"]);
});

test("only current settled turns acknowledge mail and archive their complete intent", () => {
	let state = configured();
	state.messages.push(mail("mail-1"));
	state = apply(state, "session.turn.start", turn("turn-1", "builder", ["mail-1"]), "system", 30);
	const ended = apply(state, "session.turn.end", { id: "turn-1", outcome: "settled" }, "system", 40);
	assert.deepEqual(ended.sessions.turns, []);
	assert.deepEqual(sessionWorker(ended, "builder").delivered, ["mail-1"]);
	assert.deepEqual(ended.sessions.history, [{ ...state.sessions.turns[0], outcome: "settled", endAt: 40 }]);
	assert.deepEqual(pendingMail(ended, "builder"), []);
	reject(ended, "session.turn.end", { id: "turn-1", outcome: "settled" }, "FENCED");
	reject(ended, "session.turn.start", turn("turn-2", "builder", ["mail-1"]), "FENCED");
});

test("failed and interrupted delivery stays pending without automatic turn replay", () => {
	for (const outcome of ["failed", "interrupted"]) {
		let state = configured();
		state.messages.push(mail("mail-1"));
		state = apply(state, "session.turn.start", turn("turn-1", "builder", ["mail-1"]));
		state = apply(state, "session.turn.end", { id: "turn-1", outcome });
		assert.deepEqual(state.sessions.turns, []);
		assert.deepEqual(sessionWorker(state, "builder").delivered, []);
		assert.deepEqual(pendingMail(state, "builder"), [mail("mail-1")]);
		assert.equal(state.sessions.history[0].outcome, outcome);
	}
});

test("late settlement retires cancelled intent but cannot acknowledge old cycle or generation mail", () => {
	for (const changed of ["cycle", "generation"]) {
		let state = configured();
		state.messages.push(mail("mail-1"));
		state = apply(state, "session.turn.start", turn("turn-1", "builder", ["mail-1"]));
		state[changed] += 1;
		state.status = "pausing";
		state = apply(state, "session.turn.end", { id: "turn-1", outcome: "settled" });
		assert.equal(state.sessions.turns.length, 0);
		assert.deepEqual(sessionWorker(state, "builder").delivered, []);
		assert.deepEqual(pendingMail(state, "builder"), []);
		assert.equal(state.status, "pausing");
	}
});

test("turn end rejects unknown outcomes and unknown or malformed IDs", () => {
	const state = apply(configured(), "session.turn.start", turn());
	reject(state, "session.turn.end", { id: "turn-1", outcome: "successful" }, "INPUT");
	reject(state, "session.turn.end", { id: "unknown", outcome: "settled" }, "FENCED");
	reject(state, "session.turn.end", { id: null, outcome: "settled" }, "INPUT");
});

test("worker turn guards fence missing, stale, compaction and outdated guidance contexts", () => {
	const started = apply(configured(), "session.turn.start", turn());
	for (const patch of [{ cycle: 2 }, { generation: 4 }, { status: "pausing" }]) {
		assert.throws(() => requireWorkerTurn({ ...started, ...patch }, "builder"), code("FENCED"));
	}
	assert.throws(() => requireWorkerTurn({ ...started, guidanceRevision: 3 }, "builder"), code("GUIDANCE"));
	assert.throws(() => requireWorkerTurn(started, "reviewer"), code("FENCED"));
	assert.throws(() => requireSessionIdle(started), code("UNSETTLED"));
	assert.doesNotThrow(() => requireSessionIdle(configured()));
	assert.doesNotThrow(() => requireSessionIdle(fixture()));
	assert.equal(requireWorkerTurn(fixture(), "builder"), undefined);
	assert.equal(sessionWorker(fixture(), "builder"), undefined);
	assert.deepEqual(pendingMail(fixture(), "builder"), []);
});

test("explicit reconciliation interrupts orphan turns in paused/draining states without mail delivery or scheduling", () => {
	for (const status of ["paused", "pausing", "stopping", "failing"]) {
		let state = configured();
		state.messages.push(mail("mail-1"));
		state = apply(state, "session.turn.start", turn("turn-1", "builder", ["mail-1"]));
		state = apply(state, "session.turn.start", { ...turn("compact", "reviewer"), kind: "compaction" });
		state.status = status;
		const reconciled = apply(state, "sessions.reconcile", { settled: true }, "owner", 50);
		assert.deepEqual(reconciled.sessions.history, state.sessions.turns.map(turn => ({ ...turn, outcome: "interrupted", endAt: 50 })));
		assert.deepEqual(reconciled.sessions.turns, []);
		assert.deepEqual(sessionWorker(reconciled, "builder").delivered, []);
		assert.deepEqual(pendingMail(reconciled, "builder"), [mail("mail-1")]);
		assert.equal(reconciled.status, status);
		assert.deepEqual(apply(reconciled, "sessions.reconcile", { settled: true }), reconciled);
	}
});

test("reconciliation rejects missing attestation and active or terminal lifecycle states", () => {
	for (const status of ["running", "verifying", "stopped", "completed", "failed"]) {
		reject({ ...configured(), status }, "sessions.reconcile", { settled: true }, "STATE");
	}
	for (const settled of [false, null, "true", 1]) {
		reject({ ...configured(), status: "paused" }, "sessions.reconcile", { settled }, "STATE");
	}
});

test("reapplying the same event sequence reproduces history and retained selection deterministically", () => {
	const initial = fixture();
	const events = [event("sessions.configure", configuration()), event("session.bind", binding())];
	const replay = () => {
		let state = structuredClone(initial);
		for (const item of events) reduceSession(state, structuredClone(item));
		state.status = "running";
		state.messages.push(mail("mail-1"));
		for (const item of [event("session.turn.start", turn("turn-1", "builder", ["mail-1"])), event("session.turn.end", { id: "turn-1", outcome: "failed" }, "system", 20), event("session.turn.start", turn("turn-2", "builder", ["mail-1"]), "system", 25), event("session.turn.end", { id: "turn-2", outcome: "settled" }, "system", 30)]) {
			reduceSession(state, item);
		}
		return state;
	};
	assert.deepEqual(replay(), replay());
	assert.deepEqual(replay().sessions.selection, selection);
	assert.deepEqual(initial, fixture());
});

test("turn mail batches retain complete text and leave undispatched messages pending", async () => {
	const { turnMail } = await import("../extensions/swarm/session-state.mjs");
	const state = configured();
	state.messages = Array.from({ length: 12 }, (_, i) => ({ ...mail(`mail-${i}`), text: "x".repeat(4000) }));
	const before = structuredClone(state);
	const batch = turnMail(state, "builder");
	assert.equal(batch.length, 8); assert.equal(batch[0].text.length, 4000);
	assert.deepEqual(state, before);
	state.sessions.turns = [{ workerId: "builder", messageIds: batch.map(message => message.id) }];
	assert.equal(pendingMail(state, "builder").length, 4);
});
