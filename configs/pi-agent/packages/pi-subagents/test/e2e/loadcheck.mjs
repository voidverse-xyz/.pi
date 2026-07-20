/**
 * Registration check: load the extension entry with Pi's OWN loader and assert
 * the surface registered cleanly — the seven subagent_* tools and the
 * /subagents command.
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

assert.deepEqual(
	keysOf(ext.tools).sort(),
	["subagent_await", "subagent_cancel", "subagent_retire", "subagent_send", "subagent_spawn", "subagent_status", "subagent_steer"],
	"the seven subagent_* tools",
);
assert.deepEqual(keysOf(ext.commands), ["subagents"], "/subagents command");

const spawn = ext.tools.get("subagent_spawn").definition;
assert.ok(spawn.parameters.required.includes("label"), "subagent_spawn requires an LLM-provided display label");
assert.equal(spawn.parameters.properties.label.maxLength, 80, "label schema stays compact");
assert.ok(spawn.promptGuidelines.some((line) => line.includes("task-specific label")), "system guidance tells the LLM to name the widget row");
assert.equal(
	spawn.prepareArguments({ prompt: "You are a reviewer.", task: "Review authentication." }).label,
	"Review authentication.",
	"pre-label resumed tool calls receive a deterministic compatibility label",
);

console.log("loadcheck ok — tools:", keysOf(ext.tools).sort().join(", "), "· commands:", keysOf(ext.commands).join(", "));
