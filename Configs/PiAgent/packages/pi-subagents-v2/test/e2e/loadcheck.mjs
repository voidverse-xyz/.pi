/**
 * Definitive registration check: load the extension entry with Pi's OWN
 * extension loader and assert the full surface registered cleanly — the
 * seven subagent_* tools, the /subagents command, and both shortcuts.
 *
 * Run: node loadcheck.mjs   (exits non-zero on any load error / missing item)
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

assert.deepEqual(
	keysOf(ext.tools).sort(),
	[
		"subagent_collect",
		"subagent_interrupt",
		"subagent_retire",
		"subagent_send",
		"subagent_spawn",
		"subagent_status",
		"subagent_steer",
	],
	"the seven-tool surface",
);
assert.deepEqual(keysOf(ext.commands), ["subagents"], "/subagents command");
assert.deepEqual(keysOf(ext.shortcuts).sort(), ["alt+e", "ctrl+j"], "shortcuts");

console.log("loadcheck ok — tools:", keysOf(ext.tools).length, "· commands:", keysOf(ext.commands), "· shortcuts:", keysOf(ext.shortcuts));
