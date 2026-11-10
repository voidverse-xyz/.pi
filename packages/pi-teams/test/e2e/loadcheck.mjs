/**
 * Registration check: load the extension entry with Pi's OWN loader and assert
 * the surface registered cleanly. Grows with each phase. Phase 2: the two tools
 * team_spawn / team_status.
 *
 * Run: node loadcheck.mjs
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import { strict as assert } from "node:assert";
import { EXT, PI_PKG, WORLDS } from "./env.mjs";

const emptyAgentDir = join(WORLDS, "loadcheck-empty");
rmSync(emptyAgentDir, { recursive: true, force: true });
mkdirSync(emptyAgentDir, { recursive: true });

const loaderModuleUrl = pathToFileURL(join(PI_PKG, "dist/core/extensions/loader.js")).href;
const { loadExtensions } = await import(loaderModuleUrl);
const result = await loadExtensions([join(EXT, "index.ts")], emptyAgentDir);

assert.deepEqual(result.errors, [], `extension load errors: ${JSON.stringify(result.errors)}`);
assert.equal(result.extensions.length, 1, "exactly one extension loads");

const ext = result.extensions[0];
const keysOf = (v) => (v?.keys ? [...v.keys()] : v ? Object.keys(v) : []);

assert.deepEqual(
	keysOf(ext.tools).sort(),
	["team_await", "team_collect", "team_interrupt", "team_peers", "team_retire", "team_send", "team_spawn", "team_status", "team_steer"],
	"the eight team_* tools",
);
assert.deepEqual(keysOf(ext.commands), ["teams"], "/teams command");

const spawn = ext.tools.get("team_spawn").definition;
assert.deepEqual(Object.keys(spawn.parameters.properties).sort(), ["contextMode", "id", "label", "task", "type"], "spawn exposes persistent-agent options and main-controlled context");
assert.deepEqual(spawn.parameters.properties.contextMode.anyOf.map(option => option.const), ["auto", "focus", "fork"]);
assert.match(spawn.description, /team_retire/, "explicit retirement is the only lifecycle end");

const peers = ext.tools.get("team_peers").definition;
assert.match(peers.description, /blocks peer delivery immediately/, "team_peers documents immediate delivery enforcement");
assert.match(peers.description, /refresh on the next wake/, "team_peers distinguishes next-wake tool and prose refresh");

console.log("loadcheck ok — tools:", keysOf(ext.tools).sort().join(", "), "· commands:", keysOf(ext.commands).join(", "));
