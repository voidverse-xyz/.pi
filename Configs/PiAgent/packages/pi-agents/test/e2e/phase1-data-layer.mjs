/**
 * Phase-1 data-layer e2e for pi-agents: layout, registry, teams,
 * archive, typedefs, envelope. (Promoted from the scratchpad
 * smoke-pi-agents.ts, converted to the shared jiti harness.)
 *
 * Run: node phase1-data-layer.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { EXT, WORLDS, jiti } from "./env.mjs";

const { createLayout, cwdSlug, cwdDigest, sessionFileName } = await jiti.import(join(EXT, "store/layout.ts"));
const registry = await jiti.import(join(EXT, "store/registry.ts"));
const teams = await jiti.import(join(EXT, "store/teams.ts"));
const archive = await jiti.import(join(EXT, "store/archive.ts"));
const discover = await jiti.import(join(EXT, "typedefs/discover.ts"));
const { parseTypeFile } = await jiti.import(join(EXT, "typedefs/parse.ts"));
const envelope = await jiti.import(join(EXT, "mail/envelope.ts"));

const scratch = join(WORLDS, "phase1-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = "/home/user/fake-project"; // fake cwd — layout is pure path math

let passed = 0;
function ok(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------- layout
console.log("layout:");
ok("cwd slug matches Pi's encodeCwd", () => {
	assert.equal(cwdSlug("/home/user"), "--home-user--");
	assert.equal(cwdSlug("/home/user/fake-project"), "--home-user-fake-project--");
});
ok("session filename matches Pi's convention", () => {
	assert.equal(
		sessionFileName("2026-07-06T22:32:38.193Z", "019f398f-e031-71c5-99dd-a9c81af42b22"),
		"2026-07-06T22-32-38-193Z_019f398f-e031-71c5-99dd-a9c81af42b22.jsonl",
	);
});
const layout = createLayout(project, { home });
ok("all paths derive from the sessions dir", () => {
	const root = join(home, `.pi/agent/sessions/--home-user-fake-project--/subagents-${cwdDigest(project)}`);
	assert.equal(layout.subagentsRoot, root);
	assert.equal(layout.registryFile, join(root, "registry.json"));
	assert.equal(layout.teamsFile, join(root, "teams.json"));
	assert.equal(layout.mainMailboxDir, join(root, ".main/mailbox"));
	assert.equal(layout.mainMailboxDoneDir, join(root, ".main/mailbox/.done"));
	assert.equal(layout.mainAutoWakeLatchFile, join(root, ".main/auto-wake-blocked"));
	assert.equal(layout.agentInstanceDir("refactorer", "auth"), join(root, "refactorer/auth"));
	assert.equal(layout.mailboxDir("refactorer", "auth"), join(root, "refactorer/auth/mailbox"));
	assert.equal(layout.mailboxDoneDir("refactorer", "auth"), join(root, "refactorer/auth/mailbox/.done"));
	assert.equal(layout.filesDir("refactorer", "auth"), join(root, "refactorer/auth/files"));
	assert.equal(layout.archiveDir("refactorer", "auth"), join(root, ".archive/refactorer/auth"));
	assert.equal(
		layout.sessionFilePath("refactorer", "auth", "2026-07-09T10:00:00.000Z", "abc"),
		join(root, "refactorer/auth/2026-07-09T10-00-00-000Z_abc.jsonl"),
	);
	assert.equal(layout.envelopeFile(layout.mainMailboxDir, "msg_X"), join(root, ".main/mailbox/msg_X.json"));
	assert.equal(layout.globalTypeDefsDir, join(home, ".pi/agent/subagents"));
	assert.equal(layout.projectTypeDefsDir, join(project, ".pi/subagents"));
	// Phase 7 settings files (store/settings.ts source of truth)
	assert.equal(layout.globalSettingsFile, join(home, ".pi/agent/subagents.json"));
	assert.equal(layout.projectSettingsFile, join(project, ".pi/subagents.json"));
	// finding 6: the legacy (pre-digest) root is exposed for migration.
	assert.equal(layout.legacySubagentsRoot, join(home, ".pi/agent/sessions/--home-user-fake-project--/subagents"));
});

// finding 6 regression: slug-colliding cwds no longer share OUR state root, but
// still share Pi's own (slug) session dir; and existing legacy state migrates.
const { migrateStateRootIfNeeded } = await jiti.import(join(EXT, "core.ts"));
ok("cwd-slug collision no longer shares the subagents state root", () => {
	assert.equal(cwdSlug("/a-b/c"), cwdSlug("/a/b-c")); // the lossy slug still collides
	const home2 = join(scratch, "home-collide");
	const lA = createLayout("/a-b/c", { home: home2 });
	const lB = createLayout("/a/b-c", { home: home2 });
	assert.equal(lA.projectSessionDir, lB.projectSessionDir); // Pi's dir: unchanged, shared
	assert.notEqual(lA.subagentsRoot, lB.subagentsRoot); // OUR root: disambiguated
	assert.notEqual(cwdDigest("/a-b/c"), cwdDigest("/a/b-c"));
});
ok("existing legacy state migrates into the digest root (compat)", () => {
	const home2 = join(scratch, "home-migrate");
	const cwd = "/home/user/legacy-project";
	const lay = createLayout(cwd, { home: home2 });
	// Seed pre-digest state under the legacy dir; digest root absent.
	mkdirSync(lay.legacySubagentsRoot, { recursive: true });
	writeFileSync(join(lay.legacySubagentsRoot, "registry.json"), '{"agents":{}}\n');
	assert.ok(!existsSync(lay.subagentsRoot));
	migrateStateRootIfNeeded(lay);
	// Legacy adopted into the digest root; its files came along.
	assert.ok(!existsSync(lay.legacySubagentsRoot));
	assert.ok(existsSync(join(lay.subagentsRoot, "registry.json")));
	// Idempotent: a second call with an already-populated digest root is a no-op.
	mkdirSync(lay.legacySubagentsRoot, { recursive: true }); // a stray legacy dir reappears
	writeFileSync(join(lay.legacySubagentsRoot, "registry.json"), '{"stray":true}\n');
	migrateStateRootIfNeeded(lay);
	assert.equal(readFileSync(join(lay.subagentsRoot, "registry.json"), "utf8"), '{"agents":{}}\n');
});

// ---------------------------------------------------------------- registry
console.log("registry:");
ok("roundtrip + get-or-create + patch", () => {
	const first = registry.updateRegistry(layout.registryFile, (reg) =>
		registry.upsertAgent(reg, {
			type: "refactorer",
			id: "auth",
			lifetime: "persistent",
			purview: "auth subsystem",
			typeFileHash: "deadbeef",
		}),
	);
	assert.equal(first.created, true);
	const reloaded = registry.readRegistry(layout.registryFile);
	assert.equal(registry.listAgents(reloaded).length, 1);
	const rec = registry.getAgent(reloaded, "refactorer/auth");
	assert.equal(rec.state, "queued");
	assert.equal(rec.lifetime, "persistent");
	assert.deepEqual(rec.vitals, { contextPercent: 0, tokens: 0, cost: 0, turns: 0, compactions: 0 });
	// get-or-create: second spawn finds it
	const again = registry.upsertAgent(reloaded, {
		type: "refactorer", id: "auth", lifetime: "persistent", purview: "x", typeFileHash: "y",
	});
	assert.equal(again.created, false);
	assert.equal(again.record.purview, "auth subsystem");
	// patch state + vitals
	assert.equal(registry.patchAgent(reloaded, "refactorer/auth", { state: "running", vitals: { tokens: 1234 } }), true);
	registry.writeRegistry(layout.registryFile, reloaded);
	const rec2 = registry.getAgent(registry.readRegistry(layout.registryFile), "refactorer/auth");
	assert.equal(rec2.state, "running");
	assert.equal(rec2.vitals.tokens, 1234);
	assert.equal(rec2.vitals.turns, 0);
	assert.equal(registry.patchAgent(reloaded, "nobody/here", { state: "dormant" }), false);
	// remove
	assert.ok(registry.removeAgent(reloaded, "refactorer/auth"));
	assert.equal(registry.listAgents(reloaded).length, 0);
});
ok("persisted records are deeply validated before paths can use them", () => {
	const valid = registry.readRegistry(layout.registryFile);
	const original = valid.agents["refactorer/auth"];
	assert.ok(original);
	writeFileSync(layout.registryFile, JSON.stringify({ version: 1, agents: { "../../escape": original } }));
	assert.throws(() => registry.readRegistry(layout.registryFile), /Invalid agent record/);
	registry.writeRegistry(layout.registryFile, registry.emptyRegistry());
});
{
	const file = join(scratch, "registry-concurrent.json");
	const child = join(scratch, "registry-writer.mjs");
	const envUrl = new URL("./env.mjs", import.meta.url).href;
	writeFileSync(child, `
import { EXT, jiti } from ${JSON.stringify(envUrl)};
import { join } from "node:path";
const registry = await jiti.import(join(EXT, "store/registry.ts"));
const [file, prefix] = process.argv.slice(2);
for (let i = 0; i < 30; i++) registry.updateRegistry(file, reg => registry.upsertAgent(reg, {
  type: "worker", id: prefix + i, lifetime: "persistent", purview: prefix, typeFileHash: "hash"
}));
`);
	const run = (prefix) => new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [child, file, prefix], { stdio: "inherit" });
		proc.once("error", reject);
		proc.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`registry writer exited ${code}`)));
	});
	await Promise.all([run("a"), run("b")]);
	assert.equal(registry.listAgents(registry.readRegistry(file)).length, 60);
	passed++;
	console.log("  ok  concurrent registry writers preserve every update");
}

// ---------------------------------------------------------------- teams
console.log("teams:");
ok("add / shared / scrub with empty-team deletion", () => {
	teams.updateTeams(layout.teamsFile, (t) => {
		teams.addTo(t, "billing-refactor", "refactorer/auth");
		teams.addTo(t, "billing-refactor", "refactorer/api");
		teams.addTo(t, "billing-refactor", "refactorer/auth"); // idempotent
		teams.addTo(t, "docs", "docs-keeper/main");
		teams.addTo(t, "docs", "refactorer/auth");
	});
	const t = teams.readTeams(layout.teamsFile);
	assert.deepEqual(t["billing-refactor"], ["refactorer/auth", "refactorer/api"]);
	assert.equal(teams.sharedTeam(t, "refactorer/auth", "refactorer/api"), "billing-refactor");
	assert.equal(teams.sharedTeam(t, "refactorer/api", "docs-keeper/main"), null);
	assert.deepEqual(teams.teamsOf(t, "refactorer/auth").sort(), ["billing-refactor", "docs"]);
	// scrub refactorer/api → billing-refactor keeps one member
	assert.deepEqual(teams.scrubAddress(t, "refactorer/api"), ["billing-refactor"]);
	assert.deepEqual(t["billing-refactor"], ["refactorer/auth"]);
	// scrub refactorer/auth → billing-refactor emptied and deleted, docs keeps docs-keeper
	assert.deepEqual(teams.scrubAddress(t, "refactorer/auth").sort(), ["billing-refactor", "docs"]);
	assert.equal(t["billing-refactor"], undefined);
	assert.deepEqual(t["docs"], ["docs-keeper/main"]);
	// removeFrom deletes emptied team
	teams.removeFrom(t, "docs", "docs-keeper/main");
	assert.deepEqual(Object.keys(t), []);
});
// finding 11: team-name validation + prototype-safe, substring-proof membership.
ok("team names validated; reserved/malformed rejected", () => {
	assert.equal(teams.isValidTeamName("billing-refactor"), true);
	assert.equal(teams.isValidTeamName("a.b_c-1"), true);
	for (const bad of ["", "__proto__", "prototype", "constructor", ".hidden", "a/b", "a b", "-lead"]) {
		assert.equal(teams.isValidTeamName(bad), false, bad);
	}
	// addTo with a reserved name neither throws nor mutates (defense-in-depth).
	const t = {};
	teams.addTo(t, "__proto__", "refactorer/auth");
	assert.deepEqual(Object.keys(t), []);
	assert.equal(Object.getPrototypeOf(t), Object.prototype); // not polluted
});
ok("persisted teams.json is normalized: poison keys + non-array/invalid members dropped", () => {
	const tf = join(scratch, "teams-malformed.json");
	writeFileSync(
		tf,
		JSON.stringify({
			real: ["refactorer/auth", "refactorer/api", "refactorer/auth", "bogus address!"],
			spoof: "refactorer/authX", // a bare STRING, not an array — substring-attack vector
			__proto__: ["evil/x"],
		}),
	);
	const t = teams.readTeams(tf);
	// valid array kept, deduped, invalid element dropped
	assert.deepEqual(t.real, ["refactorer/auth", "refactorer/api"]);
	// string member dropped entirely (no substring authorization)
	assert.equal(t.spoof, undefined);
	assert.equal(teams.sharedTeam(t, "refactorer/auth", "refactorer/aut"), null); // no substring match
	assert.equal(teams.sharedTeam(t, "refactorer/auth", "refactorer/api"), "real"); // exact still works
	// null-prototype map — a persisted __proto__ key can't poison lookups
	assert.equal(Object.getPrototypeOf(t), null);
});

// ---------------------------------------------------------------- archive
console.log("archive:");
ok("retire-move is collision-safe; GC sweeps by age", () => {
	const mkAgent = () => {
		mkdirSync(layout.mailboxDir("oneshot-worker", "tmp-a1"), { recursive: true });
		writeFileSync(join(layout.agentInstanceDir("oneshot-worker", "tmp-a1"), "s.jsonl"), "{}\n");
	};
	mkAgent();
	const dir1 = archive.archiveAgentDir(layout, "oneshot-worker", "tmp-a1");
	assert.equal(dir1, layout.archiveDir("oneshot-worker", "tmp-a1"));
	assert.ok(!existsSync(layout.agentInstanceDir("oneshot-worker", "tmp-a1")));
	assert.ok(existsSync(join(dir1, "s.jsonl")));
	// second funeral for the same address → suffixed, first untouched
	mkAgent();
	const dir2 = archive.archiveAgentDir(layout, "oneshot-worker", "tmp-a1");
	assert.equal(dir2, `${dir1}-2`);
	// no such agent dir → null
	assert.equal(archive.archiveAgentDir(layout, "ghost", "none"), null);
	// GC: age dir1 by rewriting its marker 8 days back; dir2 stays fresh
	const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
	writeFileSync(join(dir1, ".retired-at"), `${old}\n`);
	const deleted = archive.gcArchive(layout, { days: 7 });
	assert.deepEqual(deleted, [dir1]);
	assert.ok(!existsSync(dir1) && existsSync(dir2));
	// nothing old left
	assert.deepEqual(archive.gcArchive(layout, { days: 7 }), []);
});

// ---------------------------------------------------------------- typedefs
console.log("typedefs parse:");
const VALID = `---
name: refactorer
description: Refactors code within a defined purview, incrementally and test-safe
model: anthropic/claude-opus-4-8
thinking: medium
projectContext: true
tools: [read, grep, find, ls, edit, write, bash]
readOnly: false
writePaths: ["src/auth/**", "tests/auth/**"]
denyPaths: ["migrations/**"]
maxTokensTotal: 500000
maxTurnMinutes: 15
maxContextCompactions: 3
---

You are a refactoring specialist. You own a specific purview of the codebase.
`;
ok("valid type file accepted with correct config + body", () => {
	const res = parseTypeFile(VALID, "refactorer");
	assert.equal(res.ok, true, JSON.stringify(res.errors));
	const { config, body } = res.def;
	assert.equal(config.name, "refactorer");
	assert.equal(config.thinking, "medium");
	assert.deepEqual(config.tools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
	assert.deepEqual(config.writePaths, ["src/auth/**", "tests/auth/**"]);
	assert.deepEqual(config.denyPaths, ["migrations/**"]);
	assert.equal(config.maxTokensTotal, 500000);
	assert.equal(config.projectContext, true);
	assert.equal(config.readOnly, false);
	assert.ok(body.startsWith("You are a refactoring specialist."));
});
ok("defaults applied when optional fields omitted", () => {
	const res = parseTypeFile("---\nname: minimal\ndescription: d\n---\nbody", "minimal");
	assert.equal(res.ok, true);
	const { config } = res.def;
	assert.deepEqual(
		{ projectContext: config.projectContext, readOnly: config.readOnly, denyPaths: config.denyPaths, model: config.model },
		{ projectContext: true, readOnly: false, denyPaths: [], model: undefined },
	);
});
ok("rejects name/filename mismatch", () => {
	const res = parseTypeFile(VALID, "other-name");
	assert.equal(res.ok, false);
	assert.match(res.errors.join("\n"), /must equal the filename stem "other-name"/);
});
ok("rejects unknown field", () => {
	const res = parseTypeFile("---\nname: t\ndescription: d\nlifetime: oneshot\n---\nx", "t");
	assert.equal(res.ok, false);
	assert.match(res.errors.join("\n"), /unknown field "lifetime"/);
});
ok("rejects bad tools type", () => {
	const res = parseTypeFile("---\nname: t\ndescription: d\ntools: bash\n---\nx", "t");
	assert.equal(res.ok, false);
	assert.match(res.errors.join("\n"), /"tools" must be an array of non-empty strings/);
});
ok("rejects fancy YAML (nested, block scalar, unmatched quote, missing close)", () => {
	for (const [fm, re] of [
		["---\nname: t\ndescription: d\ntools:\n  - read\n---\nx", /not supported|no value/],
		["---\nname: t\ndescription: |\n  multi\n---\nx", /block scalars/],
		["---\nname: t\ndescription: \"unterminated\n---\nx", /invalid or unterminated double-quoted scalar/],
		["---\nname: t\ndescription: \"foo\"bar\"\n---\nx", /invalid or unterminated double-quoted scalar/],
		["---\nname: t\ndescription: d\ntools: [read, \"write]\n---\nx", /unterminated quoted array item/],
		["---\nname: t\ndescription: d\nx", /not closed/],
	]) {
		const res = parseTypeFile(fm, "t");
		assert.equal(res.ok, false, fm);
		assert.match(res.errors.join("\n"), re);
	}
});
ok("quoted YAML subset decodes supported double/single quote escapes", () => {
	const quoted = VALID
		.replace("description: Refactors code within a defined purview, incrementally and test-safe", "description: \"say \\\"hi\\\"\"")
		.replace("tools: [read, grep, find, ls, edit, write, bash]", "tools: ['read', 'it''s-a-tool']");
	const res = parseTypeFile(quoted, "refactorer");
	assert.equal(res.ok, true, res.ok ? "" : res.errors.join("\n"));
	assert.equal(res.def.config.description, 'say "hi"');
	assert.deepEqual(res.def.config.tools, ["read", "it's-a-tool"]);
});

console.log("typedefs discover:");
ok("global/project merge, project wins, hash matches sha256", () => {
	mkdirSync(layout.globalTypeDefsDir, { recursive: true });
	const projTypes = join(scratch, "project/.pi/subagents");
	mkdirSync(projTypes, { recursive: true });
	const discLayout = createLayout(join(scratch, "project"), { home });
	writeFileSync(join(layout.globalTypeDefsDir, "researcher.md"), "---\nname: researcher\ndescription: global\n---\ng");
	writeFileSync(join(layout.globalTypeDefsDir, "refactorer.md"), "---\nname: refactorer\ndescription: global\n---\ng");
	writeFileSync(join(projTypes, "refactorer.md"), "---\nname: refactorer\ndescription: project\n---\np");
	const list = discover.listTypeDefs(discLayout);
	assert.deepEqual(list.map((d) => `${d.name}:${d.source}`), ["refactorer:project", "researcher:global"]);
	const resolved = discover.resolveTypeDef(discLayout, "refactorer");
	assert.equal(resolved.source, "project");
	assert.equal(resolved.hash, discover.sha256(readFileSync(join(projTypes, "refactorer.md"), "utf8")));
	assert.equal(discover.resolveTypeDef(discLayout, "researcher").source, "global");
	assert.equal(discover.resolveTypeDef(discLayout, "nope"), null);
});

// ---------------------------------------------------------------- envelope
console.log("envelope:");
ok("address parse/format incl. specials", () => {
	assert.deepEqual(envelope.parseAddress("refactorer/auth"), { kind: "agent", type: "refactorer", id: "auth" });
	assert.deepEqual(envelope.parseAddress("main"), { kind: "main" });
	assert.deepEqual(envelope.parseAddress("user"), { kind: "user" });
	for (const bad of ["", "a/b/c", "/x", "x/", ".hidden/x", "main/x", "a b/c"]) {
		assert.equal(envelope.parseAddress(bad), null, bad);
	}
	assert.equal(envelope.formatAddress({ kind: "agent", type: "refactorer", id: "auth" }), "refactorer/auth");
	assert.equal(envelope.formatAddress({ kind: "main" }), "main");
	assert.equal(envelope.formatAgentAddress("a", "b"), "a/b");
});
ok("makeEnvelope + validate roundtrip", () => {
	const env = envelope.makeEnvelope({
		from: "refactorer/auth", to: "refactorer/api", type: "question",
		text: "which schema?", team: "billing-refactor", hops: 2,
	});
	assert.match(env.id, /^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
	assert.equal(env.correlationId, null);
	assert.deepEqual(envelope.validateEnvelope(env), []);
	assert.deepEqual(envelope.validateEnvelope(JSON.parse(JSON.stringify(env))), []);
	// answer without correlationId → invalid; with → valid
	assert.throws(() => envelope.makeEnvelope({ from: "main", to: "refactorer/auth", type: "answer", text: "x" }));
	const ans = envelope.makeEnvelope({ from: "main", to: "refactorer/auth", type: "answer", text: "x", correlationId: env.id });
	assert.equal(ans.type, "answer");
	// bad shapes
	assert.ok(envelope.validateEnvelope(null).length > 0);
	assert.ok(envelope.validateEnvelope({ ...env, to: "not an address!" }).length > 0);
	assert.ok(envelope.validateEnvelope({ ...env, type: "broadcast" }).length > 0);
	assert.ok(envelope.validateEnvelope({ ...env, hops: -1 }).length > 0);
	assert.ok(envelope.validateEnvelope({ ...env, payload: {} }).length > 0);
	// data payload preserved
	const rep = envelope.makeEnvelope({ from: "refactorer/auth", to: "main", type: "report", text: "done", data: { files: 3 } });
	assert.deepEqual(rep.payload, { text: "done", data: { files: 3 } });
});
ok("ulid ordering: 2000 ids strictly increasing", () => {
	const ids = [];
	for (let i = 0; i < 2000; i++) ids.push(envelope.ulid());
	for (let i = 1; i < ids.length; i++) {
		assert.ok(ids[i] > ids[i - 1], `${ids[i - 1]} !< ${ids[i]}`);
	}
	// time ordering across ms
	const a = envelope.ulid(1000000000000);
	const b = envelope.ulid(1000000000001);
	assert.ok(a < b);
	assert.equal(a.length, 26);
});
ok("ulid is nondecreasing under a backward clock (regression guard)", () => {
	const forward = envelope.ulid(2000000000000);
	const back1 = envelope.ulid(1000000000000); // wall clock jumped BACKWARD
	const back2 = envelope.ulid(1000000000000); // still behind
	assert.ok(back1 > forward, `${forward} !< ${back1}`); // never moved backward
	assert.ok(back2 > back1);
});

console.log(`\nall ${passed} checks passed`);
