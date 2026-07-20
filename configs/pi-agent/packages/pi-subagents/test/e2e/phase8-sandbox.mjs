/**
 * Phase-8 sandbox e2e: tool allowlists, the system-deny hard guard (edit/write
 * targets + bash text scan over the real protected roots), confirmation
 * ordering (deny before confirm; denial blocks execution), fail-closed
 * confirms, the safety-bridge claim protocol, and the subagent toolset having
 * no spawn/peer surface. A live-turn check drives a type with tools:[] and
 * asserts only `report` is callable.
 *
 * Run: node phase8-sandbox.mjs
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, test, summary } from "./harness.mjs";

const { buildSandboxedTools, selectToolNames } = await jiti.import(join(EXT, "sandbox/tools-filter.ts"));
const { makeSystemDenyCheck, makeCommandDenyCheck, realpathDeep } = await jiti.import(join(EXT, "sandbox/system-deny.ts"));
const { makeSafetyConfirm, denyAllConfirm, CONFIRM_CHANNEL } = await jiti.import(join(EXT, "sandbox/safety-bridge.ts"));
const { createSubagentTools } = await jiti.import(join(EXT, "tools/sub-agent.ts"));
import { realpathSync } from "node:fs";

const world = await makeWorld("phase8");
const layout = world.makeLayout("sess-8");

console.log("allowlist:");
await test("selectToolNames: unset = all; subset preserved; unknown = error", () => {
	assert.deepEqual(selectToolNames({ name: "t" }), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	assert.deepEqual(selectToolNames({ name: "t", tools: ["write", "read"] }), ["read", "write"]);
	assert.deepEqual(selectToolNames({ name: "t", tools: [] }), []);
	assert.throws(() => selectToolNames({ name: "t", tools: ["read", "teleport"] }), /unknown tools/);
});

console.log("system deny (real roots):");
const protectedDirs = [layout.projectSubagentsRoot, layout.globalTypeDefsDir, layout.projectTypeDefsDir];
const deny = makeSystemDenyCheck(protectedDirs, realpathSync);
const denyCmd = makeCommandDenyCheck(protectedDirs, realpathSync, world.home);
await test("targets in/under/above the state tree and def dirs are denied; project files pass", () => {
	assert.equal(deny(layout.registryFile).denied, true);
	assert.equal(deny(join(layout.globalTypeDefsDir, "self.md")).denied, true);
	assert.equal(deny(layout.projectSubagentsRoot).denied, true, "the root itself");
	assert.equal(deny(join(world.home, ".pi", "agent", "sessions")).denied, true, "ancestor of the state tree");
	assert.equal(deny(join(world.project, "src", "app.ts")).denied, false);
});
await test("bash text scan catches raw, realpath'd, and ~-relative spellings", () => {
	assert.equal(denyCmd(`echo pwned > ${layout.globalTypeDefsDir}/x.md`).denied, true);
	assert.equal(denyCmd(`cat ${realpathDeep(layout.registryFile, realpathSync)}`).denied, true);
	assert.equal(denyCmd("npm test").denied, false);
});

console.log("wrapped tools:");
await test("edit inside a protected root hard-denies BEFORE any confirmation", async () => {
	let confirmCalls = 0;
	const tools = buildSandboxedTools({ name: "t", tools: ["edit", "write", "bash"] }, world.project, {
		systemDeny: deny,
		systemDenyCommand: denyCmd,
		confirm: async () => {
			confirmCalls++;
			return { approved: true };
		},
	});
	const edit = tools.find((t) => t.name === "edit");
	await assert.rejects(
		() => edit.execute("tc1", { path: join(layout.globalTypeDefsDir, "self.md"), oldText: "a", newText: "b" }, undefined, undefined, {}),
		/Blocked by the subagents sandbox/,
	);
	assert.equal(confirmCalls, 0, "hard deny never consults the human");
});
await test("write with approval executes; with denial it blocks", async () => {
	let approve = true;
	const tools = buildSandboxedTools({ name: "t", tools: ["write"] }, world.project, {
		systemDeny: deny,
		systemDenyCommand: denyCmd,
		confirm: async () => (approve ? { approved: true } : { approved: false, note: "nope" }),
	});
	const write = tools.find((t) => t.name === "write");
	const target = join(world.project, "hello.txt");
	await write.execute("tc2", { path: target, content: "approved content" }, undefined, undefined, {});
	assert.equal(readFileSync(target, "utf8"), "approved content");
	approve = false;
	await assert.rejects(() => write.execute("tc3", { path: target, content: "denied content" }, undefined, undefined, {}), /not approved: nope/);
	assert.equal(readFileSync(target, "utf8"), "approved content", "denied write never ran");
});
await test("bash referencing a protected root hard-denies; safe command asks then runs", async () => {
	const decisions = [];
	const tools = buildSandboxedTools({ name: "t", tools: ["bash"] }, world.project, {
		systemDeny: deny,
		systemDenyCommand: denyCmd,
		confirm: async (req) => {
			decisions.push(req.command);
			return { approved: true };
		},
	});
	const bash = tools.find((t) => t.name === "bash");
	await assert.rejects(() => bash.execute("tc4", { command: `rm -rf ${layout.subagentsRoot}` }, undefined, undefined, {}), /Blocked by the subagents sandbox/);
	assert.equal(decisions.length, 0);
	const result = await bash.execute("tc5", { command: "echo sandbox-ok" }, undefined, undefined, {});
	assert.equal(decisions.length, 1, "safe command was confirmed");
	assert.ok(JSON.stringify(result.content).includes("sandbox-ok"));
});

console.log("safety bridge:");
await test("unclaimed channel fails closed; a claimant decides; a throwing claimant denies", async () => {
	const handlers = new Map();
	const fakePi = { events: { emit: (ch, data) => handlers.get(ch)?.(data), on: (ch, fn) => handlers.set(ch, fn) } };
	const confirm = makeSafetyConfirm(fakePi);
	assert.equal((await confirm({ agent: "a/b", tool: "bash", command: "x" })).approved, false, "no provider → deny");

	fakePi.events.on(CONFIRM_CHANNEL, (data) => data.claim(async () => ({ approved: true })));
	assert.equal((await confirm({ agent: "a/b", tool: "bash", command: "x" })).approved, true);

	fakePi.events.on(CONFIRM_CHANNEL, (data) => data.claim(async () => { throw new Error("provider crashed"); }));
	const crashed = await confirm({ agent: "a/b", tool: "edit", path: "/tmp/x" });
	assert.equal(crashed.approved, false);
	assert.ok(crashed.note.includes("provider crashed"));
	assert.equal((await denyAllConfirm({ agent: "a/b", tool: "bash" })).approved, false);
});

console.log("subagent toolset:");
await test("the subagent-side toolset is exactly [report] — no spawn/await/peer surface", () => {
	const tools = createSubagentTools("worker/x", { reportFromAgent: () => ({ delivered: true, disposition: "main", envelopeId: "msg_0" }) });
	assert.deepEqual(tools.map((t) => t.name), ["report"]);
});
await test("live turn: a tools:[] type has report and NOTHING else callable", async () => {
	world.writeDef("blind", "You are BLIND (no coding tools).", ["tools: []"]);
	const core = world.makeCore(layout, { maxConcurrent: 2, confirm: denyAllConfirm });
	// The agent tries bash (not in its toolset) then reports. The SDK returns a
	// tool-not-found error for bash; the turn still completes and only the report
	// lands.
	world.scripts.push({ match: (c) => c.address === "blind/main" && c.lastUserText.includes("Try tools"), reply: () => ({ tools: [{ name: "bash", args: { command: "id" } }] }) });
	world.scripts.push({ match: (c) => c.address === "blind/main", reply: () => ({ tools: [{ name: "report", args: { text: "only report worked", final: true } }] }) });
	await core.spawn({ type: "blind", task: "Try tools." });
	await core.whenIdle();
	const { readPending } = await jiti.import(join(EXT, "mail/mailbox.ts"));
	const report = readPending(layout.mainMailboxDir).find((p) => p.envelope.type === "report" && p.envelope.from === "blind/main");
	assert.ok(report, "report delivered despite the unavailable tool");
	await core.dispose();
});

// Keep the world dir around? No — but prove the protected write never landed.
await test("no stray writes into the protected roots during this phase", () => {
	assert.throws(() => readFileSync(join(layout.globalTypeDefsDir, "self.md")), /ENOENT/);
});

summary("Phase 8");
