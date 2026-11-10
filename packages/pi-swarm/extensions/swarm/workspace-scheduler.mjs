/**
 * Model-free, in-memory coordination; no filesystem/process execution or persistence.
 *
 * new WorkspaceScheduler()
 * acquireClaims(owner, paths) -> { owner, paths }; atomic, synchronous, throws on conflict.
 * releaseClaims(owner) -> void; refuses while any owner mutation is queued/active.
 * withMutation(owner, paths, fn, { signal }?) -> Promise<fn result>.
 * withExclusive(owner, fn, { signal }?) -> Promise<fn result>.
 * cancelOwner(owner, reason?) -> Promise<void>; permanently fences that assignment
 * identity, rejects queued work, signals active work, and waits for actual settlement.
 * snapshot() -> detached { claims, pending, active, fenced }; operation entries have
 * { id, kind, owner, paths }; claims have { owner, paths }.
 * isIdle(owner?) -> boolean; assertIdle(owner?) -> void (throws UNSETTLED).
 *
 * Owners are nonempty assignment identity strings. Paths MUST already be canonical,
 * slash-separated identities from the caller (including symlink/case resolution).
 * Ancestor claims cover descendant mutations. Overlapping claims, even for the same
 * owner, are rejected; reacquiring exactly the same claim is idempotent.
 *
 * Callbacks receive an AbortSignal directly and must not settle before their actual
 * work stops. Active cancellation rejects only AFTER callback settlement. An ignored
 * abort therefore keeps the lock. Claims persist after ordinary mutation completion.
 *
 * Overlapping mutations queue FIFO; disjoint mutations may bypass them. An exclusive
 * request blocks fresh claims/mutations with BUSY, drains already admitted mutations,
 * and relinquishes the requester's claims after its own mutations settle. Foreign
 * claims reject the exclusive BEFORE enqueue: waiting would prevent their owners
 * from finishing edits. No foreign claims are revoked. Exclusives run
 * FIFO; cancelled queued exclusives are removed (released claims are not restored).
 * Callbacks must not await nested conflicting scheduler operations: locks are not
 * reentrant. Fenced identities cannot be reused; create a fresh assignment identity.
 */

export class WorkspaceSchedulerError extends Error {
	constructor(code, message, blockers = []) {
		super(message);
		this.name = "WorkspaceSchedulerError";
		this.code = code;
		this.blockers = blockers;
	}
}

function failure(code, message, blockers) {
	return new WorkspaceSchedulerError(code, message, blockers);
}

function validateOwner(owner) {
	if (typeof owner !== "string" || !owner.trim()) throw failure("INPUT", "Expected an assignment owner");
}

function validatePaths(paths) {
	if (!Array.isArray(paths) || paths.length === 0) throw failure("INPUT", "Expected nonempty canonical paths");
	for (const path of paths) {
		if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\")) {
			throw failure("INPUT", "Expected canonical slash-separated paths");
		}
		if (path !== "/" && (path.endsWith("/") || path.includes("//") || path.split("/").some(part => part === "." || part === ".."))) {
			throw failure("INPUT", "Paths must be canonicalized by the caller");
		}
	}
	return [...new Set(paths)];
}

function contains(parent, child) {
	return parent === child || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

function overlaps(left, right) {
	return contains(left, right) || contains(right, left);
}

const PURPOSES = new Set(["mutation", "exclusive", "write", "edit", "shell", "submit", "review", "final"]);
const STAGES = new Set(["approval", "inspection", "execution", "settlement", "unknown-settlement", "recording", "candidate", "review"]);

function operationView(operation) {
	return {
		id: operation.id, kind: operation.kind, owner: operation.owner, paths: [...operation.paths],
		purpose: operation.purpose, stage: operation.stage, cancellationRequested: operation.controller.signal.aborted,
	};
}

export class WorkspaceScheduler {
	#claims = new Map();
	#mutations = [];
	#exclusives = [];
	#active = new Set();
	#fenced = new Map();
	#serial = 0;

	acquireClaims(owner, paths) {
		this.#requireOwner(owner);
		const requested = validatePaths(paths);
		this.#requireAdmission();
		const blockers = [];
		for (const path of requested) {
			for (const other of requested) {
				if (path !== other && contains(other, path)) blockers.push({ owner, path: other, requestedPath: path });
			}
			for (const [claimOwner, claimed] of this.#claims) {
				for (const claimedPath of claimed) {
					if (claimOwner === owner && path === claimedPath) continue;
					if (overlaps(path, claimedPath)) blockers.push({ owner: claimOwner, path: claimedPath, requestedPath: path });
				}
			}
		}
		if (blockers.length) throw failure("CLAIM_CONFLICT", "Paths overlap existing or requested claims", blockers);
		const claimed = new Set(this.#claims.get(owner));
		for (const path of requested) claimed.add(path);
		this.#claims.set(owner, claimed);
		return { owner, paths: [...claimed] };
	}

	releaseClaims(owner) {
		validateOwner(owner);
		if (this.#hasMutation(owner)) throw failure("UNSETTLED", "Owner mutations must settle before releasing claims");
		this.#claims.delete(owner);
		this.#pump();
	}

	async withMutation(owner, paths, fn, { signal, purpose = "mutation" } = {}) {
		this.#requireOwner(owner);
		const requested = validatePaths(paths);
		this.#validateCallback(fn, signal);
		this.#requireAdmission();
		const claims = this.#claims.get(owner) ?? new Set();
		if (requested.some(path => ![...claims].some(claim => contains(claim, path)))) {
			throw failure("CLAIM_REQUIRED", "Every mutation path requires an owner claim");
		}
		return this.#enqueue("mutation", owner, requested, fn, signal, purpose);
	}

	async withExclusive(owner, fn, { signal, purpose = "exclusive" } = {}) {
		this.#requireOwner(owner);
		this.#validateCallback(fn, signal);
		const blockers = [...this.#claims.keys()].filter(claimOwner => claimOwner !== owner)
			.map(claimOwner => ({ owner: claimOwner, kind: "claim", stage: "claims-held" }));
		if (blockers.length) throw failure("BUSY", "Foreign claims must be released before exclusive admission; request was not queued", blockers.slice(0, 8));
		return this.#enqueue("exclusive", owner, [], fn, signal, purpose);
	}

	cancelOwner(owner, reason = failure("ABORTED", "Assignment cancelled")) {
		validateOwner(owner);
		const previous = this.#fenced.get(owner);
		if (previous) return previous.settled;
		let resolve;
		const settled = new Promise(done => { resolve = done; });
		this.#fenced.set(owner, { reason, settled, resolve });
		for (const operation of [...this.#mutations, ...this.#exclusives]) {
			if (operation.owner === owner) this.#removePending(operation, reason);
		}
		for (const operation of this.#active) {
			if (operation.owner === owner) operation.controller.abort(reason);
		}
		this.#pump();
		return settled;
	}

	snapshot() {
		return {
			claims: [...this.#claims].map(([owner, paths]) => ({ owner, paths: [...paths] })),
			pending: [...this.#mutations, ...this.#exclusives].sort((a, b) => a.id - b.id).map(operationView),
			active: [...this.#active].map(operationView),
			fenced: [...this.#fenced.keys()],
		};
	}

	isIdle(owner) {
		if (owner !== undefined) validateOwner(owner);
		const matches = operation => owner === undefined || operation.owner === owner;
		const hasClaims = owner === undefined ? this.#claims.size > 0 : this.#claims.has(owner);
		return !hasClaims && ![...this.#mutations, ...this.#exclusives, ...this.#active].some(matches);
	}

	assertIdle(owner) {
		if (!this.isIdle(owner)) throw failure("UNSETTLED", "Workspace coordination has unsettled operations or claims");
	}

	#requireOwner(owner) {
		validateOwner(owner);
		if (this.#fenced.has(owner)) throw failure("FENCED", "Assignment owner has been cancelled");
	}

	#requireAdmission() {
		const exclusives = [...this.#exclusives, ...this.#active].filter(operation => operation.kind === "exclusive");
		if (exclusives.length) throw failure("BUSY", "Exclusive workspace access is pending or active", exclusives.slice(0, 8).map(operationView));
	}

	#validateCallback(fn, signal) {
		if (typeof fn !== "function") throw failure("INPUT", "Expected an operation callback");
		if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure("INPUT", "Expected an AbortSignal");
		if (signal?.aborted) throw signal.reason;
	}

	#hasMutation(owner) {
		return [...this.#mutations, ...this.#active].some(operation => operation.owner === owner && operation.kind === "mutation");
	}

	#enqueue(kind, owner, paths, fn, signal, purpose) {
		if (!PURPOSES.has(purpose)) throw failure("INPUT", "Unknown operation purpose");
		return new Promise((resolve, reject) => {
			const operation = { id: ++this.#serial, kind, owner, paths, fn, purpose, stage: "queued", resolve, reject, controller: new AbortController(), cleanup: () => {} };
			if (signal) {
				const abort = () => {
					if (this.#active.has(operation)) operation.controller.abort(signal.reason);
					else this.#removePending(operation, signal.reason);
					this.#pump();
				};
				signal.addEventListener("abort", abort, { once: true });
				operation.cleanup = () => signal.removeEventListener("abort", abort);
			}
			const queue = kind === "mutation" ? this.#mutations : this.#exclusives;
			queue.push(operation);
			this.#pump();
		});
	}

	#removePending(operation, reason) {
		const queue = operation.kind === "mutation" ? this.#mutations : this.#exclusives;
		const index = queue.indexOf(operation);
		if (index === -1) return;
		queue.splice(index, 1);
		operation.cleanup();
		operation.reject(reason);
	}

	#pump() {
		// Every upgrader drains its claims, not just the FIFO head.
		for (const { owner } of this.#exclusives) {
			if (!this.#hasMutation(owner)) this.#claims.delete(owner);
		}
		for (const [owner, fence] of this.#fenced) {
			const active = [...this.#active].some(operation => operation.owner === owner);
			if (!active) {
				this.#claims.delete(owner);
				fence.resolve();
			}
		}
		if ([...this.#active].some(operation => operation.kind === "exclusive")) return;

		const waiting = [];
		for (const operation of [...this.#mutations]) {
			const predecessors = [...this.#active, ...waiting];
			const blocked = predecessors.some(other => operation.paths.some(path => other.paths.some(otherPath => overlaps(path, otherPath))));
			if (blocked) {
				waiting.push(operation);
				continue;
			}
			this.#mutations.splice(this.#mutations.indexOf(operation), 1);
			this.#start(operation);
		}
		if (this.#active.size === 0 && this.#mutations.length === 0 && this.#claims.size === 0 && this.#exclusives.length) {
			this.#start(this.#exclusives.shift());
		}
	}

	#start(operation) {
		operation.stage = "execution";
		this.#active.add(operation);
		// Reserve the lock synchronously; execute user code outside scheduler transitions.
		Promise.resolve().then(async () => {
			const signal = operation.controller.signal;
			signal.throwIfAborted();
			const setStage = stage => {
				if (!STAGES.has(stage)) throw failure("INPUT", "Unknown operation stage");
				operation.stage = stage;
			};
			const result = await operation.fn(signal, setStage);
			signal.throwIfAborted();
			return result;
		}).then(
			result => this.#finish(operation, null, result),
			error => this.#finish(operation, { error }),
		);
	}

	#finish(operation, failureResult, result) {
		operation.cleanup();
		this.#active.delete(operation);
		this.#pump();
		if (failureResult) operation.reject(failureResult.error);
		else operation.resolve(result);
	}
}
