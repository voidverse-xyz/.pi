import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmGatedCommand, createSerialConfirmation } from "../extensions/safety/confirm.ts";
import { delayedConfirm } from "../extensions/safety/delayed-confirm.ts";

const flush = () => new Promise(setImmediate);
const options = { label: "Other", color: "warning", command: "unknown", delayMs: 0 };

function fakeTui(signal) {
	const dialogs = [];
	const ctx = {
		mode: "tui", hasUI: true, signal,
		ui: {
			custom(factory) {
				return new Promise((resolve) => {
					const dialog = { closed: false };
					dialog.component = factory({ requestRender() {} }, {}, {}, (value) => {
						dialog.closed = true;
						dialog.component?.dispose();
						resolve(value);
					});
					if (dialog.closed) dialog.component.dispose();
					dialogs.push(dialog);
				});
			},
		},
	};
	return { ctx, dialogs };
}

test("pre-aborted explicit signal skips UI; default still uses main signal", async () => {
	const { ctx, dialogs } = fakeTui(AbortSignal.abort());
	assert.equal(await delayedConfirm(ctx, options), false);
	assert.equal(await confirmGatedCommand(ctx, "destructive", "rm file"), false);
	assert.equal(await delayedConfirm({ ...ctx, signal: undefined }, options, AbortSignal.abort()), false);
	assert.equal(dialogs.length, 0);
});

test("explicit worker signal ignores main abort and closes active TUI through finish(false)", async () => {
	const main = new AbortController();
	const worker = new AbortController();
	const { ctx, dialogs } = fakeTui(main.signal);
	const result = delayedConfirm(ctx, { ...options, delayMs: 3000 }, worker.signal);
	main.abort();
	assert.equal(dialogs[0].closed, false);
	worker.abort();
	assert.equal(await result, false);
	assert.equal(dialogs[0].closed, true);
	dialogs[0].component.handleInput("y"); // Late input cannot reverse a cancellation.
});

test("destructive confirmations preserve delays and cancel between steps", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const worker = new AbortController();
	const { ctx, dialogs } = fakeTui();
	const result = confirmGatedCommand(ctx, "destructive", "rm file", worker.signal);
	dialogs[0].component.handleInput("y");
	assert.equal(dialogs[0].closed, false);
	t.mock.timers.tick(3000);
	dialogs[0].component.handleInput("y");
	worker.abort(); // Before the sequence's continuation can open step two.
	assert.equal(await result, false);
	assert.equal(dialogs.length, 1);
});

test("destructive commands require two separately delayed approvals", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const { ctx, dialogs } = fakeTui();
	const result = confirmGatedCommand(ctx, "destructive", "rm file");
	t.mock.timers.tick(3000);
	dialogs[0].component.handleInput("y");
	await flush();
	assert.equal(dialogs.length, 2);
	dialogs[1].component.handleInput("y");
	assert.equal(dialogs[1].closed, false);
	t.mock.timers.tick(3000);
	dialogs[1].component.handleInput("y");
	assert.equal(await result, true);
});

test("queued cancellation is prompt, skips UI, and retains serialization behind predecessor", async () => {
	const releases = [];
	const calls = [];
	const serial = createSerialConfirmation(async (_ctx, _category, command) => {
		calls.push(command);
		return new Promise((resolve) => releases.push(resolve));
	});
	const first = serial({}, "other", "first");
	const controller = new AbortController();
	const canceled = serial({}, "other", "canceled", controller.signal);
	const last = serial({}, "other", "last");
	await flush();
	controller.abort();
	assert.equal(await canceled, false);
	await flush();
	assert.deepEqual(calls, ["first"]);
	releases[0](true);
	assert.equal(await first, true);
	await flush();
	assert.deepEqual(calls, ["first", "last"]);
	releases[1](true);
	assert.equal(await last, true);
});

test("active canceled waiter does not release serial tail until UI actually settles", async () => {
	let release;
	let calls = 0;
	const controller = new AbortController();
	const serial = createSerialConfirmation(async () => {
		calls++;
		if (calls === 1) return new Promise((resolve) => { release = resolve; });
		return true;
	});
	const first = serial({}, "other", "first", controller.signal);
	const next = serial({}, "other", "next");
	await flush();
	controller.abort();
	assert.equal(await first, false);
	await flush();
	assert.equal(calls, 1);
	release(true);
	assert.equal(await next, true);
	assert.equal(calls, 2);
});

test("serial gate checks policy after queue and after approval; errors do not poison tail", async () => {
	let current = true;
	let release;
	let calls = 0;
	const serial = createSerialConfirmation(async () => {
		calls++;
		if (calls === 1) return new Promise((resolve) => { release = resolve; });
		throw new Error("UI failure");
	});
	const first = serial({}, "other", "first", undefined, () => current);
	const queued = serial({}, "other", "queued", undefined, () => current);
	await flush();
	current = false;
	release(true);
	assert.equal(await first, false);
	assert.equal(await queued, false);
	assert.equal(calls, 1);
	await assert.rejects(serial({}, "other", "failure"), /UI failure/);
	await assert.rejects(serial({}, "other", "next failure"), /UI failure/);
});

test("RPC delay and active confirm use explicit signal, not the main run", async () => {
	const worker = new AbortController();
	let captured;
	const ctx = {
		mode: "rpc", hasUI: true, signal: AbortSignal.abort(),
		ui: { confirm(_title, _message, options) {
			captured = options.signal;
			return new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(false), { once: true }));
		} },
	};
	const result = delayedConfirm(ctx, options, worker.signal);
	while (!captured) await flush();
	assert.equal(captured, worker.signal);
	worker.abort();
	assert.equal(await result, false);

	let prompts = 0;
	ctx.ui.confirm = async () => { prompts++; return true; };
	const delay = new AbortController();
	const delayed = delayedConfirm(ctx, { ...options, delayMs: 60_000 }, delay.signal);
	delay.abort();
	assert.equal(await delayed, false);
	assert.equal(prompts, 0);
});
