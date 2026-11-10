import { SwarmError } from "./errors.mjs";

export const DEFAULT_SAFETY_TIMEOUT_MS = 120_000;

const MODE_KEYS = [
	"version", "instanceId", "revision", "contextRevision", "ready", "sessionId",
	"selectedMode", "enforcedMode", "runMode", "pendingChange",
];
const MODES = new Set(["off", "discuss", "plan", "quick"]);

function modeError() {
	return new SwarmError("MODE_DENIED", "Swarm requires a current, ready, unrestricted mode provider.");
}

function copySnapshot(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw modeError();
	const keys = Reflect.ownKeys(value);
	if (keys.length !== MODE_KEYS.length || keys.some((key) => !MODE_KEYS.includes(key))) throw modeError();
	const snapshot = {};
	for (const key of MODE_KEYS) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) throw modeError();
		snapshot[key] = descriptor.value;
	}
	if (snapshot.version !== 1 || typeof snapshot.instanceId !== "string" || !snapshot.instanceId
		|| !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
		|| !Number.isSafeInteger(snapshot.contextRevision) || snapshot.contextRevision < 0
		|| typeof snapshot.ready !== "boolean" || typeof snapshot.pendingChange !== "boolean"
		|| !(snapshot.sessionId === null || (typeof snapshot.sessionId === "string" && snapshot.sessionId))
		|| !MODES.has(snapshot.selectedMode) || !MODES.has(snapshot.enforcedMode)
		|| !(snapshot.runMode === null || MODES.has(snapshot.runMode))) throw modeError();
	return Object.freeze(snapshot);
}

function permissionKey(snapshot) {
	// Off run start/end changes null <-> off without changing execution permission.
	return JSON.stringify([
		snapshot.instanceId, snapshot.sessionId, snapshot.contextRevision, snapshot.ready,
		snapshot.selectedMode, snapshot.enforcedMode, snapshot.runMode ?? "off", snapshot.pendingChange,
	]);
}

/** Synchronous, fail-closed mode checks. Tokens are valid for one permission epoch only. */
export class ModeGate {
	#events;
	#sessionId;
	#onRevoke;
	#unsubscribe;
	#snapshot;
	#healthy = false;
	#disposed = false;
	#querying = false;
	#epoch = 0;
	#controller = new AbortController();
	#tokens = new WeakMap();
	#retiredInstances = new Set();
	#seenProvider = false;

	constructor({ events, sessionId, onRevoke = () => { } }) {
		if (!events || typeof events.on !== "function" || typeof events.emit !== "function"
			|| typeof sessionId !== "string" || !sessionId || typeof onRevoke !== "function") throw modeError();
		this.#events = events;
		this.#sessionId = sessionId;
		this.#onRevoke = onRevoke;
		const listener = (value) => {
			if (this.#disposed) return;
			try { this.#seenProvider = true; this.#accept(copySnapshot(value), false); }
			catch { this.#invalidate(); }
		};
		// Subscribe before the first query so changes during that query cannot be missed.
		const unsubscribe = events.on("pi-plan:mode-changed", listener);
		if (typeof unsubscribe === "function") this.#unsubscribe = unsubscribe;
		else if (typeof events.off === "function") this.#unsubscribe = () => events.off("pi-plan:mode-changed", listener);
		else throw modeError();
	}

	#revoke() {
		this.#epoch++;
		const previous = this.#controller;
		this.#controller = new AbortController();
		previous.abort(modeError());
		// A failing pause callback must never undo fencing or leak private exception text.
		try { Promise.resolve(this.#onRevoke("Mode permission changed or became unavailable.")).catch(() => { }); }
		catch { /* Tokens are already revoked. */ }
	}

	#invalidate() {
		const wasHealthy = this.#healthy;
		this.#healthy = false;
		if (wasHealthy) this.#revoke();
	}

	#accept(snapshot, fromQuery) {
		const previous = this.#snapshot;
		if (this.#retiredInstances.has(snapshot.instanceId)) {
			if (fromQuery) throw modeError();
			return;
		}
		if (previous?.instanceId === snapshot.instanceId) {
			if (snapshot.revision < previous.revision) {
				if (fromQuery) throw modeError();
				return;
			}
			if (snapshot.contextRevision < previous.contextRevision) throw modeError();
			if (snapshot.revision === previous.revision
				&& MODE_KEYS.some((key) => previous[key] !== snapshot[key])) throw modeError();
		} else if (previous) {
			this.#retiredInstances.add(previous.instanceId);
		}
		const changed = previous && permissionKey(previous) !== permissionKey(snapshot);
		this.#snapshot = snapshot;
		this.#healthy = true;
		if (changed) this.#revoke();
	}

	current() {
		if (this.#disposed || this.#querying) {
			this.#invalidate();
			throw modeError();
		}
		this.#querying = true;
		let accepting = true;
		let count = 0;
		let response;
		let malformed = false;
		try {
			this.#events.emit("pi-plan:query-mode", Object.freeze({
				version: 1,
				respond: (value) => {
					if (!accepting) { this.#seenProvider = true; this.#invalidate(); return; }
					count++;
					this.#seenProvider = true;
					try { response = copySnapshot(value); }
					catch { malformed = true; }
				},
			}));
			accepting = false;
			if (count === 0 && !this.#seenProvider) {
				response = Object.freeze({
					version: 1, instanceId: "absent", revision: 0, contextRevision: 0,
					ready: true, sessionId: this.#sessionId, selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false
				});
			} else if (count !== 1 || malformed) throw modeError();
			this.#accept(response, true);
			if (this.#disposed || !this.#healthy) throw modeError();
			return this.#snapshot;
		} catch {
			this.#invalidate();
			throw modeError();
		} finally {
			accepting = false;
			this.#querying = false;
		}
	}

	#requirePermission(snapshot) {
		if (!snapshot.ready || snapshot.sessionId !== this.#sessionId
			|| snapshot.selectedMode !== "off" || snapshot.enforcedMode !== "off"
			|| (snapshot.runMode !== null && snapshot.runMode !== "off") || snapshot.pendingChange) throw modeError();
	}

	capture() {
		this.#requirePermission(this.current());
		const token = Object.freeze({});
		this.#tokens.set(token, this.#epoch);
		return Object.freeze({ token, signal: this.#controller.signal });
	}

	assert(token) {
		const snapshot = this.current();
		this.#requirePermission(snapshot);
		if (!token || this.#tokens.get(token) !== this.#epoch) throw modeError();
		return snapshot;
	}

	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#healthy = false;
		this.#revoke();
		this.#unsubscribe();
	}
}

function safetyRequest(request, signal) {
	if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error();
	const copy = {};
	for (const key of ["agent", "tool", "command", "path"]) {
		const descriptor = Object.getOwnPropertyDescriptor(request, key);
		if (!descriptor) continue;
		if (!("value" in descriptor) || typeof descriptor.value !== "string" || !descriptor.value) throw new Error();
		copy[key] = descriptor.value;
	}
	if (!copy.agent || !copy.tool) throw new Error();
	copy.signal = signal;
	return Object.freeze(copy);
}

function safetyResult(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { approved: false };
	const approved = Object.getOwnPropertyDescriptor(value, "approved");
	const note = Object.getOwnPropertyDescriptor(value, "note");
	if (!approved || !("value" in approved) || typeof approved.value !== "boolean"
		|| (note && (!("value" in note) || typeof note.value !== "string"))) return { approved: false };
	return note ? { approved: approved.value === true, note: note.value } : { approved: approved.value === true };
}

/** One synchronous claimant, bounded asynchronous approval, and request-local cancellation. */
export async function requestSafety({ events, request, signal, timeoutMs = DEFAULT_SAFETY_TIMEOUT_MS, probe = false }) {
	const controller = new AbortController();
	let copiedRequest;
	try { copiedRequest = safetyRequest(request, controller.signal); }
	catch { return { approved: false }; }
	if (!events || typeof events.emit !== "function" || !Number.isFinite(timeoutMs)
		|| timeoutMs <= 0 || timeoutMs > 2_147_483_647) return { approved: false };

	return new Promise((resolve) => {
		let settled = false;
		let accepting = true;
		let count = 0;
		let provider;
		let malformed = false;
		let timer;
		const deadline = performance.now() + timeoutMs;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			if (!result.approved) controller.abort();
			resolve(Object.freeze(result));
		};
		const cancel = () => finish({ approved: false });
		if (signal?.aborted) { cancel(); return; }
		signal?.addEventListener("abort", cancel, { once: true });
		timer = setTimeout(cancel, timeoutMs);
		try {
			events.emit("swarm:confirm-request", Object.freeze({
				method: "confirm",
				request: copiedRequest,
				claim: (candidate) => {
					if (!accepting) { cancel(); return; }
					count++;
					if (typeof candidate !== "function") malformed = true;
					else provider = candidate;
				},
			}));
			accepting = false;
			if (settled) return;
			if (count === 0 && performance.now() < deadline) { queueMicrotask(() => finish({ approved: false, unclaimed: true })); return; }
			if (probe && count === 1 && !malformed) { finish({ approved: false, claimed: true }); return; }
			if (count !== 1 || malformed || performance.now() >= deadline) { cancel(); return; }
			// Invoke only after claim collection: duplicate providers never open dialogs.
			Promise.resolve(provider(copiedRequest)).then((value) => {
				if (performance.now() >= deadline || signal?.aborted) { cancel(); return; }
				try { finish(safetyResult(value)); }
				catch { cancel(); }
			}, cancel);
		} catch { cancel(); }
		finally { accepting = false; }
	});
}
