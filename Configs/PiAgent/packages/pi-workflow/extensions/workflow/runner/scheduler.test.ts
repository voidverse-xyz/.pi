import assert from "node:assert/strict";
import test from "node:test";
import { Scheduler } from "./scheduler.ts";

test("caps concurrency and drains FIFO", async () => {
	const s = new Scheduler(2);
	const r1 = await s.acquire();
	const r2 = await s.acquire();
	assert.equal(s.runningCount, 2);

	const order: number[] = [];
	const w3 = s.acquire().then((r) => (order.push(3), r));
	const w4 = s.acquire().then((r) => (order.push(4), r));
	assert.equal(s.queuedCount, 2);

	r1();
	const r3 = await w3;
	assert.deepEqual(order, [3]);
	assert.equal(s.runningCount, 2);

	r2();
	r3();
	await w4;
	assert.deepEqual(order, [3, 4]);
});

test("double release is a no-op", async () => {
	const s = new Scheduler(1);
	const r = await s.acquire();
	r();
	r();
	assert.equal(s.runningCount, 0);
	const r2 = await s.acquire();
	assert.equal(s.runningCount, 1);
	r2();
});
