import assert from "node:assert/strict";
import test from "node:test";
import { fitThinkingSummary, liveThinkingSummary, retainLatestThought } from "./text.ts";

test("liveThinkingSummary flattens provider-visible thinking and marks it as active", () => {
	assert.equal(liveThinkingSummary("  checking\n  state  "), "checking state · thinking…");
	assert.equal(liveThinkingSummary("   "), "thinking…");
});

test("liveThinkingSummary preserves the newest thinking within its width budget", () => {
	const summary = liveThinkingSummary(`${"older context ".repeat(20)}FINAL_MARKER`, 40);
	assert.ok(summary.startsWith("…"));
	assert.ok(summary.endsWith("FINAL_MARKER · thinking…"));
	assert.ok(Array.from(summary).length <= 40);
});

test("liveThinkingSummary honors narrow budgets", () => {
	for (let max = 0; max <= 15; max++) {
		assert.ok(Array.from(liveThinkingSummary("abcdef", max)).length <= max);
	}
});

test("fitThinkingSummary preserves the newest clue and active suffix", () => {
	const summary = liveThinkingSummary(`${"older context ".repeat(20)}FINAL_MARKER`);
	const fitted = fitThinkingSummary(summary, 32);
	assert.ok(fitted.startsWith("…"));
	assert.ok(fitted.endsWith("FINAL_MARKER · thinking…"));
	assert.ok(Array.from(fitted).length <= 32);
});

test("retainLatestThought ignores empty and whitespace-only thinking blocks", () => {
	assert.equal(retainLatestThought("prior clue", ""), "prior clue");
	assert.equal(retainLatestThought("prior clue", "  \n\t  "), "prior clue");
	assert.equal(retainLatestThought("prior clue", "new clue"), "new clue");
});
