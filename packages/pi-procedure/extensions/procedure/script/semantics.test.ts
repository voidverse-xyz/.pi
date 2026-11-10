import assert from "node:assert/strict";
import test from "node:test";
import { AgentFailure, makeCombinators, ProcedureStopped } from "./semantics.ts";

const { parallel, pipeline } = makeCombinators();

test("parallel: failures become null, others survive", async () => {
	const out = await parallel([
		async () => "ok",
		async () => {
			throw new AgentFailure("boom");
		},
		async () => {
			throw new Error("plain throw also nulls");
		},
	]);
	assert.deepEqual(out, ["ok", null, null]);
});

test("parallel: thunks invoked in array order (deterministic seq for first calls)", async () => {
	const order: number[] = [];
	await parallel([0, 1, 2].map((i) => async () => order.push(i)));
	assert.deepEqual(order, [0, 1, 2]);
});

test("parallel: ProcedureStopped propagates instead of nulling", async () => {
	await assert.rejects(
		parallel([
			async () => "fine",
			async () => {
				throw new ProcedureStopped();
			},
		]),
		ProcedureStopped,
	);
});

test("parallel: rejects non-arrays and non-functions", async () => {
	await assert.rejects(parallel("nope" as never), TypeError);
	await assert.rejects(parallel([42] as never), TypeError);
});

test("pipeline: stages thread (prev, item, index); a stage throw drops the item", async () => {
	const seen: unknown[][] = [];
	const out = await pipeline(
		["a", "b"],
		async (prev) => `${prev}1`,
		async (prev, item, index) => {
			seen.push([prev, item, index]);
			if (item === "b") throw new AgentFailure("drop b");
			return `${prev}2`;
		},
		async (prev) => `${prev}3`,
	);
	assert.deepEqual(out, ["a123", null]);
	assert.deepEqual(seen, [
		["a1", "a", 0],
		["b1", "b", 1],
	]);
});

test("pipeline: no barrier — item A's later stage runs before item B's stage 1 resolves", async () => {
	const events: string[] = [];
	let releaseB: () => void = () => {};
	const bGate = new Promise<void>((r) => {
		releaseB = r;
	});
	const out = pipeline(
		["A", "B"],
		async (_prev, item) => {
			if (item === "B") await bGate;
			events.push(`s1:${item}`);
			return item;
		},
		async (prev, item) => {
			events.push(`s2:${item}`);
			if (item === "A") releaseB();
			return prev;
		},
	);
	assert.deepEqual(await out, ["A", "B"]);
	assert.deepEqual(events, ["s1:A", "s2:A", "s1:B", "s2:B"]);
});

test("pipeline: ProcedureStopped propagates", async () => {
	await assert.rejects(
		pipeline([1], async () => {
			throw new ProcedureStopped();
		}),
		ProcedureStopped,
	);
});
