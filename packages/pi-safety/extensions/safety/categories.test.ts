/**
 * Tests for command classification. Run with:
 *   node --test extensions/safety/categories.test.ts
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
	assert.equal(classifyCommand("echo hi > file"), "destructive"); // overwrite/truncate risk
	assert.equal(classifyCommand("some-unknown-tool --flag"), "other");
});

test("unsafe forms of otherwise read-only commands never fail open", () => {
	assert.equal(classifyCommand("command rm file"), "destructive");
	assert.equal(classifyCommand("sudo rm file"), "destructive");
	assert.equal(classifyCommand("PAGER=evil git log"), "other");
	assert.equal(classifyCommand("rg --pre ./processor pattern"), "other");
	assert.equal(classifyCommand("sort --compress-program=evil input"), "other");
	assert.equal(classifyCommand("date --set=tomorrow"), "other");
	assert.equal(classifyCommand("hostname new-name"), "other");
	assert.equal(classifyCommand("git diff --output=patch"), "other");
	assert.equal(classifyCommand("git cat-file --filters HEAD:file"), "other");
	assert.equal(classifyCommand("git symbolic-ref HEAD refs/heads/other"), "other");
	assert.equal(classifyCommand("git reflog expire --all"), "destructive");
	assert.equal(classifyCommand("echo hi >| existing"), "destructive");
	assert.equal(classifyCommand("echo hi >> existing"), "other");
});

test("bare `&` background operator does not hide an ungated command", () => {
	// Previously the segment splitter omitted `&`, so a safe leading command let the
	// rest of the line run unclassified (null) — a max-mode fail-open.
	assert.equal(classifyCommand("ls & ./evil.sh"), "other");
	assert.equal(classifyCommand("pwd & danger-cmd arg"), "other");
	assert.equal(classifyCommand("ls & ls & danger"), "other");
	// but `&` inside fd-dup / redirect-all / logical-and / pipe must NOT split a segment:
	assert.equal(classifyCommand("cat foo.txt 2>&1"), null);
	assert.equal(classifyCommand("ls &> /dev/null"), null);
	assert.equal(classifyCommand("git status && git log"), null);
});

test("destructive rm is caught on later lines, when quoted, and fork bomb with a space", () => {
	assert.equal(classifyCommand("cd /tmp\nrm secret.db"), "destructive"); // newline-separated
	assert.equal(classifyCommand("'rm' -rf /"), "destructive"); // single-quoted
	assert.equal(classifyCommand('"rm" -rf /'), "destructive"); // double-quoted
	assert.equal(classifyCommand(": () { :|:& };:"), "destructive"); // space after `:`
});
