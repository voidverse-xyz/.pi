/**
 * Tests for command classification. Run with:
 *   node --test extensions/command-safety/categories.test.ts
 * (Node 24+ strips the TS types natively; categories.ts has no runtime deps.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand } from "./categories.ts";

test("read-only inspection commands are never gated (null)", () => {
	for (const cmd of [
		"ls -la",
		"cat foo.txt",
		"grep -r foo .",
		"git status",
		"git log --oneline",
		"sort input.txt", // read: no -o
		"sort -r input.txt", // read: -r is not an output flag
		"uniq input.txt", // read: single operand
		"uniq -w 3 input.txt", // read: -w consumes "3", one operand remains
		"fd pattern src", // read: no --exec
		"tree src", // read: no -o
		"yq '.a' file.yaml", // read: no -i
	]) {
		assert.equal(classifyCommand(cmd), null, cmd);
	}
});

test("SAFE commands with a write/exec side-effect are gated (previously slipped through as null)", () => {
	// fd's exec flags run an arbitrary command per match — the most severe hole.
	// Short forms (-x/-X) rely on the new rule → "other"; the long form --exec is also
	// caught by the pre-existing \bexec\b pattern → "exec". Both are gated in max mode.
	assert.equal(classifyCommand("fd . -x rm {}"), "other");
	assert.equal(classifyCommand("fd -X touch {}"), "other");
	assert.equal(classifyCommand("fdfind pat --exec mv {} /tmp"), "exec");
	// output-file flags / operands that write.
	assert.equal(classifyCommand("sort -o out.txt in.txt"), "other");
	assert.equal(classifyCommand("sort -oout.txt in.txt"), "other"); // combined short form
	assert.equal(classifyCommand("sort --output=out.txt in.txt"), "other");
	assert.equal(classifyCommand("tree -o listing.html"), "other");
	assert.equal(classifyCommand("uniq in.txt out.txt"), "other"); // 2nd operand is written
	assert.equal(classifyCommand("yq -i '.a=1' cfg.yaml"), "other");
});

test("existing category classification is unchanged", () => {
	assert.equal(classifyCommand("rm -rf build"), "destructive");
	assert.equal(classifyCommand("fd . -x rm -rf {}"), "destructive"); // rm -rf wins over "other"
	assert.equal(classifyCommand("curl http://example.com"), "network");
	assert.equal(classifyCommand("python script.py"), "exec");
	assert.equal(classifyCommand("echo hi > file"), "other"); // redirect to a real file
	assert.equal(classifyCommand("some-unknown-tool --flag"), "other");
});
