/**
 * phase2-schema.mjs — structured-output forcing end to end:
 *   reply 1: plain text (ignores the schema)  → runner re-prompts
 *   reply 2: structured_output with an invalid value → in-turn tool error
 *   reply 3: structured_output with a valid value → captured, turn terminates
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
import { makeWorld, summary, test, ProcedureRun } from "./harness.mjs";

const { createOutputSlot, createStructuredOutputTool } = await jiti.import(join(EXT, "runner/structured-output.ts"));
const world = await makeWorld("phase2");

const SCHEMA = {
	type: "object",
	properties: { verdict: { enum: ["real", "false-positive"] }, note: { type: "string" } },
	required: ["verdict"],
	additionalProperties: false,
};

const SOURCE = `const v = await agent('judge this', {label: 'judge', schema: ${JSON.stringify(SCHEMA)}})
return v
`;

world.scripts.push({ match: (c) => c.label === "judge" && c.messageCount <= 1, reply: () => ({ text: "I think it is real." }) });
world.scripts.push({
	match: (c) => c.label === "judge",
	reply: () => ({ tools: [{ name: "structured_output", args: { output: { verdict: "maybe", extra: 1 } } }] }),
});
world.scripts.push({
	match: (c) => c.label === "judge",
	reply: () => ({ tools: [{ name: "structured_output", args: { output: { verdict: "real", note: "confirmed" } } }] }),
});

await test("invalid structured_output throws so Pi marks the tool result as an error", async () => {
	const slot = createOutputSlot();
	const tool = createStructuredOutputTool(SCHEMA, slot);
	await assert.rejects(
		tool.execute("invalid", { output: { verdict: "maybe", extra: 1 } }),
		/does not match the required schema/,
	);
	assert.equal(slot.set, false);
});

await test("invalid output is rejected in-turn, valid output is captured", async () => {
	const run = ProcedureRun.create(world.makeRunOptions({ source: SOURCE }));
	const outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result, { verdict: "real", note: "confirmed" });
});

await test("the mock saw the re-prompt and the validation error", () => {
	const texts = world.llmCalls.map((c) => c.lastUserText);
	assert.ok(texts.some((t) => t.includes("You have not delivered your result yet")), "re-prompt missing");
	assert.equal(world.llmCalls.length >= 3, true);
});

await test("an agent that never satisfies the schema yields AgentFailure → null in parallel", async () => {
	// fresh scripts: always plain text; re-prompts exhaust
	world.scripts.push({ match: (c) => c.label === "stubborn", reply: () => ({ text: "no tools" }) });
	world.scripts.push({ match: (c) => c.label === "stubborn", reply: () => ({ text: "still no tools" }) });
	world.scripts.push({ match: (c) => c.label === "stubborn", reply: () => ({ text: "never" }) });
	const src = `const out = await parallel([() => agent('x', {label: 'stubborn', schema: {type: 'object'}})])
return out
`;
	const run = ProcedureRun.create(world.makeRunOptions({ source: src }));
	const outcome = await run.execute();
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result, [null]);
});

summary("phase2-schema");
