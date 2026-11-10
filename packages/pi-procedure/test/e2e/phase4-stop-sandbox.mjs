/**
 * phase4-stop-sandbox.mjs — the brake and the sandbox against real sessions:
 *   - stop mid-run: sessions abort, status "stopped", partial journal, resumable
 *   - bash referencing a protected procedure dir is hard-denied (no confirmation)
 *   - unclaimed/denied confirmation fails closed but the agent turn continues
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, summary, test, ProcedureRun } from "./harness.mjs";

const { readJournal } = await jiti.import(join(EXT, "journal/journal.ts"));

const world = await makeWorld("phase4");

await test("stop mid-run: status stopped, only the finished agent journaled", async () => {
	world.scripts.push({ match: (c) => c.label === "quick", reply: () => ({ text: "QUICK" }) });
	world.scripts.push({ match: (c) => c.label === "slow", reply: () => ({ text: "SLOW", delayMs: 5000 }) });
	const src = `const a = await agent('fast task', {label: 'quick'})
const b = await agent('slow task', {label: 'slow'})
return [a, b]
`;
	const run = ProcedureRun.create(world.makeRunOptions({ source: src }));
	const done = run.execute();
	// stop once the slow agent's LLM call is in flight
	const deadline = Date.now() + 3000;
	while (world.llmCalls.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	run.stop();
	const outcome = await done;
	assert.equal(outcome.status, "stopped");
	const agents = readJournal(world.layout.journalFile(run.runId)).filter((l) => l.type === "agent");
	assert.deepEqual(agents.map((a) => [a.label, a.status]), [["quick", "ok"]]);

	// and the stopped run is resumable: quick replays, slow runs live
	world.scripts.push({ match: (c) => c.label === "slow", reply: () => ({ text: "SLOW_V2" }) });
	const resumed = ProcedureRun.create(world.makeRunOptions({ source: src, resumeFromRunId: run.runId }));
	const outcome2 = await resumed.execute();
	assert.equal(outcome2.status, "completed");
	assert.deepEqual(outcome2.result, ["QUICK", "SLOW_V2"]);
});

await test("bash referencing a protected procedure dir is hard-denied", async () => {
	world.scripts.push({
		match: (c) => c.label === "sneaky" && c.messageCount <= 1,
		reply: () => ({ tools: [{ name: "bash", args: { command: `echo pwned > ${world.layout.globalProceduresDir}/evil.js` } }] }),
	});
	world.scripts.push({
		match: (c) => c.label === "sneaky",
		reply: (c) => ({ text: c.lastUserText.includes("never allowed") || c.historyHasDeny ? "DENIED_SEEN" : "DONE" }),
	});
	const src = `return agent('try to write', {label: 'sneaky', tools: ['bash']})`;
	const run = ProcedureRun.create(world.makeRunOptions({ source: src }));
	const outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	// second reply ran after the tool error; the procedure still completed
	assert.ok(["DENIED_SEEN", "DONE"].includes(outcome.result));
	// nothing was written into the protected dir
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(join(world.layout.globalProceduresDir, "evil.js")), false);
});

await test("edit/write confirmation fails closed with the deny-all confirm", async () => {
	world.scripts.push({
		match: (c) => c.label === "writer" && c.messageCount <= 1,
		reply: () => ({ tools: [{ name: "write", args: { path: join(world.project, "out.txt"), content: "hi" } }] }),
	});
	world.scripts.push({ match: (c) => c.label === "writer", reply: () => ({ text: "GAVE_UP" }) });
	const src = `return agent('write a file', {label: 'writer', tools: ['write']})`;
	const run = ProcedureRun.create(world.makeRunOptions({ source: src }));
	const outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.result, "GAVE_UP");
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(join(world.project, "out.txt")), false, "write must not have happened");
});

summary("phase4-stop-sandbox");
