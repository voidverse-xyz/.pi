import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_TIMERS,
	MIN_INTERVAL_MS,
	TimerManager,
	type TimerScheduler,
	type TimerWake,
} from "../extensions/timers/timer-manager.ts";

class FakeScheduler implements TimerScheduler {
	nowMs = 1_000_000;
	private nextHandle = 1;
	private readonly callbacks = new Map<number, { callback: () => void; intervalMs: number }>();

	now(): number {
		return this.nowMs;
	}

	scheduleEvery(callback: () => void, intervalMs: number): unknown {
		const handle = this.nextHandle++;
		this.callbacks.set(handle, { callback, intervalMs });
		return handle;
	}

	clear(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}

	fire(handle = 1): void {
		const scheduled = this.callbacks.get(handle);
		if (!scheduled) throw new Error(`No scheduled callback for handle ${handle}.`);
		this.nowMs += scheduled.intervalMs;
		scheduled.callback();
	}

	get activeCount(): number {
		return this.callbacks.size;
	}
}

function createManager(overrides: { onWake?: (wake: TimerWake) => void } = {}) {
	const scheduler = new FakeScheduler();
	const wakes: TimerWake[] = [];
	const errors: unknown[] = [];
	const manager = new TimerManager({
		scheduler,
		onWake: overrides.onWake ?? ((wake) => wakes.push(wake)),
		onWakeError: (error) => errors.push(error),
	});
	return { manager, scheduler, wakes, errors };
}

test("creates finite timers whose first wake follows one full interval", () => {
	const { manager, scheduler } = createManager();
	const timer = manager.create({
		instruction: "Check GitHub issues",
		intervalMs: 5 * 60_000,
		maxRuns: 10,
		label: "  GitHub   issue check  ",
	});
	assert.deepEqual(timer, {
		id: "timer-1",
		label: "GitHub issue check",
		instruction: "Check GitHub issues",
		intervalMs: 300_000,
		maxRuns: 10,
		runCount: 0,
		remainingRuns: 10,
		pending: false,
		skippedTicks: 0,
		wakeFailures: 0,
		createdAt: 1_000_000,
		nextRunAt: 1_300_000,
	});
	assert.equal(scheduler.activeCount, 1);

	const overOldCap = manager.create({
		instruction: "Check a long-running migration",
		intervalMs: MIN_INTERVAL_MS,
		maxRuns: 51,
	});
	assert.equal(overOldCap.maxRuns, 51);
	assert.equal(overOldCap.remainingRuns, 51);

	assert.throws(
		() => manager.create({ instruction: "x", intervalMs: MIN_INTERVAL_MS - 1, maxRuns: 1 }),
		/interval must be a whole number/,
	);
	assert.throws(
		() => manager.create({ instruction: "x", intervalMs: MIN_INTERVAL_MS, maxRuns: 0 }),
		/maxRuns must be a whole number/,
	);
	assert.throws(
		() => manager.create({ instruction: "   ", intervalMs: MIN_INTERVAL_MS, maxRuns: 1 }),
		/instruction must not be empty/,
	);
	manager.dispose();
});

test("keeps timers without maxRuns active indefinitely", () => {
	const { manager, scheduler, wakes } = createManager();
	const timer = manager.create({ instruction: "Keep checking", intervalMs: MIN_INTERVAL_MS });
	assert.equal(timer.maxRuns, undefined);
	assert.equal(timer.remainingRuns, undefined);

	for (let run = 1; run <= 55; run++) {
		scheduler.fire();
		assert.equal(wakes.at(-1)?.run, run);
		assert.equal(wakes.at(-1)?.maxRuns, undefined);
		assert.equal(wakes.at(-1)?.finalRun, false);
		manager.markAgentSettled();
	}

	assert.equal(manager.list()[0]?.runCount, 55);
	assert.equal(scheduler.activeCount, 1);
	manager.dispose();
});

test("coalesces overlapping ticks and removes a timer after its finite run cap", () => {
	const { manager, scheduler, wakes } = createManager();
	manager.create({ instruction: "Check issues", intervalMs: MIN_INTERVAL_MS, maxRuns: 3 });

	scheduler.fire();
	assert.deepEqual(wakes.map((wake) => [wake.run, wake.finalRun, wake.skippedTicks]), [[1, false, 0]]);
	assert.equal(manager.list()[0]?.pending, true);
	assert.equal(manager.list()[0]?.runCount, 1);

	// The first accepted wake has not settled, so this due tick is coalesced and
	// does not consume one of the finite runs.
	scheduler.fire();
	assert.equal(wakes.length, 1);
	assert.equal(manager.list()[0]?.skippedTicks, 1);
	assert.equal(manager.list()[0]?.runCount, 1);

	manager.markAgentSettled();
	scheduler.fire();
	assert.deepEqual(wakes.map((wake) => [wake.run, wake.finalRun, wake.skippedTicks]), [
		[1, false, 0],
		[2, false, 1],
	]);

	manager.markAgentSettled();
	scheduler.fire();
	assert.deepEqual(wakes.map((wake) => [wake.run, wake.finalRun]), [
		[1, false],
		[2, false],
		[3, true],
	]);
	assert.deepEqual(manager.list(), []);
	assert.equal(scheduler.activeCount, 0);
});

test("does not count a synchronous wake rejection as an invocation", () => {
	let reject = true;
	const accepted: TimerWake[] = [];
	const { manager, scheduler, errors } = createManager({
		onWake: (wake) => {
			if (reject) throw new Error("injection rejected");
			accepted.push(wake);
		},
	});
	manager.create({ instruction: "Retry safely", intervalMs: MIN_INTERVAL_MS, maxRuns: 1 });

	scheduler.fire();
	assert.equal(manager.list()[0]?.runCount, 0);
	assert.equal(manager.list()[0]?.pending, false);
	assert.equal(manager.list()[0]?.wakeFailures, 1);
	assert.equal(errors.length, 1);

	reject = false;
	scheduler.fire();
	assert.equal(accepted.length, 1);
	assert.equal(accepted[0]?.run, 1);
	assert.deepEqual(manager.list(), []);
});

test("enforces the active timer cap and supports precise cancellation", () => {
	const { manager, scheduler } = createManager();
	for (let index = 0; index < MAX_TIMERS; index++) {
		manager.create({ instruction: `Timer ${index}`, intervalMs: MIN_INTERVAL_MS, maxRuns: 2 });
	}
	assert.equal(manager.list().length, MAX_TIMERS);
	assert.throws(
		() => manager.create({ instruction: "Too many", intervalMs: MIN_INTERVAL_MS, maxRuns: 1 }),
		/At most 5 timers/,
	);

	const cancelled = manager.cancel("timer-3");
	assert.equal(cancelled?.id, "timer-3");
	assert.equal(manager.cancel("timer-3"), undefined);
	assert.equal(manager.list().length, MAX_TIMERS - 1);

	assert.equal(manager.cancelAll().length, MAX_TIMERS - 1);
	assert.equal(scheduler.activeCount, 0);
	manager.dispose();
	manager.dispose();
	assert.throws(
		() => manager.create({ instruction: "After shutdown", intervalMs: MIN_INTERVAL_MS, maxRuns: 1 }),
		/shut down/,
	);
});
