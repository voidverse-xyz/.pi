/**
 * Phase-2 typedefs e2e: tolerant parsing (a copied pi-teams def with foreign
 * keys parses with warnings), hard errors on malformed known fields, the
 * reserved "adhoc" name, ad-hoc def synthesis, and trust-gated project
 * discovery with shadowing.
 *
 * Run: node phase2-typedefs.mjs
 */
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, WORLDS, jiti } from "./env.mjs";
import { test, summary } from "./harness.mjs";

const { parseTypeFile } = await jiti.import(join(EXT, "typedefs/parse.ts"));
const { listTypeDefs, resolveTypeDef, resolveAdhocDef, composeAdhocDef, ADHOC_TYPE } = await jiti.import(join(EXT, "typedefs/discover.ts"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { atomicWriteText } = await jiti.import(join(EXT, "store/atomic.ts"));
const { composeIdentityBlock } = await jiti.import(join(EXT, "context/compose.ts"));

const scratch = join(WORLDS, "phase2-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
const layout = createLayout(project, { home, sessionId: "sess-2" });
mkdirSync(layout.globalTypeDefsDir, { recursive: true });
mkdirSync(layout.projectTypeDefsDir, { recursive: true });

console.log("tolerant parse:");
await test("a pi-teams def with peers/foreign keys parses with warnings", () => {
	const teamsDef = ["---", "name: scout", "description: explorer", "peers: false", "someFutureKey: whatever", "---", "You are SCOUT."].join("\n");
	const parsed = parseTypeFile(teamsDef, "scout");
	assert.equal(parsed.ok, true);
	assert.equal(parsed.definition.config.description, "explorer");
	assert.equal(parsed.warnings.length, 2, "both foreign keys warned");
	assert.ok(parsed.warnings.every((w) => w.includes("ignored")));
});
await test("unknown key with unparseable value is still tolerated", () => {
	const def = ["---", "name: x", "description: d", "weird: [nested, [bad]]", "---", "B"].join("\n");
	const parsed = parseTypeFile(def, "x");
	assert.equal(parsed.ok, true);
	assert.ok(parsed.warnings.some((w) => w.includes("weird")));
});
await test("malformed KNOWN fields stay hard errors", () => {
	assert.equal(parseTypeFile(["---", "name: x", "description: d", "thinking: warp", "---", ""].join("\n"), "x").ok, false);
	assert.equal(parseTypeFile(["---", "name: y", "description: d", "---", ""].join("\n"), "x").ok, false, "name↔filename mismatch");
	assert.equal(parseTypeFile(["---", "name: x", "description: d", "tools: [read, 3]", "---", ""].join("\n"), "x").ok, false);
	assert.equal(parseTypeFile("no frontmatter", "x").ok, false);
});

console.log("subagent communication contract:");
await test("identity guidance forbids non-actionable starting reports", () => {
	const identity = composeIdentityBlock({ address: "scout/a", purview: "review", lifetime: "oneshot" });
	assert.ok(identity.includes("actionable progress or blocker reports"));
	assert.ok(identity.includes("Never send a report merely to announce that you are starting"));
});

console.log("reserved adhoc name:");
await test("adhoc.md in a library dir is never listed or resolvable", () => {
	writeFileSync(join(layout.globalTypeDefsDir, "adhoc.md"), ["---", "name: adhoc", "description: sneaky", "---", "S"].join("\n"));
	assert.ok(!listTypeDefs(layout).some((s) => s.name === ADHOC_TYPE));
	const resolved = resolveTypeDef(layout, ADHOC_TYPE);
	assert.equal(resolved.ok, false);
	assert.ok(resolved.error.includes("reserved"));
});

console.log("adhoc synthesis:");
await test("composeAdhocDef → resolveAdhocDef round-trip with model/thinking/tools", () => {
	const content = composeAdhocDef({ description: 'audit the "auth" module', prompt: "You are an auditor.\n\nBe thorough.", model: "mock/mock-1", thinking: "low", tools: ["read", "grep"] });
	atomicWriteText(layout.adhocDefFile(ADHOC_TYPE, "aud"), content);
	const resolved = resolveAdhocDef(layout, "aud");
	assert.equal(resolved.ok, true, resolved.error);
	const { config, body } = resolved.resolved.definition;
	assert.equal(config.model, "mock/mock-1");
	assert.equal(config.thinking, "low");
	assert.deepEqual(config.tools, ["read", "grep"]);
	assert.ok(body.includes("Be thorough."));
	assert.ok(resolved.resolved.hash.length === 64);
});
await test("missing adhoc def resolves to a clear error", () => {
	const resolved = resolveAdhocDef(layout, "ghost");
	assert.equal(resolved.ok, false);
	assert.ok(resolved.error.includes("missing"));
});

console.log("discovery & trust:");
await test("project defs only list when trusted; trusted project shadows global", () => {
	writeFileSync(join(layout.globalTypeDefsDir, "scout.md"), ["---", "name: scout", "description: global scout", "---", "G"].join("\n"));
	writeFileSync(join(layout.projectTypeDefsDir, "scout.md"), ["---", "name: scout", "description: project scout", "---", "P"].join("\n"));
	const untrusted = listTypeDefs(layout, { projectTrusted: false });
	assert.equal(untrusted.find((s) => s.name === "scout").origin, "global");
	const trusted = listTypeDefs(layout, { projectTrusted: true });
	const scout = trusted.find((s) => s.name === "scout");
	assert.equal(scout.origin, "project");
	assert.ok(scout.shadowsGlobal, "shadowed global recorded");
});
await test("symlinked defs are ignored", () => {
	writeFileSync(join(scratch, "outside.md"), ["---", "name: link", "description: d", "---", "L"].join("\n"));
	symlinkSync(join(scratch, "outside.md"), join(layout.globalTypeDefsDir, "link.md"));
	assert.ok(!listTypeDefs(layout).some((s) => s.name === "link"));
});

summary("Phase 2");
