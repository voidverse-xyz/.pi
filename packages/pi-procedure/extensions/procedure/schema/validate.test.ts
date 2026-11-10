import assert from "node:assert/strict";
import test from "node:test";
import { schemaShapeErrors, validateAgainstSchema } from "./validate.ts";

// The validator itself is battle-tested in pi-teams; these cover the
// integration surface pi-procedure relies on.

const FINDINGS = {
	type: "object",
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: { title: { type: "string" }, severity: { enum: ["low", "high"] } },
				required: ["title"],
				additionalProperties: false,
			},
		},
	},
	required: ["findings"],
	additionalProperties: false,
};

test("accepts conforming payloads", () => {
	const r = validateAgainstSchema({ findings: [{ title: "x", severity: "high" }] }, FINDINGS);
	assert.deepEqual(r, { valid: true, errors: [] });
});

test("reports violations with paths", () => {
	const r = validateAgainstSchema({ findings: [{ severity: "mid", extra: 1 }] }, FINDINGS);
	assert.equal(r.valid, false);
	assert.ok(r.errors.some((e) => e.includes('missing required property "title"')));
	assert.ok(r.errors.some((e) => e.includes("not in enum")));
	assert.ok(r.errors.some((e) => e.includes('unexpected property "extra"')));
});

test("schemaShapeErrors fails fast on malformed schemas", () => {
	assert.deepEqual(schemaShapeErrors(FINDINGS), []);
	assert.ok(schemaShapeErrors({ type: "wat" }).length > 0);
	assert.ok(schemaShapeErrors({ enum: [] }).length > 0);
	assert.ok(schemaShapeErrors("nope").length > 0);
});
