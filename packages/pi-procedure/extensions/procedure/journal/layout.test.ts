import assert from "node:assert/strict";
import test from "node:test";
import { createProcedureLayout, cwdSlug, isValidRunId, mintRunId } from "./layout.ts";

test("cwdSlug matches Pi's encoding", () => {
	assert.equal(cwdSlug("/home/user/workspace"), "--home-user-workspace--");
});

test("mintRunId: compact ISO + entropy, validated", () => {
	const id = mintRunId(new Date("2026-07-16T09:30:15.123Z"), "a1b2c3");
	assert.equal(id, "20260716T093015_a1b2c3");
	assert.ok(isValidRunId(id));
	assert.throws(() => mintRunId(new Date(0), "XYZ"), /entropy/);
	assert.ok(!isValidRunId("../escape"));
});

test("layout paths hang together and reject bad ids", () => {
	const l = createProcedureLayout("/proj", { home: "/home/u" });
	const runId = "20260716T093015_a1b2c3";
	assert.equal(l.proceduresStateRoot, "/home/u/.pi/agent/sessions/--proj--/procedures");
	assert.equal(l.runDir(runId), `${l.proceduresStateRoot}/${runId}`);
	assert.equal(l.journalFile(runId), `${l.runDir(runId)}/journal.jsonl`);
	assert.equal(l.agentSeqDir(runId, 3), `${l.runDir(runId)}/agents/3`);
	assert.equal(l.outputSidecarFile(runId, 3), `${l.agentSeqDir(runId, 3)}/output.json`);
	assert.equal(l.globalProceduresDir, "/home/u/.pi/agent/procedures");
	assert.equal(l.projectProceduresDir, "/proj/.pi/procedures");
	assert.equal(l.settingsFile, "/home/u/.pi/agent/procedures.json");
	assert.equal(l.procedureFile(l.globalProceduresDir, "demo"), "/home/u/.pi/agent/procedures/demo.js");
	assert.throws(() => l.runDir("../oops"), /Invalid runId/);
	assert.throws(() => l.agentSeqDir(runId, -1), /Invalid agent seq/);
});

test("explicit Pi agent-directory override owns libraries, settings, and mutable state", () => {
	const l = createProcedureLayout("/proj", { agentDir: "/tmp/pi-agent-override" });
	assert.equal(l.agentDir, "/tmp/pi-agent-override");
	assert.equal(l.globalProceduresDir, "/tmp/pi-agent-override/procedures");
	assert.equal(l.settingsFile, "/tmp/pi-agent-override/procedures.json");
	assert.ok(l.proceduresStateRoot.startsWith("/tmp/pi-agent-override/sessions/"));
});

test("stateRoot override wins", () => {
	const l = createProcedureLayout("/proj", { stateRoot: "/tmp/procedure-state" });
	assert.equal(l.proceduresStateRoot, "/tmp/procedure-state");
});
