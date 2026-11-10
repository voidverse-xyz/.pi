import assert from "node:assert/strict";
import test from "node:test";

import { formatUsageLines } from "../extensions/codex-usage/index.ts";

const credits = {
	hasCredits: false,
	unlimited: false,
	balance: "0",
};

test("formats a seven-day-only response", () => {
	const lines = formatUsageLines({
		primary: {
			usedPercent: 4,
			windowDurationMins: 7 * 24 * 60,
			resetsAt: null,
		},
		secondary: null,
		planType: "prolite",
		credits,
	});

	assert.deepEqual(lines, [
		"Codex usage",
		"Plan: prolite",
		"7d 4% (?)",
		"Credits: 0",
	]);
});

test("formats a secondary-only seven-day response", () => {
	const lines = formatUsageLines({
		primary: null,
		secondary: {
			usedPercent: 8,
			windowDurationMins: 7 * 24 * 60,
			resetsAt: null,
		},
		planType: "pro",
		credits,
	});

	assert.deepEqual(lines, [
		"Codex usage",
		"Plan: pro",
		"7d 8% (?)",
		"Credits: 0",
	]);
});

test("formats both five-hour and seven-day windows shortest-first", () => {
	const lines = formatUsageLines({
		primary: {
			usedPercent: 40,
			windowDurationMins: 7 * 24 * 60,
			resetsAt: null,
		},
		secondary: {
			usedPercent: 20,
			windowDurationMins: 5 * 60,
			resetsAt: null,
		},
		planType: "pro",
		credits,
	});

	assert.deepEqual(lines, [
		"Codex usage",
		"Plan: pro",
		"5h 20% (?)",
		"7d 40% (?)",
		"Credits: 0",
	]);
});
