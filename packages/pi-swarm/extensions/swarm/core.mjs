import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLease, inspectLease, inspectReservation, LEASE_RUNTIME_VERSION } from "./store/lease.mjs";
import { openJournal } from "./store/journal.mjs";
import { prepareLayout } from "./store/layout.mjs";
import { privateDirectory, FILES_RUNTIME_VERSION } from "./store/files.mjs";
import { existsSync, realpathSync, lstatSync } from "node:fs";
import { DEFAULT_LIMITS, reduceEvent, requireCondition } from "./state.mjs";

const TERMINAL = new Set(["stopped", "completed", "failed"]);

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	}
	return value;
}
function fingerprint(actor, type, payload, cycle, generation) {
	return JSON.stringify(canonical({ actor, type, payload, cycle, generation }));
}

/**
 * Trusted host API, not model-visible tools. The owner capability represents
 * already-obtained user authorization; system represents actual runtime facts.
 * A later adapter must never expose those capabilities to worker sessions.
 */
export class SwarmController {
	/** Pi reload may retain older native ESM leaves beneath freshly transformed modules. */
	static assertStorageRuntime() {
		requireCondition(LEASE_RUNTIME_VERSION === 1 && FILES_RUNTIME_VERSION === 1 && typeof inspectReservation === "function",
			"RUNTIME_STALE", "Storage modules are stale; cold-restart Pi and resume the same session");
	}

	static async open({ workspace, runId, ownerSessionId, create, createOnly = false, clock = Date.now, journalIo, agentDir, adopt = false, expectedState, recoveryAttestation }) {
		SwarmController.assertStorageRuntime();
		const layout = prepareLayout(realpathSync(workspace), runId, { agentDir });
		if (!create) {
			try { lstatSync(layout.journalPath); }
			catch (error) {
				if (error.code !== "ENOENT") throw error;
				requireCondition(!existsSync(join(layout.workspaceRoot, ".swarms", runId)), "LEGACY_RUN", "This run was created by an older Swarm version and cannot be restored. Its files were preserved.");
				requireCondition(false, "NOT_FOUND", "Run does not exist");
			}
		}
		if (create) {
			// Reject invalid launch metadata before reserving the entire checkout.
			reduceEvent(null, {
				version: 1, operationId: "preflight", actor: "owner", type: "run.create",
				expectedRevision: 0, cycle: 1, generation: 0, atMs: clock(),
				payload: { runId, ownerSessionId, workspaceRoot: layout.workspaceRoot, objective: create.objective, criteria: create.criteria, scope: create.scope, limits: { ...DEFAULT_LIMITS, ...create.limits } },
			});
		}
		if (createOnly) {
			requireCondition(create, "INPUT", "Create-only open requires a launch specification");
			try { lstatSync(layout.runRoot); requireCondition(false, "DUPLICATE", "Run already exists; launch cannot adopt existing state"); }
			catch (error) { if (error.code !== "ENOENT") throw error; }
			// A fresh launch cannot consume an ambiguous earlier reservation, even
			// when its run identifier happens to match.
			requireCondition(!inspectReservation(layout), "RESERVED", "New launch requires an unreserved project");
		}
		const lease = acquireLease(layout, { ownerSessionId, requireUnreserved: createOnly });
		let journal;
		let freshCreation = false;
		try {
			if (createOnly) {
				requireCondition(create, "INPUT", "Create-only open requires a launch specification");
				try {
					lstatSync(layout.runRoot);
					requireCondition(false, "DUPLICATE", "Run already exists; launch cannot adopt existing state");
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
			}
			// Until open returns, create-only storage has no published controller
			// capability and cannot have dispatched SDK or workspace execution.
			freshCreation = createOnly;
			privateDirectory(layout.runRoot);
			journal = openJournal(layout.journalPath, lease.assertOwned, journalIo);
			const controller = new SwarmController(journal, lease, clock, layout);
			const events = journal.readAll();
			if (createOnly && events.length) {
				freshCreation = false;
				requireCondition(false, "DUPLICATE", "New launch cannot replay an existing journal");
			}
			for (const event of events) controller.#replay(event);
			// Guided recovery binds the pre-restore journal to the inspected agreement.
			// Check before automatic recover/adopt events can change durable state.
			if (expectedState !== undefined) requireCondition(JSON.stringify(canonical(controller.#state)) === JSON.stringify(canonical(expectedState)),
				"STALE", "Saved run changed before ownership attachment");
			if (controller.#state === null) {
				requireCondition(create, "NOT_FOUND", "Run does not exist; an approved launch specification is required");
				await controller.owner("run.create", {
					runId, ownerSessionId, workspaceRoot: layout.workspaceRoot,
					objective: create.objective, criteria: create.criteria, scope: create.scope,
					limits: { ...DEFAULT_LIMITS, ...create.limits },
				});
			} else {
				requireCondition(controller.#state.runId === runId && controller.#state.workspaceRoot === layout.workspaceRoot, "IDENTITY", "Run belongs to a different workspace");
				requireCondition(adopt || controller.#state.ownerSessionId === ownerSessionId, "AUTHORITY", "Run belongs to a different owner session");
				if (["running", "verifying", "pausing", "stopping", "failing"].includes(controller.#state.status)) {
					await controller.system("run.recover", {});
					// Adopt only after fencing prior execution, but before a terminal settle
					// can close the controller and make further journal writes impossible.
					if (controller.#state.ownerSessionId !== ownerSessionId) await controller.owner("run.adopt", { ownerSessionId });
					if (!controller.#state.tasks.some(task => task.assignment) && !controller.#state.workspace?.operations.length && !controller.#state.sessions?.turns.length) {
						// A guided terminal recovery can settle and release ownership during open.
						// Persist its actual owner attestation before that terminal publication.
						if (recoveryAttestation && ["stopping", "failing"].includes(controller.#state.status)) await controller.owner("host.attest", recoveryAttestation);
						await controller.system("run.settle", {});
					}
				}
			}
			if (controller.#state.ownerSessionId !== ownerSessionId) await controller.owner("run.adopt", { ownerSessionId });
			return controller;
		} catch (error) {
			journal?.close();
			// Release only a proven fresh, never-published creation's reservation.
			// Its journal/history is retained. Reopen/adoption ambiguity still keeps
			// fencing; changed leases/reservations must never be removed.
			try { lease.release({ retainReservation: !freshCreation }); } catch { /* Lost leases must never be stolen or removed. */ }
			throw error;
		}
	}

	#layout;
	get layout() { return this.#layout; }
	#listeners = new Set();
	#state = null;
	#journal;
	#lease;
	#clock;
	#operations = new Map();
	#queue = Promise.resolve();
	#closed = false;
	#fault = null;
	#executionAbort = new AbortController();

	constructor(journal, lease, clock, layout) {
		this.#layout = layout;
		this.#journal = journal;
		this.#lease = lease;
		this.#clock = clock;
	}

	snapshot() { return structuredClone(this.#state); }

	/** Read-only observers run after durable publication; failures cannot reject a commit. */
	subscribe(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Trusted workspace adapters recheck this immediately before side effects. */
	assertOwned() {
		requireCondition(!this.#fault && !this.#closed, "FENCED", "Controller is closed or uncertain");
		this.#lease.assertOwned();
	}

	/** A released terminal controller is still evidence of settlement, not live ownership. */
	assertReplaceable(ownerSessionId) {
		requireCondition(!this.#fault, "FAULT", "Persistence/ownership uncertain; recovery required");
		requireCondition(this.#state?.ownerSessionId === ownerSessionId, "OWNERSHIP", "Only the attached owner may start a new objective");
		requireCondition(TERMINAL.has(this.#state.status), "STATE", "Stop and settle the attached run before a new objective");
		requireCondition(!this.#state.tasks.some(task => task.assignment) && !this.#state.workspace?.operations.length && !this.#state.sessions?.turns.length,
			"UNSETTLED", "Prior execution remains unsettled");
		if (!this.#closed) this.assertOwned();
		else requireCondition(!inspectLease(this.#layout) && !inspectReservation(this.#layout), "OWNERSHIP", "Project ownership changed after terminal settlement");
	}

	executionSignal() { return this.#executionAbort.signal; }

	#replay(event) {
		requireCondition(!this.#operations.has(event.operationId), "DUPLICATE", "Duplicate operation in journal");
		this.#state = reduceEvent(this.#state, event);
		this.#remember(event);
	}

	#remember(event) {
		const requestHash = fingerprint(event.actor, event.type, event.payload, event.cycle, event.generation);
		const receipt = { operationId: event.operationId, revision: this.#state.revision };
		this.#operations.set(event.operationId, { requestHash, receipt, cycle: event.cycle, generation: event.generation });
		return structuredClone(receipt);
	}

	#commit(event) {
		const next = reduceEvent(this.#state, event);
		try {
			this.#journal.append(event);
		} catch (error) {
			this.#fault = error;
			this.#executionAbort.abort(error);
			this.#journal.close();
			throw error;
		}
		// Publish state only after append and fsync succeed.
		const previous = this.#state;
		this.#state = next;
		if (previous && (previous.generation !== next.generation || previous.guidanceRevision !== next.guidanceRevision)) {
			const expired = this.#executionAbort;
			this.#executionAbort = new AbortController();
			expired.abort(new Error("Execution context changed"));
		}
		const receipt = this.#remember(event);
		for (const listener of this.#listeners) {
			try { listener(Object.freeze({ type: event.type, revision: next.revision })); }
			catch { /* Observation cannot change durable execution. */ }
		}
		return receipt;
	}

	owner(type, payload = {}, options = {}) { return this.#dispatch("owner", type, payload, options); }
	system(type, payload = {}, options = {}) { return this.#dispatch("system", type, payload, options); }

	worker(workerId) {
		requireCondition(this.#state?.workers.some(worker => worker.id === workerId), "NOT_FOUND", "Worker does not exist");
		const cycle = this.#state.cycle;
		const generation = this.#state.generation;
		return {
			dispatch: (type, payload = {}, options = {}) => this.#dispatch(workerId, type, payload, { ...options, cycle, generation }),
		};
	}

	#dispatch(actor, type, payload, options) {
		// Capture caller-owned data before queuing; later mutation cannot change
		// the command that was authorized or its idempotency fingerprint.
		const input = structuredClone({ payload, options });
		const operationId = input.options.operationId ?? randomUUID();
		const execute = () => {
			requireCondition(!this.#fault, "FAULT", "Controller has uncertain persistence; recovery required");
			const prior = this.#operations.get(operationId);
			const cycle = input.options.cycle ?? prior?.cycle ?? this.#state?.cycle ?? 1;
			const generation = input.options.generation ?? prior?.generation ?? this.#state?.generation ?? 0;
			const requestHash = fingerprint(actor, type, input.payload, cycle, generation);
			if (prior) {
				requireCondition(prior.requestHash === requestHash, "DUPLICATE", "Operation identifier reused for different input");
				return structuredClone(prior.receipt);
			}
			requireCondition(!this.#closed, "CLOSED", "Controller is closed; reopen for explicit restart");
			this.#lease.assertOwned();
			const atMs = this.#clock();
			const state = this.#state;
			if (state && ["running", "verifying"].includes(state.status) && !["run.tick", "run.pause", "run.stop", "run.fail", "run.recover"].includes(type)) {
				const elapsed = state.elapsedMs + atMs - state.lastAtMs;
				if (elapsed >= state.limits.durationMs) {
					this.#commit({ version: 1, operationId: randomUUID(), actor: "system", type: "run.tick", payload: {}, expectedRevision: state.revision, cycle: state.cycle, generation: state.generation, atMs });
				}
			}
			const event = {
				version: 1, operationId, actor, type, payload: input.payload,
				expectedRevision: input.options.expectedRevision ?? this.#state?.revision ?? 0,
				cycle, generation: input.options.generation === undefined && actor === "system" && ["assignment.settle", "workspace.finish", "workspace.uncertain", "session.turn.end"].includes(type) ? this.#state.generation : generation, atMs,
			};
			const receipt = this.#commit(event);
			if (TERMINAL.has(this.#state.status)) this.#release(false);
			return receipt;
		};
		const result = this.#queue.then(execute);
		this.#queue = result.catch(() => { });
		return result;
	}

	#release(retainReservation) {
		if (this.#state.status !== "completed") this.#executionAbort.abort(new Error("Controller closed"));
		this.#journal.close();
		try {
			this.#lease.release({ retainReservation });
			this.#closed = true;
		} catch (error) {
			this.#fault = error;
			throw error;
		}
	}

	async close() {
		await this.#queue;
		if (this.#closed) { this.#listeners.clear(); return; }
		requireCondition(!this.#fault, "FAULT", "Persistence/ownership uncertain; preserve fencing for recovery");
		requireCondition(this.#state && ["paused", ...TERMINAL].includes(this.#state.status), "UNSETTLED", "Pause/stop and settle execution before closing");
		requireCondition(!this.#state.tasks.some(task => task.assignment), "UNSETTLED", "Assignments remain unsettled");
		requireCondition(!this.#state.workspace?.operations.length, "UNSETTLED", "Workspace operations remain unsettled");
		requireCondition(!this.#state.sessions?.turns.length, "UNSETTLED", "Session turns remain unsettled");
		this.#release(this.#state.status === "paused");
		this.#listeners.clear();
	}
}
