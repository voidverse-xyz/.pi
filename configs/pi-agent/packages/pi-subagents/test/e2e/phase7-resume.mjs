/**
 * Phase-7 resume e2e: the host lease (exclusive claim, foreign-live rejection,
 * release/reclaim), and a second core on the same scope reloading the registry
 * with persistent typed AND persistent ad-hoc agents keeping their memory and
 * constitutions across "restarts".
 *
 * Run: node phase7-resume.mjs
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, test, summary } from "./harness.mjs";

const { claimHostScope, HostScopeLockedError } = await jiti.import(join(EXT, "store/host-lease.ts"));
const { createStatusTool } = await jiti.import(join(EXT, "tools/main-agent.ts"));

const world = await makeWorld("phase7");
world.writeDef("keeper", "You are KEEPER. Remember everything.");
const layout = world.makeLayout("sess-7");

console.log("host lease:");
await test("exclusive claim: second claim in the same (live) process is rejected, release reopens", () => {
	const lease = claimHostScope(layout);
	assert.throws(() => claimHostScope(layout), HostScopeLockedError);
	try {
		claimHostScope(layout);
	} catch (error) {
		assert.equal(error.ownerPid, process.pid, "the error names the owning pid");
	}
	lease.release();
	const second = claimHostScope(layout);
	second.release();
});

console.log("restart with memory:");
await test("life 1: typed persistent + ad-hoc persistent do work and go dormant", async () => {
	const core = world.makeCore(layout, { maxConcurrent: 4 });
	world.scripts.push({ match: (c) => c.address === "keeper/main" && c.lastUserText.includes("Remember the code word"), reply: () => ({ tools: [{ name: "report", args: { text: "Stored.", final: true } }] }) });
	world.scripts.push({ match: (c) => c.address === "adhoc/notes" && c.lastUserText.includes("Note this"), reply: () => ({ tools: [{ name: "report", args: { text: "Noted.", final: true } }] }) });
	await core.spawn({ type: "keeper", label: "memory keeper", task: "Remember the code word: XYZZY." });
	await core.spawn({ prompt: "You are NOTETAKER, a persistent ad-hoc agent.", lifetime: "persistent", id: "notes", label: "note keeper", task: "Note this: PLUGH." });
	await core.whenIdle();
	const roster = await core.status();
	assert.equal(roster.length, 2, "both persistent agents alive (no auto-retire)");
	assert.ok(roster.every((r) => r.state === "dormant"));
	await core.dispose();
});

await test("life 2: a fresh core reloads the roster; follow-ups run with prior history intact", async () => {
	const core = world.makeCore(layout, { maxConcurrent: 4 });
	const roster = await core.status();
	assert.deepEqual(roster.map((r) => r.address).sort(), ["adhoc/notes", "keeper/main"], "registry reloaded from disk");
	assert.deepEqual(roster.map((r) => r.label).sort(), ["memory keeper", "note keeper"], "display labels survive restart");

	world.scripts.push({ match: (c) => c.address === "keeper/main" && c.lastUserText.includes("What was the code word"), reply: () => ({ tools: [{ name: "report", args: { text: "It was XYZZY.", final: true } }] }) });
	world.scripts.push({ match: (c) => c.address === "adhoc/notes" && c.lastUserText.includes("What did you note"), reply: () => ({ tools: [{ name: "report", args: { text: "PLUGH.", final: true } }] }) });
	await core.send({ to: "keeper/main", text: "What was the code word?" });
	await core.send({ to: "adhoc/notes", text: "What did you note?" });
	await core.whenIdle();

	const keeperCall = world.llmCalls.findLast((c) => c.address === "keeper/main");
	assert.ok(keeperCall.messageCount > 2, "resumed session carries the life-1 conversation");
	assert.ok(keeperCall.historyText.includes("XYZZY"), "life-1 content visible to the resumed agent");

	const notesCall = world.llmCalls.findLast((c) => c.address === "adhoc/notes");
	assert.ok(notesCall.systemPrompt.includes("NOTETAKER"), "ad-hoc constitution reloaded from def.md");
	assert.ok(notesCall.messageCount > 2, "ad-hoc session resumed with history");
	await core.dispose();
});

await test("vitals survive the restart (tokens/turns from life 1 visible in life 2)", async () => {
	const core = world.makeCore(layout, { maxConcurrent: 4 });
	const keeper = (await core.status()).find((r) => r.address === "keeper/main");
	assert.ok(keeper.vitals.turns >= 2, "accumulated turns persisted");
	assert.ok(keeper.vitals.tokens > 0);
	await core.dispose();
});

await test("owner scope fingerprint survives resume and differs across main sessions", async () => {
	const first = world.makeCore(layout, { maxConcurrent: 1 });
	const firstScopeId = first.ownerScopeId;
	assert.match(firstScopeId, /^[a-f0-9]{24}$/);
	const statusResult = await createStatusTool(() => first).execute("scope-status", {});
	const statusPayload = JSON.parse(statusResult.content[0].text);
	assert.equal(statusPayload.ownerScopeId, firstScopeId, "no-address subagent_status exposes the scope fingerprint");
	await first.dispose();

	const resumed = world.makeCore(layout, { maxConcurrent: 1 });
	assert.equal(resumed.ownerScopeId, firstScopeId, "resume keeps the same opaque scope fingerprint");
	await resumed.dispose();

	const otherLayout = world.makeLayout("sess-7-other");
	const other = world.makeCore(otherLayout, { maxConcurrent: 1 });
	assert.notEqual(other.ownerScopeId, firstScopeId, "another owning main session has a different fingerprint");
	await other.dispose();
});

summary("Phase 7");
