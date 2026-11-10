import test from "node:test";
import assert from "node:assert/strict";
import {
	WorkspaceScheduler,
	WorkspaceSchedulerError,
} from "../extensions/swarm/workspace-scheduler.mjs";

const code = expected => error => error instanceof WorkspaceSchedulerError && error.code === expected;
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

function heldOperation() {
	const entered = deferred();
	const finished = deferred();
	return {
		entered: entered.promise,
		finish: finished.resolve,
		fail: finished.reject,
		async run(signal) {
			entered.resolve(signal);
			return finished.promise;
		},
	};
}

test("claims are atomic with owner details and segment-aware ancestor conflicts", () => {
	const scheduler = new WorkspaceScheduler();
	assert.deepEqual(scheduler.acquireClaims("task-a", ["/src/a", "/src/a"]), { owner: "task-a", paths: ["/src/a"] });
	assert.throws(() => scheduler.acquireClaims("task-b", ["/free", "/src/a/file"]), error => {
		assert.equal(error.code, "CLAIM_CONFLICT");
		assert.deepEqual(error.blockers, [{ owner: "task-a", path: "/src/a", requestedPath: "/src/a/file" }]);
		return true;
	});
	assert.equal(scheduler.isIdle("task-b"), true);
	assert.throws(() => scheduler.acquireClaims("task-b", ["/src"]), code("CLAIM_CONFLICT"));
	assert.throws(() => scheduler.acquireClaims("task-a", ["/src/a/file"]), code("CLAIM_CONFLICT"));
	assert.deepEqual(scheduler.acquireClaims("task-a", ["/src/a"]), { owner: "task-a", paths: ["/src/a"] });
	assert.throws(() => scheduler.acquireClaims("task-b", ["/new", "/new/child"]), code("CLAIM_CONFLICT"));
	scheduler.acquireClaims("task-b", ["/src/ab"]);
	assert.throws(() => scheduler.acquireClaims("task-c", ["/"]), code("CLAIM_CONFLICT"));
	scheduler.releaseClaims("task-a");
	scheduler.releaseClaims("task-b");
	scheduler.acquireClaims("root", ["/"]);
	assert.throws(() => scheduler.acquireClaims("task-a", ["/elsewhere"]), code("CLAIM_CONFLICT"));
	scheduler.releaseClaims("root");
	scheduler.assertIdle();
});

test("requires claims and canonical inputs before invoking callbacks", async () => {
	const scheduler = new WorkspaceScheduler();
	let invoked = false;
	await assert.rejects(scheduler.withMutation("task", ["/a"], () => { invoked = true; }), code("CLAIM_REQUIRED"));
	for (const paths of [[], [""], ["/a/../b"], ["/a/"], ["/a//b"], ["a\\b"], ["\0"]]) {
		assert.throws(() => scheduler.acquireClaims("task", paths), code("INPUT"));
	}
	assert.throws(() => scheduler.acquireClaims("", ["/a"]), code("INPUT"));
	await assert.rejects(scheduler.withExclusive("task", null), code("INPUT"));
	await assert.rejects(scheduler.withExclusive("task", () => {}, { signal: {} }), code("INPUT"));
	assert.equal(invoked, false);
	scheduler.assertIdle();
});

test("overlapping mutations serialize FIFO while disjoint mutations run concurrently", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("task-a", ["/src"]);
	scheduler.acquireClaims("task-b", ["/other"]);
	const first = heldOperation();
	const order = [];
	const firstPromise = scheduler.withMutation("task-a", ["/src/a"], first.run);
	await first.entered;
	const secondPromise = scheduler.withMutation("task-a", ["/src"], () => { order.push("second"); });
	const thirdPromise = scheduler.withMutation("task-a", ["/src/a"], () => { order.push("third"); });
	// This overlaps the queued ancestor, so it cannot bypass that FIFO predecessor.
	const fourthPromise = scheduler.withMutation("task-a", ["/src/b"], () => { order.push("fourth"); });
	await scheduler.withMutation("task-b", ["/other"], () => { order.push("disjoint"); });
	assert.deepEqual(order, ["disjoint"]);
	assert.equal(scheduler.snapshot().pending.length, 3);
	assert.throws(() => scheduler.releaseClaims("task-a"), code("UNSETTLED"));
	first.finish(17);
	assert.equal(await firstPromise, 17);
	await Promise.all([secondPromise, thirdPromise, fourthPromise]);
	assert.deepEqual(order, ["disjoint", "second", "third", "fourth"]);
	scheduler.releaseClaims("task-a");
	scheduler.releaseClaims("task-b");
	scheduler.assertIdle();
});

test("same owner's disjoint mutations overlap and pin claims through rejection", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("task", ["/src"]);
	const first = heldOperation();
	const second = heldOperation();
	const error = new Error("write failed");
	const firstPromise = scheduler.withMutation("task", ["/src/a"], first.run);
	const rejected = assert.rejects(firstPromise, failure => failure === error);
	const secondPromise = scheduler.withMutation("task", ["/src/b"], second.run);
	await Promise.all([first.entered, second.entered]);
	assert.equal(scheduler.snapshot().active.length, 2);
	first.fail(error);
	await rejected;
	assert.throws(() => scheduler.releaseClaims("task"), code("UNSETTLED"));
	second.finish();
	await secondPromise;
	scheduler.releaseClaims("task");
	scheduler.assertIdle();
});

test("foreign claims reject exclusive admission without wedging the claimant's edit", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("claimant", ["/private-target"]);
	await assert.rejects(scheduler.withExclusive("submitter", () => assert.fail("rejected submission ran")), error => {
		assert.equal(error.code, "BUSY");
		assert.deepEqual(error.blockers, [{ owner: "claimant", kind: "claim", stage: "claims-held" }]);
		assert.ok(!JSON.stringify(error.blockers).includes("private-target"));
		return true;
	});
	assert.deepEqual(scheduler.snapshot().pending, []);
	let edited = false;
	await scheduler.withMutation("claimant", ["/private-target"], () => { edited = true; });
	assert.equal(edited, true);
	scheduler.releaseClaims("claimant");
	assert.equal(await scheduler.withExclusive("submitter", () => "current"), "current");
	scheduler.assertIdle();
});

test("pending exclusive drains own already-admitted mutations and preserves the barrier", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("writer", ["/src"]);
	const write = heldOperation();
	const running = scheduler.withMutation("writer", ["/src"], write.run);
	await write.entered;
	const order = [];
	const queued = scheduler.withMutation("writer", ["/src"], () => { order.push("write"); });
	const exclusive = scheduler.withExclusive("writer", () => { order.push("exclusive"); });
	assert.throws(() => scheduler.acquireClaims("other", ["/other"]), code("BUSY"));
	await assert.rejects(scheduler.withMutation("writer", ["/src"], () => assert.fail()), code("BUSY"));
	write.finish();
	await Promise.all([running, queued, exclusive]);
	assert.deepEqual(order, ["write", "exclusive"]);
	scheduler.assertIdle();
});

test("competing upgraders fail fast without dropping either owner's claims", async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("a", ["/a"]); scheduler.acquireClaims("b", ["/b"]);
	await assert.rejects(scheduler.withExclusive("a", () => assert.fail()), code("BUSY"));
	await assert.rejects(scheduler.withExclusive("b", () => assert.fail()), code("BUSY"));
	assert.equal(scheduler.snapshot().claims.length, 2);
	assert.equal(scheduler.snapshot().pending.length, 0);
	scheduler.releaseClaims("a"); scheduler.releaseClaims("b");
	scheduler.assertIdle();
});

test("exclusive requests are FIFO and cannot be starved by fresh claims or mutations", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	const first = heldOperation();
	const firstPromise = scheduler.withExclusive("a", first.run);
	await first.entered;
	const order = [];
	const second = scheduler.withExclusive("b", () => { order.push("b"); });
	const third = scheduler.withExclusive("c", () => { order.push("c"); });
	assert.throws(() => scheduler.acquireClaims("new", ["/new"]), code("BUSY"));
	await assert.rejects(scheduler.withMutation("new", ["/new"], () => {}), code("BUSY"));
	first.finish();
	await Promise.all([firstPromise, second, third]);
	assert.deepEqual(order, ["b", "c"]);
	scheduler.assertIdle();
});

test("cancelling the sole queued exclusive removes its request and unblocks admission", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("shell", ["/other"]);
	const active = heldOperation();
	const running = scheduler.withMutation("shell", ["/other"], active.run);
	await active.entered;
	const abort = new AbortController();
	const reason = new Error("cancel queue");
	let invoked = false;
	const shell = scheduler.withExclusive("shell", () => { invoked = true; }, { signal: abort.signal });
	const rejected = assert.rejects(shell, error => error === reason);
	abort.abort(reason);
	await rejected;
	assert.equal(invoked, false);
	assert.deepEqual(scheduler.snapshot().pending, []);
	scheduler.acquireClaims("new", ["/new"]);
	active.finish(); await running;
	await scheduler.withMutation("shell", ["/other"], () => {});
	scheduler.releaseClaims("shell");
	scheduler.releaseClaims("new");
	scheduler.assertIdle();
});

test("cancelling an upgrade before mutation settlement keeps claims and restores admission", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("writer", ["/a"]);
	const write = heldOperation();
	const running = scheduler.withMutation("writer", ["/a"], write.run);
	await write.entered;
	const abort = new AbortController();
	const upgrade = scheduler.withExclusive("writer", () => assert.fail("cancelled upgrade ran"), { signal: abort.signal });
	const rejected = assert.rejects(upgrade, { name: "AbortError" });
	abort.abort();
	await rejected;
	assert.throws(() => scheduler.releaseClaims("writer"), code("UNSETTLED"));
	scheduler.acquireClaims("other", ["/b"]);
	await scheduler.withMutation("other", ["/b"], () => {});
	write.finish();
	await running;
	assert.equal(scheduler.snapshot().claims.length, 2);
	scheduler.releaseClaims("writer");
	scheduler.releaseClaims("other");
	scheduler.assertIdle();
});

test("cancelling a queued FIFO head lets the next exclusive proceed", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	const active = heldOperation();
	const running = scheduler.withExclusive("active", active.run);
	await active.entered;
	const abort = new AbortController();
	const first = scheduler.withExclusive("first", () => assert.fail("cancelled callback ran"), { signal: abort.signal });
	const rejected = assert.rejects(first, { name: "AbortError" });
	const second = scheduler.withExclusive("second", () => "next");
	abort.abort();
	await rejected;
	assert.deepEqual(scheduler.snapshot().pending.map(operation => operation.owner), ["second"]);
	active.finish(); await running;
	assert.equal(await second, "next");
	scheduler.assertIdle();
});

test("active exclusive abort signals callback but holds exclusion until actual settlement", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	const abort = new AbortController();
	const operation = heldOperation();
	const promise = scheduler.withExclusive("shell", operation.run, { signal: abort.signal });
	const rejected = assert.rejects(promise, { name: "AbortError" });
	const callbackSignal = await operation.entered;
	let nextRan = false;
	const next = scheduler.withExclusive("next", () => { nextRan = true; });
	abort.abort();
	await flush();
	assert.equal(callbackSignal.aborted, true);
	assert.equal(scheduler.isIdle("shell"), false);
	assert.equal(nextRan, false);
	assert.throws(() => scheduler.acquireClaims("writer", ["/a"]), code("BUSY"));
	operation.finish();
	await Promise.all([rejected, next]);
	assert.equal(nextRan, true);
	scheduler.assertIdle();
});

test("queued mutation abort does not run it or unpin the active mutation", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("writer", ["/a"]);
	const active = heldOperation();
	const running = scheduler.withMutation("writer", ["/a"], active.run);
	await active.entered;
	const abort = new AbortController();
	const queued = scheduler.withMutation("writer", ["/a"], () => assert.fail("cancelled mutation ran"), { signal: abort.signal });
	const rejected = assert.rejects(queued, { name: "AbortError" });
	abort.abort();
	await rejected;
	assert.deepEqual(scheduler.snapshot().pending, []);
	assert.throws(() => scheduler.releaseClaims("writer"), code("UNSETTLED"));
	active.finish();
	await running;
	scheduler.releaseClaims("writer");
	scheduler.assertIdle();
});

test("active mutation abort pins claims until callback settles and then keeps ordinary claims", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("writer", ["/a"]);
	const abort = new AbortController();
	const active = heldOperation();
	const running = scheduler.withMutation("writer", ["/a"], active.run, { signal: abort.signal });
	const rejected = assert.rejects(running, { name: "AbortError" });
	const signal = await active.entered;
	abort.abort();
	assert.equal(signal.aborted, true);
	assert.throws(() => scheduler.releaseClaims("writer"), code("UNSETTLED"));
	assert.throws(() => scheduler.acquireClaims("other", ["/a"]), code("CLAIM_CONFLICT"));
	active.finish();
	await rejected;
	assert.equal(scheduler.snapshot().claims.length, 1);
	scheduler.releaseClaims("writer");
	scheduler.assertIdle();
});

test("owner cancellation fences all work and releases no claims until all active mutations settle", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("writer", ["/a", "/b", "/idle"]);
	const first = heldOperation();
	const second = heldOperation();
	const running = [scheduler.withMutation("writer", ["/a"], first.run), scheduler.withMutation("writer", ["/b"], second.run)];
	const signals = await Promise.all([first.entered, second.entered]);
	const queuedWrite = scheduler.withMutation("writer", ["/a"], () => assert.fail("fenced write ran"));
	const queuedShell = scheduler.withExclusive("writer", () => assert.fail("fenced shell ran"));
	const rejected = [...running, queuedWrite, queuedShell].map(promise => assert.rejects(promise, code("ABORTED")));
	let settled = false;
	const cancellation = scheduler.cancelOwner("writer");
	cancellation.then(() => { settled = true; });
	assert.equal(scheduler.cancelOwner("writer"), cancellation);
	assert.equal(signals.every(signal => signal.aborted), true);
	assert.deepEqual(scheduler.snapshot().pending, []);
	assert.throws(() => scheduler.acquireClaims("writer", ["/new"]), code("FENCED"));
	await assert.rejects(scheduler.withMutation("writer", ["/a"], () => {}), code("FENCED"));
	await assert.rejects(scheduler.withExclusive("writer", () => {}), code("FENCED"));
	assert.throws(() => scheduler.releaseClaims("writer"), code("UNSETTLED"));
	assert.throws(() => scheduler.acquireClaims("other", ["/idle"]), code("CLAIM_CONFLICT"));
	first.finish();
	await rejected[0];
	assert.equal(settled, false);
	assert.equal(scheduler.snapshot().claims[0].paths.length, 3);
	second.finish();
	await Promise.all([...rejected, cancellation]);
	assert.equal(settled, true);
	scheduler.assertIdle("writer");
	scheduler.assertIdle();
	scheduler.acquireClaims("fresh-assignment", ["/a", "/b"]);
	scheduler.releaseClaims("fresh-assignment");
});

test("cancelling an active exclusive owner waits for settlement before the next owner", { timeout: 2000 }, async () => {
	const scheduler = new WorkspaceScheduler();
	const active = heldOperation();
	const running = scheduler.withExclusive("shell", active.run);
	const rejected = assert.rejects(running, code("ABORTED"));
	const signal = await active.entered;
	let nextRan = false;
	const next = scheduler.withExclusive("next", () => { nextRan = true; });
	const cancelled = scheduler.cancelOwner("shell");
	await flush();
	assert.equal(signal.aborted, true);
	assert.equal(nextRan, false);
	assert.throws(() => scheduler.assertIdle("shell"), code("UNSETTLED"));
	active.finish();
	await Promise.all([cancelled, rejected, next]);
	scheduler.assertIdle();
});

test("cancellation before a reserved callback starts never invokes it", async () => {
	const scheduler = new WorkspaceScheduler();
	const abort = new AbortController();
	const operation = scheduler.withExclusive("shell", () => assert.fail("aborted callback ran"), { signal: abort.signal });
	const rejected = assert.rejects(operation, { name: "AbortError" });
	abort.abort();
	assert.equal(scheduler.isIdle(), false);
	await rejected;
	scheduler.assertIdle();
});

test("pre-aborted requests preserve claims, synchronous throws unlock, and snapshots are detached", async () => {
	const scheduler = new WorkspaceScheduler();
	scheduler.acquireClaims("task", ["/a"]);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(scheduler.withExclusive("task", () => assert.fail(), { signal: abort.signal }), { name: "AbortError" });
	await assert.rejects(scheduler.withMutation("task", ["/a"], () => assert.fail(), { signal: abort.signal }), { name: "AbortError" });
	const snapshot = scheduler.snapshot();
	snapshot.claims[0].paths.push("/injected");
	snapshot.claims[0].owner = "injected";
	assert.deepEqual(scheduler.snapshot().claims, [{ owner: "task", paths: ["/a"] }]);
	assert.equal(scheduler.isIdle(), false);
	assert.equal(scheduler.isIdle("other"), true);
	await assert.rejects(scheduler.withMutation("task", ["/a"], () => { throw new Error("sync write failure"); }), /sync write failure/);
	scheduler.releaseClaims("task");
	await assert.rejects(scheduler.withExclusive("task", () => { throw new Error("sync shell failure"); }), /sync shell failure/);
	await scheduler.cancelOwner("idle");
	assert.equal(scheduler.isIdle("idle"), true);
	scheduler.assertIdle();
});
