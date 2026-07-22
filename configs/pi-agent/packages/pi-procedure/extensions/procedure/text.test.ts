import assert from "node:assert/strict";
import test from "node:test";
import { liveThinkingSummary } from "./text.ts";

test("liveThinkingSummary flattens provider-visible thinking", () => {
	assert.equal(liveThinkingSummary("  checking\n  state  "), "Thinking: checking state");
	assert.equal(liveThinkingSummary("   "), "thinking…");
});

test("liveThinkingSummary preserves the newest thinking within its width budget", () => {
	const summary = liveThinkingSummary(`${"older context ".repeat(20)}FINAL_MARKER`, 40);
	assert.ok(summary.startsWith("Thinking: …"));
	assert.ok(summary.endsWith("FINAL_MARKER"));
	assert.ok(Array.from(summary).length <= 40);
});
