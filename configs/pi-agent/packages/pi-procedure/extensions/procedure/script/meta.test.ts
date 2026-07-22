import assert from "node:assert/strict";
import test from "node:test";
import { extractMeta } from "./meta.ts";

test("extracts a simple meta and blanks the statement preserving lines", () => {
	const src = `export const meta = {
	name: 'find-bugs',
	description: 'Find bugs',
	phases: ['Scan', { title: 'Fix', detail: 'one agent per bug' }],
};
phase('Scan')
`;
	const { meta, body } = extractMeta(src);
	assert.deepEqual(meta, { name: "find-bugs", description: "Find bugs", phases: ["Scan", "Fix"] });
	assert.equal(body.split("\n").length, src.split("\n").length);
	assert.ok(!body.includes("find-bugs"));
	// the body after the meta span is untouched, on its original line
	assert.equal(body.split("\n")[5], "phase('Scan')");
});

test("handles nested braces, strings with braces, template ${}, and comments", () => {
	const src = [
		"export const meta = {",
		"	name: 'x', // trailing } comment",
		"	description: \"has } and { inside\",",
		"	/* block } comment */",
		"	phases: [{ title: `tpl ${'{'} done` }],",
		"};",
		"return 1",
	].join("\n");
	const { meta } = extractMeta(src);
	assert.equal(meta?.name, "x");
	assert.deepEqual(meta?.phases, ["tpl { done"]);
});

test("no meta → null meta, body untouched", () => {
	const { meta, body } = extractMeta("return await agent('hi')");
	assert.equal(meta, null);
	assert.equal(body, "return await agent('hi')");
});

test("rejects non-literal meta (identifiers, calls, spreads)", () => {
	assert.throws(() => extractMeta("export const meta = { name: someVar };"), /pure literal/);
	assert.throws(() => extractMeta("export const meta = { name: f() };"), /pure literal/);
	assert.throws(() => extractMeta("export const meta = { ...base };"), /pure literal/);
});

test("rejects bad shapes", () => {
	assert.throws(() => extractMeta("export const meta = { description: 'no name' };"), /meta\.name/);
	assert.throws(() => extractMeta("export const meta = { name: 'bad name!' };"), /meta\.name/);
	assert.throws(() => extractMeta("export const meta = { name: 'x', phases: 'nope' };"), /phases must be an array/);
	assert.throws(() => extractMeta("export const meta = { name: 'x', phases: [1] };"), /phases\[0\]/);
	assert.throws(() => extractMeta("export const meta = [1];"), /object literal/);
	assert.throws(() => extractMeta("export const meta = {\nexport const meta = {}"), /Unbalanced/);
});

test("rejects a duplicated meta statement", () => {
	const src = "export const meta = { name: 'a' };\nexport const meta = { name: 'b' };";
	assert.throws(() => extractMeta(src), /only one/);
});

test("does not match `export const meta` inside a longer identifier or mid-line", () => {
	const { meta } = extractMeta("const reexport = 1; // export const meta = {} in a comment is still matched only at line starts\n");
	assert.equal(meta, null);
});
