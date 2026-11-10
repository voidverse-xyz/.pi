import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { acquireLease } from "../extensions/swarm/store/lease.mjs";
import { privateDirectory } from "../extensions/swarm/store/files.mjs";
import { openJournal } from "../extensions/swarm/store/journal.mjs";
import { machine, repository } from "./helpers.mjs";

const code = expected => error => error.code === expected;

test("missing run and invalid launch do not reserve the checkout", async t => {
	const root = repository(t);
	const options = { workspace: root, runId: "missing", ownerSessionId: "session1" };
	await assert.rejects(SwarmController.open(options), code("NOT_FOUND"));
	assert.equal(existsSync(join(prepareLayout(root, "run1").stateRoot, "reservation.json")), false);
	await assert.rejects(SwarmController.open({ ...options, create: { objective: "x", criteria: [], scope: ["src"] } }), code("INPUT"));
	assert.equal(existsSync(join(prepareLayout(root, "run1").stateRoot, "controller.lock")), false);
	assert.equal(existsSync(join(prepareLayout(root, "run1").stateRoot, "reservation.json")), false);
});

test("losing a durable reservation fences a still-live controller", t => {
	const root = repository(t); const layout = prepareLayout(root, "run1");
	const lease = acquireLease(layout);
	writeFileSync(layout.reservationPath, JSON.stringify({ version: 1, runId: "other" }), { mode: 0o600 });
	assert.throws(() => lease.assertOwned(), /reservation lost/);
	assert.throws(() => lease.release({ retainReservation: false }), /reservation lost/);
	lease.release();
	assert.equal(JSON.parse(readFileSync(layout.reservationPath, "utf8")).runId, "other");
});

test("journal detects a same-length external rewrite before another append", t => {
	const root = repository(t); const layout = prepareLayout(root, "run1");
	const lease = acquireLease(layout); privateDirectory(layout.runRoot);
	const journal = openJournal(layout.journalPath, lease.assertOwned);
	journal.append({ value: "one" });
	const contents = readFileSync(layout.journalPath, "utf8");
	writeFileSync(layout.journalPath, contents.replace("one", "two"));
	utimesSync(layout.journalPath, new Date(1000), new Date(1000));
	assert.throws(() => journal.append({ value: "next" }), /metadata changed/);
	journal.close(); lease.release();
});

for (const [request, pending, finished] of [["run.pause", "pausing", "paused"], ["run.stop", "stopping", "stopped"], ["run.fail", "failing", "failed"]]) {
	test(`recovery preserves ${pending} intent without charging offline time`, () => {
		const m = machine(); m.start(); m.time = 50;
		m.send("owner", request, request === "run.fail" ? { reason: "runtime failed" } : {});
		const generation = m.state.generation;
		m.time = 100000; m.send("system", "run.recover");
		assert.equal(m.state.status, pending);
		assert.equal(m.state.elapsedMs, 50);
		assert.equal(m.state.generation, generation + 1);
		m.send("system", "run.settle");
		assert.equal(m.state.status, finished);
	});
}

test("workers can unblock resolved local questions without owner approval", () => {
	const m = machine(); m.start(); m.worker("builder"); m.task("schema");
	m.claim("builder", "schema");
	m.send("builder", "task.yield", { taskId: "schema", blocker: "Need API answer" }); m.settle("schema");
	m.send("builder", "task.unblock", { taskId: "schema" });
	assert.equal(m.state.tasks[0].status, "ready");
	assert.equal(m.state.tasks[0].failures, 0);
});
