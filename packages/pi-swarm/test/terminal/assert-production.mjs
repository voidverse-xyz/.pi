// Replay actual production-policy PTY evidence, including every reducer transition.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reduceEvent } from "../../extensions/swarm/state.mjs";

const readLines = path => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
const journal = readLines(process.argv[2]).map(record => record.payload);
const observations = readLines(process.argv[3]);
const nativeProvider = process.argv[4] === "native";
let state = null;
let continuations = 0;
for (const event of journal) {
	const previous = state;
	state = reduceEvent(state, event);
	if (event.type !== "host.continue") continue;
	continuations++;
	if (nativeProvider && event.payload.restart) {
		assert.equal(state.cycle, 2);
		assert.equal(state.elapsedMs, 0);
		assert.equal(state.tasksCreated, previous.tasks.filter(task => task.status !== "done").length);
	} else {
		assert.equal(event.payload.restart, false);
		assert.equal(state.cycle, previous.cycle);
		assert.equal(state.elapsedMs, previous.elapsedMs);
		assert.equal(state.tasksCreated, previous.tasksCreated);
	}
}
assert.equal(continuations, nativeProvider ? 6 : 5);
assert.equal(state.status, "paused", "Shutdown restores a paused run, not completion");
const boundary = "Disposable project only; no network";
assert.equal(state.objective, `Production policy acceptance. Only approved benign commands execute. ${boundary}.`);
assert.deepEqual(state.criteria, ["Satisfy the behavior and verification requirements in the approved objective."]);
assert.deepEqual(state.scope, ["Work only on the requested task; honor the objective's file and dependency constraints."]);
assert.equal(state.workspace.operations.length, 0);
assert.equal(state.sessions.turns.length, 0, "SDK turns settled before shutdown finished");
assert.ok(state.tasks.every(task => !task.assignment), "All assignments actually settled");
assert.equal(state.workspace.receipts.length, nativeProvider ? 2 : 1, "Denied/cancelled commands never executed");
const receipt = state.workspace.receipts[0];
assert.equal(receipt.command, `node -e "console.log('phase8-approved')"`);
assert.equal(receipt.outcome, "succeeded");
assert.equal(receipt.exitCode, 0);
assert.equal(receipt.before, receipt.after, "Benign command preserved the checkout");
assert.equal(journal.filter(event => event.type === "workspace.start").length, nativeProvider ? 2 : 1);
assert.equal(journal.filter(event => event.type === "workspace.finish").length, nativeProvider ? 2 : 1);
assert.equal(journal.filter(event => event.type === "run.complete").length, 0);
const binding = state.sessions.workers[0];
const native = readLines(join(dirname(process.argv[2]), "sessions", binding.sessionFile));
assert.equal(native[0].id, binding.sessionId);
const results = native.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "bash");
assert.equal(results.length, nativeProvider ? 5 : 4);
assert.equal(results.filter(entry => !entry.message.isError).length, 1);
assert.ok(results.find(entry => !entry.message.isError).message.content.some(block => block.text?.includes("phase8-approved")), "Native worker history records actual stdout");
const modes = observations.filter(event => event.type === "mode");
assert.ok(modes.some(event => event.selectedMode === "quick" && event.enforcedMode === "off" && event.pendingChange));
assert.ok(modes.some(event => event.selectedMode === "off" && event.enforcedMode === "quick" && event.pendingChange));
assert.equal(new Set(modes.map(event => event.instanceId)).size, 2, "Native reload replaced production mode authority");
assert.equal(modes.filter(event => !event.ready).length, 2, "Both instances published shutdown revocation");
const opens = observations.filter(event => event.type === "dialog-open");
const closes = observations.filter(event => event.type === "dialog-close");
assert.equal(opens.length, closes.length);
assert.equal(opens.filter(event => event.owner === "swarm" && event.kind !== "custom").length, 0, "Swarm owns no modal confirmation/input dialogs; independently enabled Safety is unchanged");
assert.ok(opens.every(event => event.active === 1), "Production dialogs never overlap");
assert.ok(closes.every(event => event.active === 0));
assert.equal(opens.filter(event => event.owner === "safety").length, nativeProvider ? 9 : 8, "Worker gates plus two uncancelled queue positions per instance");
assert.equal(observations.filter(event => event.type === "probe-request").length, 6);
assert.equal(observations.filter(event => event.type === "probe-result" && !event.approved).length, 6);
console.log("PASS: replayed production-policy journal, actual exit receipt, denied-effect exclusion, paused settlement, authority replacement and native dialog lifecycle");
