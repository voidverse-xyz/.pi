/**
 * Phase-1 data-layer e2e for pi-teams: layout, envelope, settings, registry,
 * host-lease, typedefs (parse + discover).
 *
 * Run: node phase1-data-layer.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, WORLDS, jiti } from "./env.mjs";

const { createLayout, cwdSlug } = await jiti.import(join(EXT, "store/layout.ts"));
const envelope = await jiti.import(join(EXT, "mail/envelope.ts"));
const settings = await jiti.import(join(EXT, "store/settings.ts"));
const registry = await jiti.import(join(EXT, "store/registry.ts"));
const hostLease = await jiti.import(join(EXT, "store/host-lease.ts"));
const { parseTypeFile } = await jiti.import(join(EXT, "typedefs/parse.ts"));
const discover = await jiti.import(join(EXT, "typedefs/discover.ts"));

const scratch = join(WORLDS, "phase1-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = "/home/user/fake-project";

let passed = 0;
function ok(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ----------------------------------------------------------------- layout
console.log("layout:");
ok("cwd slug matches Pi's encodeCwd", () => {
	assert.equal(cwdSlug("/home/user"), "--home-user--");
	assert.equal(cwdSlug("/home/user/fake-project"), "--home-user-fake-project--");
});
const layout = createLayout(project, { home, sessionId: "sess-A" });
ok("flat layout: teams/<sessionId>, no digest/owners nesting", () => {
	const root = join(home, ".pi/agent/sessions/--home-user-fake-project--/teams/sess-A");
	assert.equal(layout.subagentsRoot, root);
	assert.equal(layout.registryFile, join(root, "registry.json"));
	assert.equal(layout.mainMailboxDir, join(root, ".main/mailbox"));
	assert.equal(layout.agentInstanceDir("refactorer", "auth"), join(root, "refactorer/auth"));
	assert.ok(!layout.subagentsRoot.includes("owners"));
	assert.ok(!layout.subagentsRoot.includes("subagents-by-main-session"));
});
ok("distinct sessions never collide", () => {
	const b = createLayout(project, { home, sessionId: "sess-B" });
	assert.notEqual(layout.subagentsRoot, b.subagentsRoot);
});
ok("explicit Pi agent-directory override owns shared definitions and Teams state", () => {
	const agentDir = join(scratch, "override-agent");
	const overridden = createLayout(project, { sessionId: "sess-override", agentDir });
	assert.equal(overridden.agentDir, agentDir);
	assert.equal(overridden.globalTypeDefsDir, join(agentDir, "subagents"));
	assert.equal(overridden.projectTypeDefsDir, join(project, ".pi", "subagents"));
	assert.equal(overridden.globalSettingsFile, join(agentDir, "teams.json"));
	assert.equal(overridden.projectSettingsFile, join(project, ".pi", "teams.json"));
	assert.ok(overridden.subagentsRoot.startsWith(join(agentDir, "sessions")));
});
ok("invalid session id rejected", () => {
	assert.throws(() => createLayout(project, { home, sessionId: ".." }));
	assert.throws(() => createLayout(project, { home, sessionId: "a/b" }));
});

// --------------------------------------------------------------- envelope
console.log("envelope:");
ok("makeEnvelope stamps id + sentAt, validates", () => {
	const e = envelope.makeEnvelope({ from: "main", to: "refactorer/auth", type: "message", text: "hi" });
	assert.match(e.id, /^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
	assert.equal(e.correlationId, null);
	assert.equal(e.hops, 0);
	assert.equal(e.payload.text, "hi");
	assert.equal(envelope.validateEnvelope(e).length, 0);
});
ok("no team field on envelope (D12)", () => {
	const e = envelope.makeEnvelope({ from: "main", to: "a/b", type: "message", text: "x" });
	assert.ok(!("team" in e));
});
ok("ulid is monotonic within a process", () => {
	let prev = "";
	for (let i = 0; i < 1000; i++) {
		const u = envelope.ulid();
		assert.ok(u > prev, `ulid regressed: ${u} <= ${prev}`);
		prev = u;
	}
});
ok("ulid never regresses on backward clock", () => {
	const a = envelope.ulid(1_000_000);
	const b = envelope.ulid(999_000); // clock went backward
	assert.ok(b > a);
});
ok("answer requires correlationId; final only on report", () => {
	assert.throws(() => envelope.makeEnvelope({ from: "main", to: "a/b", type: "answer", text: "x" }));
	assert.throws(() => envelope.makeEnvelope({ from: "a/b", to: "main", type: "message", text: "x", final: true }));
	const r = envelope.makeEnvelope({ from: "a/b", to: "main", type: "report", text: "done", final: true });
	assert.equal(r.payload.final, true);
});
ok("parseAddress handles agent + specials", () => {
	assert.deepEqual(envelope.parseAddress("refactorer/auth"), { kind: "agent", type: "refactorer", id: "auth" });
	assert.deepEqual(envelope.parseAddress("main"), { kind: "main" });
	assert.equal(envelope.parseAddress("a/b/c"), null);
	assert.equal(envelope.parseAddress(".hidden/x"), null);
});

// --------------------------------------------------------------- settings
console.log("settings:");
const settingsDir = join(scratch, "settings");
mkdirSync(settingsDir, { recursive: true });
const globalSettings = join(settingsDir, "teams.json");
const projectSettings = join(settingsDir, "project-teams.json");
ok("defaults when no files", () => {
	assert.deepEqual(settings.loadSettings(globalSettings, projectSettings).settings, settings.DEFAULT_SETTINGS);
});
ok("project overrides global field-by-field", () => {
	writeFileSync(globalSettings, JSON.stringify({ maxConcurrent: 8, maxHops: 4 }));
	writeFileSync(projectSettings, JSON.stringify({ maxHops: 12 }));
	const { settings: s } = settings.loadSettings(globalSettings, projectSettings);
	assert.equal(s.maxConcurrent, 8);
	assert.equal(s.maxHops, 12);
	assert.equal(s.archiveGcDays, 7);
});
ok("a broken layer degrades to defaults for that layer with a warning; the other layer still applies", () => {
	writeFileSync(globalSettings, "{ not json");
	const { settings: s, warnings } = settings.loadSettings(globalSettings, projectSettings);
	assert.equal(s.maxConcurrent, settings.DEFAULT_SETTINGS.maxConcurrent, "broken global layer contributes nothing");
	assert.equal(s.maxHops, 12, "the valid project layer still applies");
	assert.ok(warnings.some((w) => w.includes("invalid JSON")));
});
ok("invalid field values are ignored with a warning", () => {
	writeFileSync(globalSettings, JSON.stringify({ maxConcurrent: -1, bogus: 1 }));
	writeFileSync(projectSettings, JSON.stringify({}));
	const { settings: s, warnings } = settings.loadSettings(globalSettings, projectSettings);
	assert.equal(s.maxConcurrent, settings.DEFAULT_SETTINGS.maxConcurrent);
	assert.ok(warnings.some((w) => w.includes("maxConcurrent")));
	assert.ok(warnings.some((w) => w.includes("unknown key")));
});

// --------------------------------------------------------------- registry
console.log("registry:");
const regFile = join(scratch, "registry.json");
ok("upsert = get-or-create", () => {
	const reg = registry.emptyRegistry();
	const first = registry.upsertAgent(reg, { type: "refactorer", id: "auth", lifetime: "persistent", typeFileHash: "h1", now: "t1" });
	assert.equal(first.created, true);
	const again = registry.upsertAgent(reg, { type: "refactorer", id: "auth", lifetime: "persistent", typeFileHash: "h2", now: "t2" });
	assert.equal(again.created, false);
	assert.equal(again.record.generationId, first.record.generationId, "same instance keeps generation");
	assert.equal(again.record.typeFileHash, "h2", "type hash refreshed (live-resolve)");
});
ok("atomic write + read round-trip; malformed dropped", () => {
	const reg = registry.emptyRegistry();
	registry.upsertAgent(reg, { type: "docs", id: "main", lifetime: "persistent", typeFileHash: "h", now: "t" });
	registry.writeRegistry(regFile, reg);
	const back = registry.readRegistry(regFile);
	assert.ok(registry.getAgent(back, "docs/main"));
	// corrupt the file with a bad record + a good one
	writeFileSync(regFile, JSON.stringify({ version: 1, agents: { "x/y": { bogus: true }, "docs/main": registry.getAgent(reg, "docs/main") } }));
	const repaired = registry.readRegistry(regFile);
	assert.equal(registry.getAgent(repaired, "x/y"), undefined);
	assert.ok(registry.getAgent(repaired, "docs/main"));
});
ok("generation ids are gen_<32hex>", () => {
	assert.match(registry.newGenerationId(), /^gen_[0-9a-f]{32}$/);
});

// -------------------------------------------------------------- host-lease
console.log("host-lease:");
const leaseLayout = createLayout(project, { home: join(scratch, "lease-home"), sessionId: "sess-lease" });
ok("claim writes marker + scope manifest, release removes marker", () => {
	const lease = hostLease.claimHostScope(leaseLayout);
	assert.ok(existsSync(leaseLayout.hostOwnerFile), "claim publishes the owner marker");
	const manifest = JSON.parse(readFileSync(leaseLayout.scopeManifestFile, "utf8"));
	assert.equal(manifest.ownerSessionId, "sess-lease");
	lease.release();
	assert.ok(!existsSync(leaseLayout.hostOwnerFile), "release removes the owner marker");
});
ok("a live foreign owner blocks the claim", () => {
	// forge a live marker owned by "someone else" (this very pid is alive)
	const start = readFileSync("/proc/self/stat", "utf8");
	const rparen = start.lastIndexOf(")");
	const startTime = Number.parseInt(start.slice(rparen + 2).split(" ")[19], 10);
	mkdirSync(leaseLayout.subagentsRoot, { recursive: true });
	writeFileSync(leaseLayout.hostOwnerFile, JSON.stringify({ runtimeId: "foreign", pid: process.pid, startTime, updatedAt: Date.now() }));
	assert.throws(() => hostLease.claimHostScope(leaseLayout), (e) => e.name === "HostScopeLockedError");
});
ok("a dead owner's stale marker is swept", () => {
	writeFileSync(leaseLayout.hostOwnerFile, JSON.stringify({ runtimeId: "dead", pid: 2_000_000_000, startTime: null, updatedAt: 0 }));
	const lease = hostLease.claimHostScope(leaseLayout);
	assert.notEqual(JSON.parse(readFileSync(leaseLayout.hostOwnerFile, "utf8")).runtimeId, "dead", "stale marker replaced by ours");
	lease.release();
});
ok("a live fence-less owner is NOT swept on heartbeat staleness alone", () => {
	// Non-Linux shape: startTime null. The pid is alive (ours) but the heartbeat is
	// ancient — sweeping here would steal the scope from a busy-but-alive owner.
	writeFileSync(leaseLayout.hostOwnerFile, JSON.stringify({ runtimeId: "foreign", pid: process.pid, startTime: null, updatedAt: 0 }));
	assert.throws(() => hostLease.claimHostScope(leaseLayout), (e) => e.name === "HostScopeLockedError");
	rmSync(leaseLayout.hostOwnerFile, { force: true });
});

// ---------------------------------------------------------------- typedefs
console.log("typedefs/parse:");
ok("valid type file parses to slim config + body", () => {
	const src = `---\nname: refactorer\ndescription: Refactors code safely\nmodel: anthropic/claude-opus-4-8\nthinking: medium\nprojectContext: false\ntools: [read, grep, edit]\n---\nYou are a refactoring specialist.\n`;
	const r = parseTypeFile(src, "refactorer");
	assert.ok(r.ok, r.ok ? "" : r.errors?.join("; "));
	assert.equal(r.definition.config.name, "refactorer");
	assert.equal(r.definition.config.projectContext, false);
	assert.deepEqual(r.definition.config.tools, ["read", "grep", "edit"]);
	assert.equal(r.definition.body, "You are a refactoring specialist.");
});
ok("projectContext defaults true when omitted", () => {
	const r = parseTypeFile(`---\nname: t\ndescription: d\n---\nbody`, "t");
	assert.ok(r.ok);
	assert.equal(r.definition.config.projectContext, true);
});
ok("unknown field rejected (D19)", () => {
	const r = parseTypeFile(`---\nname: t\ndescription: d\nwritePaths: ["x"]\n---\nb`, "t");
	assert.ok(!r.ok);
	assert.ok(r.errors.some((e) => e.includes("writePaths")));
});
ok("name must equal filename stem", () => {
	const r = parseTypeFile(`---\nname: other\ndescription: d\n---\nb`, "t");
	assert.ok(!r.ok);
});
ok("bad thinking level rejected; missing frontmatter rejected", () => {
	assert.ok(!parseTypeFile(`---\nname: t\ndescription: d\nthinking: ultra\n---\nb`, "t").ok);
	assert.ok(!parseTypeFile(`no frontmatter here`, "t").ok);
});
ok("nested/indented yaml rejected", () => {
	const r = parseTypeFile(`---\nname: t\ndescription: d\n  nested: x\n---\nb`, "t");
	assert.ok(!r.ok);
});

console.log("typedefs/discover:");
const discHome = join(scratch, "disc-home");
const discProject = join(scratch, "disc-project");
const discLayout = createLayout(discProject, { home: discHome, sessionId: "sess-disc" });
mkdirSync(discLayout.globalTypeDefsDir, { recursive: true });
mkdirSync(discLayout.projectTypeDefsDir, { recursive: true });
writeFileSync(join(discLayout.globalTypeDefsDir, "researcher.md"), `---\nname: researcher\ndescription: g\n---\nglobal body`);
writeFileSync(join(discLayout.globalTypeDefsDir, "refactorer.md"), `---\nname: refactorer\ndescription: g\n---\nglobal`);
writeFileSync(join(discLayout.projectTypeDefsDir, "refactorer.md"), `---\nname: refactorer\ndescription: p\n---\nproject`);
const legacyGlobalTypeDefsDir = join(discHome, ".pi", "agent", "teams");
const legacyProjectTypeDefsDir = join(discProject, ".pi", "teams");
mkdirSync(legacyGlobalTypeDefsDir, { recursive: true });
mkdirSync(legacyProjectTypeDefsDir, { recursive: true });
writeFileSync(join(legacyGlobalTypeDefsDir, "legacy-global.md"), `---\nname: legacy-global\ndescription: old\n---\nold`);
writeFileSync(join(legacyProjectTypeDefsDir, "legacy-project.md"), `---\nname: legacy-project\ndescription: old\n---\nold`);
ok("project shadows global when trusted", () => {
	const list = discover.listTypeDefs(discLayout, { projectTrusted: true });
	const ref = list.find((s) => s.name === "refactorer");
	assert.equal(ref.origin, "project");
	assert.ok(ref.shadowsGlobal);
	const resolved = discover.resolveTypeDef(discLayout, "refactorer", { projectTrusted: true });
	assert.ok(resolved.ok);
	assert.equal(resolved.resolved.definition.config.description, "p");
});
ok("untrusted project defs are ignored (finding #7)", () => {
	const list = discover.listTypeDefs(discLayout, { projectTrusted: false });
	const ref = list.find((s) => s.name === "refactorer");
	assert.equal(ref.origin, "global");
	const resolved = discover.resolveTypeDef(discLayout, "refactorer", { projectTrusted: false });
	assert.equal(resolved.resolved.definition.config.description, "g");
});
ok("legacy teams definition directories are ignored", () => {
	const names = discover.listTypeDefs(discLayout, { projectTrusted: true }).map((source) => source.name);
	assert.ok(!names.includes("legacy-global"));
	assert.ok(!names.includes("legacy-project"));
});
ok("symlinked type files are ignored", () => {
	symlinkSync(join(discLayout.globalTypeDefsDir, "researcher.md"), join(discLayout.globalTypeDefsDir, "linked.md"));
	const list = discover.listTypeDefs(discLayout, {});
	assert.ok(!list.some((s) => s.name === "linked"));
});
ok("resolve records a content hash", () => {
	const resolved = discover.resolveTypeDef(discLayout, "researcher", {});
	assert.ok(resolved.ok);
	assert.match(resolved.resolved.hash, /^[0-9a-f]{64}$/);
});

console.log(`\nPhase 1: ${passed} checks passed.`);
