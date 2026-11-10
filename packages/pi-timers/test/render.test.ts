import assert from "node:assert/strict";
import test from "node:test";
import type { TimerSnapshot } from "../extensions/timers/timer-manager.ts";
import {
	buildTimerPickerItems,
	CANCEL_ALL_VALUE,
	CANCEL_KEY,
	formatCountdown,
	renderTimerWidgetLines,
} from "../extensions/timers/tui/render.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

function timer(overrides: Partial<TimerSnapshot> = {}): TimerSnapshot {
	return {
		id: "timer-1",
		label: "GitHub issue check",
		instruction: "Check GitHub issues and report anything requiring attention.",
		intervalMs: 300_000,
		maxRuns: 10,
		runCount: 2,
		remainingRuns: 8,
		pending: false,
		skippedTicks: 0,
		wakeFailures: 0,
		createdAt: 1_000_000,
		nextRunAt: 1_300_000,
		...overrides,
	};
}

test("active timer widget renders a live tree with countdown, runs, instruction, and shortcut", () => {
	const lines = renderTimerWidgetLines([timer()], 1_027_000, theme);
	assert.equal(CANCEL_KEY, "alt+r");
	assert.equal(lines.length, 4);
	assert.match(lines[0]!, /Timers · 1 active/);
	assert.match(lines[0]!, /alt\+r cancel/);
	assert.match(lines[1]!, /└─/);
	assert.match(lines[1]!, /4m 33s/);
	assert.match(lines[1]!, /2\/10 runs/);
	assert.match(lines[1]!, /GitHub issue check/);
	assert.match(lines[2]!, /Check GitHub issues/);
	assert.equal(lines[3], "");

	const unlimited = renderTimerWidgetLines([
		timer({ maxRuns: undefined, remainingRuns: undefined }),
	], 1_027_000, theme);
	assert.match(unlimited[1]!, /2\/∞ runs/);
});

test("widget renders every timer and surfaces queued, coalesced, and failed state", () => {
	const lines = renderTimerWidgetLines([
		timer({ id: "timer-1" }),
		timer({
			id: "timer-2",
			label: "Release monitor",
			pending: true,
			skippedTicks: 3,
			wakeFailures: 1,
		}),
	], 1_027_000, theme);
	assert.match(lines[0]!, /2 active/);
	assert.match(lines[1]!, /├─/);
	assert.match(lines[3]!, /└─/);
	assert.match(lines[3]!, /wake queued/);
	assert.match(lines[3]!, /3 coalesced/);
	assert.match(lines[3]!, /1 failed/);
	assert.equal(lines.at(-1), "");
	assert.deepEqual(renderTimerWidgetLines([], 1_027_000, theme), []);
});

test("countdown formatting stays compact across seconds, minutes, hours, and days", () => {
	assert.equal(formatCountdown(1_000, 1_000), "due");
	assert.equal(formatCountdown(59_001, 1_000), "59s");
	assert.equal(formatCountdown(61_000, 1_000), "1m 00s");
	assert.equal(formatCountdown(3_721_000, 1_000), "1h 2m");
	assert.equal(formatCountdown(93_601_000, 1_000), "1d 2h");
});

test("cancellation picker items expose remaining work and add cancel-all only for multiple timers", () => {
	const one = buildTimerPickerItems([timer()], 1_027_000);
	assert.deepEqual(one, [{
		value: "timer:timer-1",
		label: "GitHub issue check (timer-1)",
		description: "next 4m 33s · 8 remaining",
	}]);

	const unlimited = buildTimerPickerItems([
		timer({ maxRuns: undefined, remainingRuns: undefined }),
	], 1_027_000);
	assert.match(unlimited[0]!.description, /no run limit/);

	const multiple = buildTimerPickerItems([
		timer(),
		timer({ id: "timer-2", label: "Release monitor", pending: true }),
	], 1_027_000);
	assert.equal(multiple.length, 3);
	assert.match(multiple[1]!.description, /wake queued/);
	assert.deepEqual(multiple[2], {
		value: CANCEL_ALL_VALUE,
		label: "Cancel all 2 timers",
		description: "prevent every future wake",
	});
});
