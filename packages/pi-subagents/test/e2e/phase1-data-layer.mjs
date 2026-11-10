/**
 * Phase-1 data layer e2e: layout paths (subagents naming), mailbox IO +
 * quarantine + at-least-once markers, registry repair, layered settings, and
 * the open-tasks anchor index. Pure fs — no LLM, no sessions.
 *
 * Run: node phase1-data-layer.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, WORLDS, jiti } from "./env.mjs";
import { test, summary } from "./harness.mjs";

const { createLayout, cwdSlug } = await jiti.import(join(EXT, "store/layout.ts"));
const { makeEnvelope, validateEnvelope, seedUlidClock, ulid } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { writeEnvelope, readPending, pendingCount, beginDelivery, markDone, maxEnvelopeId } = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { readRegistry, writeRegistry, emptyRegistry, upsertAgent } = await jiti.import(join(EXT, "store/registry.ts"));
const { archiveAgentDir, readArchived } = await jiti.import(join(EXT, "store/archive.ts"));
const { loadSettings, DEFAULT_SETTINGS } = await jiti.import(join(EXT, "store/settings.ts"));
const { readOpenTasks, recordOpenTask, closeOpenTask, closeAllFor } = await jiti.import(join(EXT, "store/open-tasks.ts"));

const scratch = join(WORLDS, "phase1-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(project, { recursive: true });

console.log("layout:");
await test("all mutable paths live under the session scope, named 'subagents'", () => {
	const layout = createLayout(project, { home, sessionId: "sess-1" });
	const root = join(home, ".pi", "agent", "sessions", cwdSlug(project), "subagents", "sess-1");
	assert.equal(layout.subagentsRoot, root);
	assert.equal(layout.registryFile, join(root, "registry.json"));
	assert.equal(layout.mainMailboxDir, join(root, ".main", "mailbox"));
	assert.equal(layout.openTasksFile, join(root, ".main", "open-tasks.json"));
	assert.equal(layout.agentInstanceDir("scout", "a"), join(root, "scout", "a"));
	assert.equal(layout.adhocDefFile("adhoc", "x"), join(root, "adhoc", "x", "def.md"));
	assert.equal(layout.globalTypeDefsDir, join(home, ".pi", "agent", "subagents"));
	assert.equal(layout.projectTypeDefsDir, join(project, ".pi", "subagents"));
	assert.equal(layout.globalSettingsFile, join(home, ".pi", "agent", "subagents.json"));
	assert.equal(layout.projectSettingsFile, join(project, ".pi", "subagents.json"));
});
await test("explicit Pi agent-directory override owns definitions and mutable state", () => {
	const agentDir = join(scratch, "override-agent");
	const overridden = createLayout(project, { sessionId: "sess-override", agentDir });
	assert.equal(overridden.agentDir, agentDir);
	assert.equal(overridden.globalTypeDefsDir, join(agentDir, "subagents"));
	assert.ok(overridden.subagentsRoot.startsWith(join(agentDir, "sessions")));
});
await test("bad session ids are rejected", () => {
	assert.throws(() => createLayout(project, { home, sessionId: "../evil" }));
	assert.throws(() => createLayout(project, { home, sessionId: "" }));
});

const layout = createLayout(project, { home, sessionId: "sess-1" });

console.log("envelope:");
await test("only message|report|error are valid types", () => {
	const good = makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "hi" });
	assert.deepEqual(validateEnvelope(good), []);
	assert.throws(() => makeEnvelope({ from: "scout/a", to: "main", type: "question", text: "?" }));
	assert.throws(() => makeEnvelope({ from: "scout/a", to: "main", type: "answer", text: "!" , correlationId: "msg_x" }));
});
await test("final is report-only", () => {
	assert.throws(() => makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "x", final: true }));
	const report = makeEnvelope({ from: "scout/a", to: "main", type: "report", text: "done", final: true });
	assert.equal(report.payload.final, true);
});
await test("terminalAnchors are valid only on final reports/errors", () => {
	const anchor = makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "task" }).id;
	const report = makeEnvelope({ from: "scout/a", to: "main", type: "report", text: "done", final: true, terminalAnchors: [anchor] });
	assert.deepEqual(report.payload.terminalAnchors, [anchor]);
	assert.throws(() => makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "x", terminalAnchors: [anchor] }));
	assert.throws(() => makeEnvelope({ from: "scout/a", to: "main", type: "report", text: "progress", terminalAnchors: [anchor] }));
});
await test("ulid clock never moves backward after seeding", () => {
	const a = ulid();
	seedUlidClock(`msg_${a}`);
	const b = ulid(0); // wall clock "in the past"
	assert.ok(b > a, "seeded clock keeps ids monotonic");
});

console.log("mailbox:");
const box = layout.mailboxDir("scout", "a");
await test("write → readPending round-trip in id order", () => {
	const e1 = makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "first" });
	const e2 = makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "second" });
	writeEnvelope(box, e1);
	writeEnvelope(box, e2);
	const pending = readPending(box);
	assert.equal(pending.length, 2);
	assert.deepEqual(pending.map((p) => p.envelope.payload.text), ["first", "second"]);
	assert.equal(pendingCount(box), 2);
	assert.equal(maxEnvelopeId(box), e2.id);
});
await test("attempt marker labels redelivery; markDone moves to .done", () => {
	const [first, second] = readPending(box);
	beginDelivery(box, first.envelope.id);
	const reread = readPending(box);
	assert.equal(reread.find((p) => p.envelope.id === first.envelope.id).redelivered, true);
	assert.equal(reread.find((p) => p.envelope.id === second.envelope.id).redelivered, false);
	markDone(box, first.envelope.id);
	markDone(box, second.envelope.id);
	assert.equal(pendingCount(box), 0);
	assert.ok(existsSync(join(box, ".done", `${first.envelope.id}.json`)));
});
await test("poison envelopes are quarantined to .corrupt", () => {
	writeFileSync(join(box, "msg_BROKEN.json"), "{ nope");
	const pending = readPending(box);
	assert.equal(pending.length, 0);
	assert.ok(existsSync(join(box, ".corrupt", "msg_BROKEN.json")));
});

console.log("registry:");
await test("corrupt vitals are repaired, broken identity dropped", () => {
	const registry = emptyRegistry();
	upsertAgent(registry, { type: "scout", id: "a", lifetime: "persistent", label: "source scout", typeFileHash: "h", now: new Date().toISOString() });
	upsertAgent(registry, { type: "scout", id: "a", lifetime: "persistent", label: "attempted rename", typeFileHash: "h2", now: new Date().toISOString() });
	upsertAgent(registry, { type: "scout", id: "legacy", lifetime: "persistent", typeFileHash: "h", now: new Date().toISOString() });
	writeRegistry(layout.registryFile, registry);
	const raw = JSON.parse(readFileSync(layout.registryFile, "utf8"));
	raw.agents["scout/a"].vitals = "garbage";
	raw.agents["scout/legacy"].label = 42;
	raw.agents["broken/x"] = { type: "broken" };
	writeFileSync(layout.registryFile, JSON.stringify(raw));
	const read = readRegistry(layout.registryFile);
	assert.ok(read.agents["scout/a"], "record with valid identity survives");
	assert.equal(read.agents["scout/a"].label, "source scout", "display label survives round-trip and repeated upsert cannot rename it");
	assert.equal(read.agents["scout/a"].vitals.state, "dormant", "vitals repaired to dormant defaults");
	assert.ok(read.agents["scout/legacy"], "pre-label record survives");
	assert.equal(read.agents["scout/legacy"].label, undefined, "invalid optional label is dropped without losing the record");
	assert.equal(read.agents["broken/x"], undefined, "unusable identity dropped");
});
await test("a pre-label archive marker remains readable without a display label", () => {
	mkdirSync(layout.agentInstanceDir("legacy", "tmp-old"), { recursive: true });
	archiveAgentDir(layout, "legacy", "tmp-old", new Date().toISOString());
	const archived = readArchived(layout).find((entry) => entry.address === "legacy/tmp-old");
	assert.ok(archived);
	assert.equal(archived.label, undefined);
});

console.log("settings:");
await test("defaults: maxConcurrent 4, archiveGcDays 7; layers merge; unknown keys warn", () => {
	assert.equal(DEFAULT_SETTINGS.maxConcurrent, 4);
	const none = loadSettings(layout.globalSettingsFile, layout.projectSettingsFile);
	assert.deepEqual(none.settings, DEFAULT_SETTINGS);
	writeFileSync(layout.globalSettingsFile, JSON.stringify({ maxConcurrent: 8, peers: "on" }));
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(layout.projectSettingsFile, JSON.stringify({ maxConcurrent: 2 }));
	const merged = loadSettings(layout.globalSettingsFile, layout.projectSettingsFile);
	assert.equal(merged.settings.maxConcurrent, 2, "project layer wins");
	assert.ok(merged.warnings.some((w) => w.includes("peers")), "foreign key warns");
	writeFileSync(layout.projectSettingsFile, "{ bad json");
	const degraded = loadSettings(layout.globalSettingsFile, layout.projectSettingsFile);
	assert.equal(degraded.settings.maxConcurrent, 8, "broken layer contributes nothing");
	assert.ok(degraded.warnings.some((w) => w.includes("invalid JSON")));
});

console.log("open-tasks:");
await test("record / close / closeAllFor round-trip", () => {
	const path = layout.openTasksFile;
	const a1 = makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "t1" }).id;
	const a2 = makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "t2" }).id;
	const b1 = makeEnvelope({ from: "main", to: "scout/b", type: "message", text: "t3" }).id;
	recordOpenTask(path, a1, { to: "scout/a", snippet: "t1", openedAt: new Date().toISOString() });
	recordOpenTask(path, a2, { to: "scout/a", snippet: "t2", openedAt: new Date().toISOString() });
	recordOpenTask(path, b1, { to: "scout/b", snippet: "t3", openedAt: new Date().toISOString() });
	assert.equal(Object.keys(readOpenTasks(path)).length, 3);
	closeOpenTask(path, a1);
	assert.equal(Object.keys(readOpenTasks(path)).length, 2);
	const closed = closeAllFor(path, "scout/a");
	assert.deepEqual(closed, [a2], "closeAllFor closes every anchor for that agent");
	assert.deepEqual(Object.keys(readOpenTasks(path)), [b1]);
});
await test("corrupt index is moved aside, not clobbered", () => {
	writeFileSync(layout.openTasksFile, "[1,2,3]");
	assert.deepEqual(readOpenTasks(layout.openTasksFile), {});
	assert.ok(!existsSync(layout.openTasksFile), "corrupt file moved aside");
	const snippetId = makeEnvelope({ from: "main", to: "scout/a", type: "message", text: "x".repeat(500) }).id;
	recordOpenTask(layout.openTasksFile, snippetId, { to: "scout/a", snippet: "y".repeat(500), openedAt: new Date().toISOString() });
	const entry = readOpenTasks(layout.openTasksFile)[snippetId];
	assert.ok(entry.snippet.length <= 120, "snippet bounded");
});

summary("Phase 1");
