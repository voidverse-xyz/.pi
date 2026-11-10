import assert from "node:assert/strict";
import test from "node:test";
import {
	combineQueuedContent,
	combineQueuedText,
	patchCompactionQueue,
	restoreOwnedEditorFactory,
	shouldManageInput,
	takeQueuedTextForEditor,
} from "./logic.ts";

test("restoreOwnedEditorFactory restores only the wrapper it owns", () => {
	const previous = () => "previous";
	const owned = () => "owned";
	let current: (() => string) | undefined = owned;

	assert.equal(restoreOwnedEditorFactory(() => current, (factory) => { current = factory; }, owned, previous), true);
	assert.equal(current, previous);

	current = undefined;
	assert.equal(restoreOwnedEditorFactory(() => current, (factory) => { current = factory; }, owned, previous), false);
	assert.equal(current, undefined);
});

test("shouldManageInput captures streaming and non-streaming busy input", () => {
	assert.equal(shouldManageInput({ text: "steer", source: "interactive", streamingBehavior: "steer", isIdle: false }), true);
	assert.equal(shouldManageInput({ text: "follow up", source: "interactive", streamingBehavior: "followUp", isIdle: false }), true);
	assert.equal(
		shouldManageInput({ text: "during compaction", source: "interactive", streamingBehavior: undefined, isIdle: false }),
		true,
	);
});

test("shouldManageInput leaves idle, non-interactive, and slash input to Pi", () => {
	assert.equal(shouldManageInput({ text: "idle", source: "interactive", streamingBehavior: undefined, isIdle: true }), false);
	assert.equal(shouldManageInput({ text: "rpc", source: "rpc", streamingBehavior: "steer", isIdle: false }), false);
	assert.equal(shouldManageInput({ text: "  /skill:test", source: "interactive", streamingBehavior: "steer", isIdle: false }), false);
});

test("combineQueuedText keeps submissions on adjacent lines", () => {
	assert.equal(combineQueuedText("first", "second"), "first\nsecond");
	assert.equal(combineQueuedText("", "second"), "second");
	assert.equal(combineQueuedText("first", ""), "first");
});

test("combineQueuedContent coalesces text and images without mutating inputs", () => {
	const first = { text: "first", images: ["image-1"] };
	const second = { text: "second", images: ["image-2"] };

	assert.deepEqual(combineQueuedContent(first, second), {
		text: "first\nsecond",
		images: ["image-1", "image-2"],
	});
	assert.deepEqual(first, { text: "first", images: ["image-1"] });
	assert.deepEqual(second, { text: "second", images: ["image-2"] });
});

test("takeQueuedTextForEditor removes text-only content from the queue", () => {
	assert.deepEqual(takeQueuedTextForEditor({ text: "fix and resend" }), {
		editorText: "fix and resend",
		remaining: undefined,
	});
});

test("takeQueuedTextForEditor keeps images queued and rejects image-only content", () => {
	assert.deepEqual(takeQueuedTextForEditor({ text: "caption", images: ["image"] }), {
		editorText: "caption",
		remaining: { text: "", images: ["image"] },
	});
	assert.equal(takeQueuedTextForEditor({ text: "", images: ["image"] }), null);
});

test("patchCompactionQueue captures and flushes before Pi's native queue lifecycle", async () => {
	const calls: string[] = [];
	const prototype = {
		queueCompactionMessage(this: unknown, text: string, mode: "steer" | "followUp") {
			calls.push(`native:${mode}:${text}`);
		},
		async flushCompactionQueue() {
			calls.push("native-flush");
		},
	};
	const host = {
		editor: {
			addToHistory: (text: string) => calls.push(`history:${text}`),
			setText: (text: string) => calls.push(`editor:${text}`),
		},
		showStatus: (message: string) => calls.push(`status:${message}`),
	};
	const restore = patchCompactionQueue(
		prototype,
		(text, mode) => {
			calls.push(`capture:${mode}:${text}`);
			return true;
		},
		() => calls.push("managed-flush"),
	);

	assert.ok(restore);
	prototype.queueCompactionMessage!.call(host, "first", "steer");
	await prototype.flushCompactionQueue!.call(host);
	assert.deepEqual(calls, [
		"capture:steer:first",
		"history:first",
		"editor:",
		"status:Managed message queued for after compaction",
		"native-flush",
		"managed-flush",
	]);

	restore();
	prototype.queueCompactionMessage!.call(host, "second", "followUp");
	await prototype.flushCompactionQueue!.call(host);
	assert.deepEqual(calls.slice(-2), ["native:followUp:second", "native-flush"]);
});

test("patchCompactionQueue delegates messages the managed queue rejects", () => {
	const calls: string[] = [];
	const prototype = {
		queueCompactionMessage(this: unknown, text: string, mode: "steer" | "followUp") {
			calls.push(`native:${mode}:${text}`);
		},
		async flushCompactionQueue() {},
	};
	const restore = patchCompactionQueue(prototype, () => false, () => calls.push("managed-flush"));

	assert.ok(restore);
	prototype.queueCompactionMessage!.call({ editor: { setText() {} } }, "overflow", "steer");
	assert.deepEqual(calls, ["native:steer:overflow"]);
	restore();
});

test("patchCompactionQueue flushes managed input when native flushing fails", async () => {
	let flushed = false;
	const prototype = {
		queueCompactionMessage() {},
		async flushCompactionQueue() {
			throw new Error("native failure");
		},
	};
	const restore = patchCompactionQueue(prototype, () => true, () => {
		flushed = true;
	});

	assert.ok(restore);
	await assert.rejects(() => prototype.flushCompactionQueue!.call({ editor: { setText() {} } }), /native failure/);
	assert.equal(flushed, true);
	restore();
});
