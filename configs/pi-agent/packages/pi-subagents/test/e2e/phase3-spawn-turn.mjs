/**
 * Phase-3 spawn/turn e2e: typed + ad-hoc spawns through real agent turns with
 * the scripted mock LLM, final-report anchoring, oneshot auto-retire with a
 * kept transcript, the concurrency cap, spawn validation rules, and the
 * subagent toolset (report only — no spawn/peer tools).
 *
 * Run: node phase3-spawn-turn.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, test, summary, until } from "./harness.mjs";

const { readPending } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { readOpenTasks } = await jiti.import(join(EXT, "store/open-tasks.ts"));

const world = await makeWorld("phase3");
world.writeDef("scout", "You are SCOUT.");
const layout = world.makeLayout("sess-3");
const core = world.makeCore(layout, { maxConcurrent: 2 });
const mainMail = () => readPending(layout.mainMailboxDir).map((p) => p.envelope);

console.log("typed spawn:");
let scoutAnchor = null;
await test("spawn+task returns immediately with the anchor; final report correlates to it", async () => {
	world.scripts.push({ match: (c) => c.address === "scout/main" && c.lastUserText.includes("Map the repo"), reply: () => ({ tools: [{ name: "report", args: { text: "Mapped.", final: true } }] }) });
	const result = await core.spawn({ type: "scout", label: "repo mapper", task: "Map the repo layout." });
	assert.equal(result.address, "scout/main");
	assert.equal(result.label, "repo mapper");
	assert.equal(result.created, true);
	assert.ok(result.taskEnvelopeId, "anchor returned");
	scoutAnchor = result.taskEnvelopeId;
	assert.ok(readOpenTasks(layout.openTasksFile)[scoutAnchor], "open task recorded");
	await core.whenIdle();
	const report = mainMail().find((e) => e.type === "report" && e.from === "scout/main");
	assert.equal(report.payload.final, true);
	assert.equal(report.correlationId, scoutAnchor, "final report anchored to the task envelope");
});
await test("get-or-create: respawn wakes with memory and its established label intact", async () => {
	const again = await core.spawn({ type: "scout", label: "attempted rename" });
	assert.equal(again.created, false);
	assert.equal(again.label, "repo mapper", "a later required tool label does not silently rename the existing agent");
});
await test("identity block is hub-and-spoke (no peer prose)", async () => {
	const call = world.llmCalls.find((c) => c.address === "scout/main");
	assert.ok(call.systemPrompt.includes("Your ONLY channel is the `report` tool"));
	assert.ok(!call.systemPrompt.includes("peer"), "no peer wording");
	assert.ok(call.systemPrompt.includes("Surface blocking ambiguity EARLY"));
});
await test("live activity tracks starts, finishes, exact tool uses, human label, tokens, and context", async () => {
	const activityLayout = world.makeLayout("sess-3-activity");
	let releaseTools = () => {};
	const toolGate = new Promise((resolve) => { releaseTools = resolve; });
	const activityCore = world.makeCore(activityLayout, {
		maxConcurrent: 2,
		confirm: async () => {
			await toolGate;
			return true;
		},
	});
	world.scripts.push({
		match: (c) => c.address === "scout/activity" && c.lastUserText.includes("Exercise activity"),
		reply: () => ({
			thinking: "Preparing both writes before execution.",
			tools: [
				{ name: "write", args: { path: "activity-a.txt", content: "a" } },
				{ name: "write", args: { path: "activity-b.txt", content: "b" } },
			],
		}),
	});
	world.scripts.push({
		match: (c) => c.address === "scout/activity" && c.lastUserText.includes("Exercise activity"),
		reply: () => ({ delayMs: 250, thinking: "   ", text: "Activity exercised." }),
	});
	await activityCore.spawn({ type: "scout", id: "activity", label: "activity probe", task: "Exercise activity tracking." });
	const running = await until(() => {
		const candidate = activityCore.activitySnapshot().find((entry) => entry.address === "scout/activity");
		return candidate?.toolUses === 2 && candidate.tool === "write" && candidate.tokens > 0 && candidate.ctxPercent !== null
			? candidate
			: null;
	}, 2000);
	assert.ok(running, "both started tool calls counted while execution is waiting");
	assert.equal(running.label, "activity probe");

	releaseTools();
	const thinking = await until(() => {
		const candidate = activityCore.activitySnapshot().find((entry) => entry.address === "scout/activity");
		return candidate?.toolUses === 2 && candidate.tool === "" && candidate.summary === "Preparing both writes before execution. · thinking…"
			? candidate
			: null;
	}, 2000);
	assert.ok(thinking, "the latest visible thought returns after tools and survives a blank next thinking block");
	await activityCore.whenIdle();
	await activityCore.dispose();
});

console.log("ad-hoc spawn:");
await test("oneshot ad-hoc: def.md written, turn runs with the prompt, auto-retires, transcript archived", async () => {
	world.scripts.push({ match: (c) => c.address.startsWith("adhoc/") && c.lastUserText.includes("Count the beans"), reply: () => ({ tools: [{ name: "report", args: { text: "42 beans.", final: true } }] }) });
	const result = await core.spawn({ prompt: "You are BEANCOUNTER. Count precisely.", label: "bean counter", task: "Count the beans." });
	assert.ok(result.address.startsWith("adhoc/tmp-"), "auto-named oneshot");
	assert.equal(result.label, "bean counter");
	const [type, id] = result.address.split("/");
	assert.ok(existsSync(layout.adhocDefFile(type, id)), "def.md persisted before the turn");
	assert.ok(readFileSync(layout.adhocDefFile(type, id), "utf8").includes("BEANCOUNTER"));
	await core.whenIdle();
	// Auto-retired: gone from the roster, transcript kept under .archive.
	const roster = await core.status();
	assert.ok(!roster.some((r) => r.address === result.address), "oneshot auto-retired after final report");
	const archived = core.archived();
	assert.ok(archived.some((a) => a.address === result.address && a.label === "bean counter"), "archived post-mortem keeps the display label");
	const archiveDir = join(layout.archiveRoot, type);
	const dirs = readdirSync(archiveDir);
	const jsonls = readdirSync(join(archiveDir, dirs[0])).filter((f) => f.endsWith(".jsonl"));
	assert.ok(jsonls.length > 0, "transcript JSONL kept in the archive");
	const call = world.llmCalls.find((c) => c.address === result.address);
	assert.ok(call.systemPrompt.includes("BEANCOUNTER"), "ad-hoc prompt reached the system prompt");
	assert.ok(call.systemPrompt.includes("ONESHOT"), "oneshot convention stated");
});
await test("persistent ad-hoc requires an explicit id; oneshot must not pass one", async () => {
	await assert.rejects(() => core.spawn({ prompt: "P", lifetime: "persistent" }), /explicit id/);
	await assert.rejects(() => core.spawn({ type: "scout", lifetime: "oneshot", id: "x" }), /must not pass an id/);
});
await test("spawn validation: exactly one of type/prompt; model/thinking/tools ad-hoc-only; unknown tools eager", async () => {
	await assert.rejects(() => core.spawn({}), /exactly one/);
	await assert.rejects(() => core.spawn({ type: "scout", prompt: "P" }), /exactly one/);
	await assert.rejects(() => core.spawn({ type: "scout", model: "mock/mock-1" }), /ad-hoc-only/);
	await assert.rejects(() => core.spawn({ prompt: "P", tools: ["read", "teleport"] }), /unknown tools/);
	await assert.rejects(() => core.spawn({ prompt: "P", label: "   " }), /must not be empty/);
	await assert.rejects(() => core.spawn({ prompt: "P", label: "x".repeat(81) }), /at most 80/);
	await assert.rejects(() => core.spawn({ type: "nope" }), /Unknown subagent type/);
});

console.log("concurrency cap:");
await test("cap 2: three parallel tasks → one queued while two run; all finish", async () => {
	for (const id of ["s1", "s2", "s3"]) {
		world.scripts.push({ match: (c) => c.address === `scout/${id}` && c.lastUserText.includes("Slow task"), reply: () => ({ delayMs: 250, text: "done slow" }) });
	}
	await core.spawn({ type: "scout", id: "s1", task: "Slow task." });
	await core.spawn({ type: "scout", id: "s2", task: "Slow task." });
	await core.spawn({ type: "scout", id: "s3", task: "Slow task." });
	const sawQueue = await until(async () => {
		const roster = await core.status();
		const running = roster.filter((r) => r.state === "running").length;
		const queued = roster.filter((r) => r.state === "queued").length;
		return running === 2 && queued >= 1;
	}, 2000);
	assert.ok(sawQueue, "observed 2 running + 1 queued under cap 2");
	await core.whenIdle();
	const roster = await core.status();
	assert.ok(["s1", "s2", "s3"].every((id) => roster.find((r) => r.address === `scout/${id}`).state === "dormant"), "all drained");
});

console.log("catalog:");
await test("availableTypes lists library defs, never adhoc", () => {
	const types = core.availableTypes();
	assert.ok(types.some((t) => t.name === "scout"));
	assert.ok(!types.some((t) => t.name === "adhoc"));
});

await core.dispose();
summary("Phase 3");
