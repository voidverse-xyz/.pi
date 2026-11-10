import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { ModeGate, requestSafety, DEFAULT_SAFETY_TIMEOUT_MS } from "../extensions/swarm/host-gates.mjs";

const QUERY = "pi-plan:query-mode";
const CHANGE = "pi-plan:mode-changed";
const CONFIRM = "swarm:confirm-request";
const request = { agent: "builder", tool: "bash", command: "npm test" };

function snapshot(overrides = {}) {
	return {
		version: 1, instanceId: "provider-1", revision: 0, contextRevision: 0,
		ready: true, sessionId: "session-1", selectedMode: "off", enforcedMode: "off",
		runMode: null, pendingChange: false, ...overrides,
	};
}

function fixture(onRevoke = () => {}) {
	const events = new EventEmitter();
	let value = snapshot();
	const respond = ({ version, respond }) => {
		assert.equal(version, 1);
		respond(value);
	};
	events.on(QUERY, respond);
	const gate = new ModeGate({ events, sessionId: "session-1", onRevoke });
	return {
		events, gate, respond,
		set(next) { value = next; },
		change(overrides) {
			value = { ...value, revision: value.revision + 1, ...overrides };
			events.emit(CHANGE, value);
			return value;
		},
	};
}

function denied(fn) {
	assert.throws(fn, { code: "MODE_DENIED" });
}

function safetyWith(provider, options = {}) {
	const events = new EventEmitter();
	events.on(CONFIRM, ({ claim }) => claim(provider));
	return requestSafety({ events, request, ...options });
}

const microtask = () => new Promise((resolve) => queueMicrotask(resolve));

test("mode gate queries exact synchronous protocol and returns opaque local tokens", () => {
	const { gate } = fixture();
	const { token, signal } = gate.capture();
	assert.deepEqual(token, {});
	assert.equal(Object.isFrozen(token), true);
	assert.equal(signal.aborted, false);
	assert.deepEqual(gate.assert(token), snapshot());
	assert.equal(Object.isFrozen(gate.current()), true);
	denied(() => gate.assert({}));
	const other = fixture();
	denied(() => other.gate.assert(token));
	other.gate.dispose();
	gate.dispose();
	assert.equal(signal.aborted, true);
});

test("mode subscription is installed before any query, including reentrant changes", () => {
	const { gate, events } = fixture();
	assert.equal(events.listenerCount(CHANGE), 1);
	events.removeAllListeners(QUERY);
	events.on(QUERY, ({ respond }) => {
		respond(snapshot());
		events.emit(CHANGE, snapshot({ revision: 1, selectedMode: "plan" }));
	});
	denied(() => gate.capture());
	gate.dispose();
});

test("mode gate supports Pi-style unsubscribe closures", () => {
	const emitter = new EventEmitter();
	const events = {
		emit: (...args) => emitter.emit(...args),
		on(name, listener) {
			emitter.on(name, listener);
			return () => emitter.off(name, listener);
		},
	};
	emitter.on(QUERY, ({ respond }) => respond(snapshot()));
	const gate = new ModeGate({ events, sessionId: "session-1" });
	gate.capture();
	gate.dispose();
	gate.dispose();
	assert.equal(emitter.listenerCount(CHANGE), 0);
	denied(() => gate.current());
});

test("mode restrictions and readiness fence before onRevoke runs", async (t) => {
	for (const override of [
		{ selectedMode: "plan" }, { selectedMode: "quick" }, { selectedMode: "discuss" },
		{ enforcedMode: "plan" }, { runMode: "plan" }, { pendingChange: true },
		{ ready: false }, { sessionId: "other-session" },
	]) {
		await t.test(JSON.stringify(override), () => {
			let signal;
			let calls = 0;
			let abortedAtRevoke;
			const f = fixture(() => { calls++; abortedAtRevoke = signal.aborted; });
			({ signal } = f.gate.capture());
			f.change(override);
			assert.equal(calls, 1);
			assert.equal(abortedAtRevoke, true);
			assert.equal(signal.aborted, true);
			denied(() => f.gate.capture());
			f.gate.dispose();
		});
	}
});

test("Off -> restricted -> Off cannot renew prior tokens (ABA)", () => {
	const f = fixture();
	const old = f.gate.capture();
	f.change({ selectedMode: "plan" });
	f.change({ selectedMode: "off" });
	denied(() => f.gate.assert(old.token));
	assert.equal(old.signal.aborted, true);
	const fresh = f.gate.capture();
	f.gate.assert(fresh.token);
	assert.equal(fresh.signal.aborted, false);
	f.gate.dispose();
});

test("same-Off branch restore and provider replacement revoke permission epochs", () => {
	let calls = 0;
	const f = fixture(() => calls++);
	const first = f.gate.capture();
	f.change({ contextRevision: 1 });
	assert.equal(first.signal.aborted, true);
	assert.equal(calls, 1);
	denied(() => f.gate.assert(first.token));
	const second = f.gate.capture();
	f.change({ instanceId: "provider-2", revision: 0, contextRevision: 0 });
	assert.equal(second.signal.aborted, true);
	assert.equal(calls, 2);
	denied(() => f.gate.assert(second.token));
	f.gate.dispose();
});

test("revision-only and Off run lifecycle changes leave tokens and signal intact", () => {
	let calls = 0;
	const f = fixture(() => calls++);
	const old = f.gate.capture();
	for (const runMode of ["off", "off", null, "off", null]) {
		f.change({ runMode });
		f.gate.assert(old.token);
		assert.equal(old.signal.aborted, false);
	}
	assert.equal(calls, 0);
	f.gate.dispose();
});

test("stale events cannot revert mode; stale query responses fail closed", () => {
	const f = fixture();
	f.gate.capture();
	f.change({ selectedMode: "plan", revision: 3 });
	f.events.emit(CHANGE, snapshot({ revision: 2 }));
	denied(() => f.gate.capture());
	assert.equal(f.gate.current().selectedMode, "plan");
	f.set(snapshot({ revision: 2 }));
	denied(() => f.gate.capture());
	f.set(snapshot({ revision: 4 }));
	const fresh = f.gate.capture();
	assert.equal(fresh.signal.aborted, false);
	f.gate.dispose();
});

test("retired provider instances cannot return even with higher revisions", () => {
	const f = fixture();
	f.gate.capture();
	f.change({ instanceId: "provider-2", revision: 0 });
	const fresh = f.gate.capture();
	f.events.emit(CHANGE, snapshot({ revision: 100 }));
	f.gate.assert(fresh.token);
	f.set(snapshot({ revision: 101 }));
	denied(() => f.gate.assert(fresh.token));
	assert.equal(fresh.signal.aborted, true);
	f.gate.dispose();
});

test("same-revision conflicts and backwards context revisions are refused", async (t) => {
	for (const value of [
		snapshot({ selectedMode: "plan", revision: 1, contextRevision: 1 }),
		snapshot({ revision: 2, contextRevision: 0 }),
	]) {
		await t.test(JSON.stringify(value), () => {
			const f = fixture();
			f.set(snapshot({ revision: 1, contextRevision: 1 }));
			const old = f.gate.capture();
			f.set(value);
			denied(() => f.gate.assert(old.token));
			assert.equal(old.signal.aborted, true);
			f.gate.dispose();
		});
	}
});

test("malformed mode snapshots fail closed without invoking accessors", async (t) => {
	const missing = snapshot();
	delete missing.pendingChange;
	let accessed = false;
	const accessor = snapshot();
	Object.defineProperty(accessor, "ready", { get() { accessed = true; return true; } });
	const malformed = [null, {}, [], missing, accessor, snapshot({ extra: true }),
		snapshot({ version: 2 }), snapshot({ instanceId: "" }), snapshot({ revision: -1 }),
		snapshot({ contextRevision: 0.5 }), snapshot({ ready: "true" }), snapshot({ pendingChange: null }),
		snapshot({ runMode: undefined }), snapshot({ selectedMode: "unknown" }), snapshot({ sessionId: {} })];
	for (const [index, value] of malformed.entries()) {
		await t.test(String(index), () => {
			const f = fixture();
			const old = f.gate.capture();
			f.set(value);
			denied(() => f.gate.assert(old.token));
			assert.equal(old.signal.aborted, true);
			f.gate.dispose();
		});
	}
	assert.equal(accessed, false);
});

test("missing, duplicate, thrown, and asynchronous mode responders deny", async (t) => {
	for (const kind of ["missing", "duplicate", "throw", "async"]) {
		await t.test(kind, async () => {
			const f = fixture();
			const old = f.gate.capture();
			f.events.removeAllListeners(QUERY);
			if (kind === "duplicate") {
				f.events.on(QUERY, f.respond);
				f.events.on(QUERY, f.respond);
			}
			if (kind === "throw") f.events.on(QUERY, () => { throw new Error("private"); });
			if (kind === "async") f.events.on(QUERY, ({ respond }) => queueMicrotask(() => respond(snapshot())));
			denied(() => f.gate.assert(old.token));
			assert.equal(old.signal.aborted, true);
			await microtask();
			f.events.removeAllListeners(QUERY);
			f.events.on(QUERY, f.respond);
			denied(() => f.gate.assert(old.token));
			f.gate.capture();
			f.gate.dispose();
		});
	}
});

test("late duplicate mode response revokes an already captured permission", async () => {
	const f = fixture();
	let late;
	f.events.on(QUERY, ({ respond }) => { late = respond; });
	const old = f.gate.capture();
	queueMicrotask(() => late(snapshot()));
	await microtask();
	assert.equal(old.signal.aborted, true);
	denied(() => f.gate.assert(old.token));
	f.gate.dispose();
});

test("malformed change invalidates without erasing revision high-water mark", () => {
	const f = fixture();
	f.set(snapshot({ revision: 10 }));
	const old = f.gate.capture();
	f.events.emit(CHANGE, {});
	assert.equal(old.signal.aborted, true);
	f.set(snapshot({ revision: 9 }));
	denied(() => f.gate.capture());
	f.set(snapshot({ revision: 10 }));
	denied(() => f.gate.assert(old.token));
	f.gate.capture();
	f.gate.dispose();
});

test("mode callback errors never prevent synchronous fencing", async () => {
	for (const callback of [() => { throw new Error("private"); }, async () => { throw new Error("private"); }]) {
		const f = fixture(callback);
		const old = f.gate.capture();
		f.change({ pendingChange: true });
		assert.equal(old.signal.aborted, true);
		f.gate.dispose();
	}
	await microtask();
});

test("safety invokes sole synchronous claimant with a detached frozen request and own signal", async () => {
	const events = new EventEmitter();
	const parent = new AbortController();
	const original = { ...request };
	let providerRequest;
	events.on(CONFIRM, (event) => {
		assert.equal(event.method, "confirm");
		assert.equal(Object.isFrozen(event), true);
		assert.equal(Object.isFrozen(event.request), true);
		assert.notEqual(event.request, original);
		assert.notEqual(event.request.signal, parent.signal);
		event.claim((incoming) => {
			assert.equal(incoming, event.request);
			providerRequest = incoming;
			return { approved: true, note: "allowed" };
		});
	});
	const result = await requestSafety({ events, request: original, signal: parent.signal });
	assert.deepEqual(result, { approved: true, note: "allowed" });
	assert.equal(providerRequest.signal.aborted, false);
	assert.equal(getEventListeners(parent.signal, "abort").length, 0);
	assert.deepEqual(original, request);
});

test("safety denies absent, duplicate, malformed, late, or throwing claimants", async (t) => {
	for (const kind of ["absent", "duplicate", "malformed", "late", "throw"]) {
		await t.test(kind, async () => {
			const events = new EventEmitter();
			let called = 0;
			let providerSignal;
			const approve = () => { called++; return { approved: true }; };
			events.on(CONFIRM, ({ claim, request }) => {
				providerSignal = request.signal;
				if (kind === "duplicate") { claim(approve); claim(approve); }
				if (kind === "malformed") claim({ approved: true });
				if (kind === "late") queueMicrotask(() => claim(approve));
				if (kind === "throw") throw new Error("private");
			});
			assert.deepEqual(await requestSafety({ events, request }), kind === "absent" ? { approved: false, unclaimed: true } : { approved: false });
			await microtask();
			assert.equal(called, 0);
			assert.equal(providerSignal.aborted, true);
		});
	}
});

test("second safety provider cannot open a dialog", async () => {
	const events = new EventEmitter();
	let called = 0;
	for (let i = 0; i < 2; i++) events.on(CONFIRM, ({ claim }) => claim(() => { called++; return { approved: true }; }));
	assert.deepEqual(await requestSafety({ events, request }), { approved: false });
	assert.equal(called, 0);
});

test("safety accepts strict response values only", async (t) => {
	let accessed = false;
	const getter = { get approved() { accessed = true; return true; } };
	for (const [index, value] of [undefined, null, true, [], {}, { approved: 1 }, { approved: "true" },
		{ approved: true, note: 1 }, { approved: true, note: undefined }, getter,
		Object.create({ approved: true })].entries()) {
		await t.test(String(index), async () => {
			let signal;
			assert.deepEqual(await safetyWith((incoming) => { signal = incoming.signal; return value; }), { approved: false });
			assert.equal(signal.aborted, true);
		});
	}
	assert.equal(accessed, false);
	assert.deepEqual(await safetyWith(() => ({ approved: false, note: "declined" })), { approved: false, note: "declined" });
});

test("provider thrown errors, rejections and invalid thenables deny without exposing exception text", async () => {
	for (const provider of [
		() => { throw new Error("private command"); },
		async () => { throw new Error("private path"); },
		() => ({ get then() { throw new Error("private response"); } }),
		() => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private response"); } }),
	]) assert.deepEqual(await safetyWith(provider), { approved: false });
});

test("safety timeout aborts provider signal and ignores late approval", async () => {
	let approve;
	let providerSignal;
	const parent = new AbortController();
	const result = await safetyWith((incoming) => {
		providerSignal = incoming.signal;
		return new Promise((resolve) => { approve = resolve; });
	}, { timeoutMs: 10, signal: parent.signal });
	assert.deepEqual(result, { approved: false });
	assert.equal(providerSignal.aborted, true);
	assert.equal(parent.signal.aborted, false);
	assert.equal(getEventListeners(parent.signal, "abort").length, 0);
	approve({ approved: true });
	await microtask();
	assert.deepEqual(result, { approved: false });
});

test("safety cancellation aborts synchronously and cleans parent listener", async () => {
	let approve;
	let providerSignal;
	const parent = new AbortController();
	const pending = safetyWith((incoming) => {
		providerSignal = incoming.signal;
		return new Promise((resolve) => { approve = resolve; });
	}, { signal: parent.signal });
	assert.equal(getEventListeners(parent.signal, "abort").length, 1);
	parent.abort();
	assert.equal(providerSignal.aborted, true);
	assert.equal(getEventListeners(parent.signal, "abort").length, 0);
	approve({ approved: true });
	assert.deepEqual(await pending, { approved: false });
});

test("mode epoch changes synchronously cancel linked safety requests before host pause", async () => {
	let providerSignal;
	let abortedBeforePause;
	const f = fixture(() => { abortedBeforePause = providerSignal.aborted; });
	const permission = f.gate.capture();
	let approve;
	const pending = safetyWith((incoming) => {
		providerSignal = incoming.signal;
		return new Promise((resolve) => { approve = resolve; });
	}, { signal: permission.signal });
	f.change({ contextRevision: 1 });
	assert.equal(abortedBeforePause, true);
	assert.equal(providerSignal.aborted, true);
	approve({ approved: true });
	assert.deepEqual(await pending, { approved: false });
	denied(() => f.gate.assert(permission.token));
	f.gate.dispose();
});

test("already canceled safety requests never emit or invoke providers", async () => {
	let called = 0;
	const parent = new AbortController();
	parent.abort();
	const events = { emit() { called++; } };
	assert.deepEqual(await requestSafety({ events, request, signal: parent.signal }), { approved: false });
	assert.equal(called, 0);
});

test("late duplicate claim cancels a pending provider and cannot flip denial", async () => {
	const events = new EventEmitter();
	let approve;
	let providerSignal;
	events.on(CONFIRM, ({ claim, request }) => {
		providerSignal = request.signal;
		claim(() => new Promise((resolve) => { approve = resolve; }));
		queueMicrotask(() => claim(() => ({ approved: true })));
	});
	const result = await requestSafety({ events, request });
	assert.deepEqual(result, { approved: false });
	assert.equal(providerSignal.aborted, true);
	approve({ approved: true });
	await microtask();
	assert.deepEqual(result, { approved: false });
});

test("safety deadline covers synchronous provider and claim work too", async () => {
	const stall = () => { const end = performance.now() + 8; while (performance.now() < end) { /* Simulated blocking provider. */ } };
	assert.deepEqual(await safetyWith(() => { stall(); return { approved: true }; }, { timeoutMs: 1 }), { approved: false });
	const events = new EventEmitter();
	let called = false;
	events.on(CONFIRM, ({ claim }) => {
		claim(() => { called = true; return { approved: true }; });
		stall();
	});
	assert.deepEqual(await requestSafety({ events, request, timeoutMs: 1 }), { approved: false });
	assert.equal(called, false);
});

test("safety success removes cancellation hooks and clears its timeout", async () => {
	const parent = new AbortController();
	let providerSignal;
	assert.deepEqual(await safetyWith((incoming) => {
		providerSignal = incoming.signal;
		return { approved: true };
	}, { timeoutMs: 20, signal: parent.signal }), { approved: true });
	parent.abort();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(providerSignal.aborted, false);
	assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("malformed safety inputs and deadlines deny before emission", async () => {
	let emissions = 0;
	const events = { emit() { emissions++; } };
	for (const malformed of [null, {}, { agent: "builder" }, { ...request, command: 1 }]) {
		assert.deepEqual(await requestSafety({ events, request: malformed }), { approved: false });
	}
	for (const timeoutMs of [0, -1, Infinity, NaN, 2 ** 32]) {
		assert.deepEqual(await requestSafety({ events, request, timeoutMs }), { approved: false });
	}
	assert.equal(emissions, 0);
});


test("default Safety deadline gives the provider two minutes without removing cancellation", async t => {
	assert.equal(DEFAULT_SAFETY_TIMEOUT_MS, 120000);
	const delays = [];
	const original = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => { delays.push(delay); return original(fn, delay, ...args); });
	const parent = new AbortController();
	let providerSignal;
	const pending = safetyWith(request => { providerSignal = request.signal; return new Promise(() => {}); }, { signal: parent.signal });
	assert.deepEqual(delays, [120000]);
	assert.equal(providerSignal.aborted, false);
	parent.abort();
	assert.deepEqual(await pending, { approved: false });
	assert.equal(providerSignal.aborted, true);
});
