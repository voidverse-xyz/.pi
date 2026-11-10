import test from "node:test";
import assert from "node:assert/strict";
import { repository } from "./helpers.mjs";
import { createMockRuntime } from "./sdk-env.mjs";
import { guardNetwork } from "./network-guard.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { SwarmSessions } from "../extensions/swarm/sessions.mjs";
import { WorkspaceRuntime } from "../extensions/swarm/workspace.mjs";

const specialist = id => ({ id, specialization: `${id} focus`, brief: "Preserve context", reason: "Focused work" });
async function until(predicate) {
	for (let i = 0; i < 500; i++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail("Offline driver condition did not settle");
}
async function fixture(t, script, options = {}) {
	guardNetwork(t);
	const root = repository(t);
	const mock = await createMockRuntime(script);
	const controller = await SwarmController.open({ workspace: root, runId: "models", ownerSessionId: "owner", clock: () => 0,
		create: { objective: "Test pinned workers", criteria: ["Pins preserved"], scope: ["src"], limits: { active: 1 } } });
	const workspace = await WorkspaceRuntime.attach(controller, { authorize: async () => true });
	const driver = await SwarmSessions.attach(controller, { workspace, modelRuntime: mock.modelRuntime, mainModel: mock.model, tickIntervalMs: 0, ...options });
	await driver.resume({ reconciled: true });
	t.after(async () => { await driver.pause(); await driver.close(); });
	return { controller, driver, mock };
}

test("quiescence retains wakes, rejects compaction starts, and lets active native work settle without abort", async t => {
	let finish;
	const held = new Promise(resolve => { finish = resolve; });
	t.after(() => finish());
	const f = await fixture(t, async ({ index }) => { if (index === 0) await held; return { text: "Settled normally" }; });
	await f.driver.recruit(specialist("first"));
	await f.driver.recruit(specialist("second"));
	f.driver.wake("first");
	await until(() => f.mock.calls.length === 1);
	let settled = false;
	const waiting = f.driver.quiesce().then(release => { settled = true; return release; });
	f.driver.wake("second");
	await assert.rejects(f.driver.compact("second"), error => error.code === "BUSY");
	await assert.rejects(f.driver.refreshModels(), error => error.code === "UNSETTLED");
	await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(settled, false);
	assert.equal(f.mock.calls[0].options.signal.aborted, false);
	finish();
	const release = await waiting;
	assert.equal(f.controller.snapshot().sessions.turns.length, 0);
	assert.deepEqual(f.driver.snapshot().active, []);
	assert.deepEqual(f.driver.snapshot().queued, ["second"]);
	assert.equal(f.controller.snapshot().sessions.history[0].outcome, "settled");
	release(); release();
	await f.driver.idle();
	assert.equal(f.mock.calls.length, 2);
});

test("quiescence waits native retries instead of cancelling or fencing their follow-up", async t => {
	const f = await fixture(t, [{ error: "429 rate limit exceeded" }, { text: "Retry recovered" }, { text: "Queued continuation" }]);
	await f.driver.recruit(specialist("worker"));
	f.driver.wake("worker");
	await until(() => f.mock.calls.length === 1);
	const waiting = f.driver.quiesce();
	f.driver.wake("worker");
	const release = await waiting;
	assert.equal(f.mock.calls.length, 2);
	assert.equal(f.mock.calls[0].options.signal.aborted, false);
	assert.equal(f.controller.snapshot().sessions.history[0].outcome, "settled");
	release();
	await f.driver.idle();
	assert.equal(f.mock.calls.length, 3);
});

test("quiescence lets active manual compaction persist before releasing queued wakes", async t => {
	let finish;
	const held = new Promise(resolve => { finish = resolve; });
	t.after(() => finish());
	const f = await fixture(t, async ({ index }) => {
		if (index === 2) { await held; return { text: "Preserved native summary" }; }
		return { text: "Old decision" };
	});
	await f.driver.recruit(specialist("worker"));
	f.driver.wake("worker", "Old history. ".repeat(8000)); await f.driver.idle();
	f.driver.wake("worker", "Recent history. ".repeat(8000)); await f.driver.idle();
	const compact = f.driver.compact("worker");
	await until(() => f.mock.calls.length === 3);
	const waiting = f.driver.quiesce();
	f.driver.wake("worker");
	assert.equal(f.mock.calls[2].options.signal.aborted, false);
	finish();
	const release = await waiting;
	await compact;
	assert.ok((await f.driver.history("worker", 100)).some(entry => entry.type === "compaction"));
	assert.equal(f.controller.snapshot().sessions.turns.length, 0);
	release();
	await f.driver.idle();
	assert.equal(f.mock.calls.length, 4);
	assert.match(JSON.stringify(f.mock.calls[3].context), /Preserved native summary/);
});

test("cancellation releases a pending barrier without aborting native work", async t => {
	let finish;
	const held = new Promise(resolve => { finish = resolve; });
	t.after(() => finish());
	const f = await fixture(t, async ({ index }) => { if (index === 0) await held; return { text: "Normal answer" }; });
	await f.driver.recruit(specialist("first"));
	await f.driver.recruit(specialist("second"));
	f.driver.wake("first");
	await until(() => f.mock.calls.length === 1);
	const cancellation = new AbortController();
	const waiting = f.driver.quiesce({ signal: cancellation.signal });
	f.driver.wake("second");
	cancellation.abort();
	await assert.rejects(waiting, error => error.name === "AbortError");
	assert.equal(f.mock.calls[0].options.signal.aborted, false);
	finish();
	await f.driver.idle();
	assert.equal(f.mock.calls.length, 2);
});

test("idle quiescence suppresses timer journal churn and refuses orphan recovery state", async t => {
	const f = await fixture(t, () => ({ text: "Normal answer" }));
	const release = await f.driver.quiesce();
	const revision = f.controller.snapshot().revision;
	await f.driver.tick(); assert.equal(f.controller.snapshot().revision, revision);
	release(); await f.driver.tick(); assert.ok(f.controller.snapshot().revision > revision);
	const snapshot = f.controller.snapshot.bind(f.controller);
	f.controller.snapshot = () => {
		const state = snapshot(); state.sessions.turns.push({ id: "orphan", workerId: "missing" }); return state;
	};
	await assert.rejects(f.driver.quiesce(), { code: "UNSETTLED" });
	f.controller.snapshot = () => {
		const state = snapshot(); state.workspace.operations.push({ id: "orphan" }); return state;
	};
	await assert.rejects(f.driver.quiesce(), { code: "UNSETTLED" });
	f.controller.snapshot = snapshot;
	const released = await f.driver.quiesce(); released();
});

test("per-worker pins are persisted and refresh evicts changed thinking without rebinding identity or losing history", async t => {
	const f = await fixture(t, () => ({ text: "Retained decision" }), {
		workerModels: [{ workerId: "pinned", selection: { provider: "swarm-mock", modelId: "scripted", thinkingLevel: "high" } }],
	});
	const bound = await f.driver.recruit(specialist("pinned"));
	await f.driver.recruit(specialist("default"));
	f.driver.wake("pinned"); f.driver.wake("default");
	await f.driver.idle();
	assert.equal(f.mock.calls[0].options.reasoning, "high");
	assert.equal(f.mock.calls[1].options.reasoning, undefined);
	const bindings = f.controller.snapshot().sessions.workers;
	const release = await f.driver.quiesce();
	// Driver unit seam: the host/reducer integration separately tests approved journaling.
	const snapshot = f.controller.snapshot.bind(f.controller);
	f.controller.snapshot = () => {
		const state = snapshot();
		state.sessions.workerModels[0].selection.thinkingLevel = "low";
		return state;
	};
	await f.driver.refreshModels();
	f.driver.wake("pinned");
	release();
	await f.driver.idle();
	assert.equal(f.mock.calls[2].options.reasoning, "low");
	assert.match(JSON.stringify(f.mock.calls[2].context), /Retained decision/);
	assert.deepEqual(f.controller.snapshot().sessions.workers, bindings);
	assert.equal(f.controller.snapshot().sessions.workers.find(worker => worker.workerId === "pinned").sessionId, bound.sessionId);
	assert.deepEqual(f.driver.snapshot().errors, []);
});
