import test from "node:test";
import assert from "node:assert/strict";
import { waitForChange } from "../extensions/swarm/wait.mjs";

test("event wait ignores ticks and wakes for actual task settlement, cleaning listeners", async () => {
	let listener; let removed = 0;
	const run = { status: "running", tasks: [{ id: "one", status: "assigned" }], limits: {}, sessions: { turns: [] } };
	const source = { snapshot: () => ({ run }), subscribe: fn => { listener = fn; return () => removed++; } };
	const waiting = waitForChange(source, { timeoutMs: 1000 });
	run.revision = 3; run.elapsedMs = 100; listener();
	assert.equal(removed, 0);
	run.tasks[0].pending = { kind: "submit" }; listener();
	assert.equal(removed, 0, "a conversational or pending report is not a settled candidate");
	run.tasks[0].status = "submitted"; listener();
	assert.equal((await waiting).changed, true); assert.equal(removed, 1);
});

test("timeout and abort do not claim work or completion", async () => {
	let removed = 0;
	const source = { snapshot: () => ({}), subscribe: () => () => removed++ };
	assert.equal((await waitForChange(source, { timeoutMs: 1 })).changed, false);
	const abort = new AbortController(); const waiting = waitForChange(source, { signal: abort.signal }); abort.abort();
	assert.deepEqual(await waiting, { changed: false, reason: "cancelled" });
	assert.equal(removed, 2);
	assert.throws(() => waitForChange(source, { timeoutMs: 0 }));
});

test("a changed blocker explanation wakes a waiter even when the task remains blocked", async () => {
	let listener;
	const run = { status: "running", tasks: [{ id: "one", status: "blocked", blocker: "Awaiting owner" }], limits: {} };
	const source = { snapshot: () => ({ run }), subscribe: fn => { listener = fn; return () => {}; } };
	const waiting = waitForChange(source, { timeoutMs: 1000 });
	run.tasks[0].blocker = "Awaiting independent review"; listener();
	assert.equal((await waiting).changed, true);
});
