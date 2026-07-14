/**
 * Registration check: load the extension entry with Pi's OWN loader and assert
 * the surface registered cleanly. Grows with each phase. Phase 2: the two tools
 * subagent_spawn / subagent_status.
 *
 * Run: node loadcheck.mjs
 */
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS } from "./env.mjs";

const emptyAgentDir = join(WORLDS, "loadcheck-empty");
rmSync(emptyAgentDir, { recursive: true, force: true });
mkdirSync(emptyAgentDir, { recursive: true });

const { loadExtensions } = await import(join(PI_PKG, "dist/core/extensions/loader.js"));
const result = await loadExtensions([join(EXT, "index.ts")], emptyAgentDir);

assert.deepEqual(result.errors, [], `extension load errors: ${JSON.stringify(result.errors)}`);
assert.equal(result.extensions.length, 1, "exactly one extension loads");

const ext = result.extensions[0];
const keysOf = (v) => (v?.keys ? [...v.keys()] : v ? Object.keys(v) : []);

assert.deepEqual(keysOf(ext.tools).sort(), ["subagent_spawn", "subagent_status"], "Phase 2 tool surface");

console.log("loadcheck ok — tools:", keysOf(ext.tools).sort().join(", "));
