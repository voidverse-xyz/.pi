import assert from "node:assert/strict";
import test from "node:test";
import { CONFIRM_CHANNEL, makeSafetyConfirm } from "./safety-bridge.ts";

const request = { agent: "test/agent#0", tool: "write" as const, path: "/tmp/out.txt" };

test("fails closed when no confirmation provider claims the request", async () => {
	const pi = { events: { emit: () => {} } };
	const result = await makeSafetyConfirm(pi as never)(request);
	assert.equal(result.approved, false);
	assert.match(result.note ?? "", /failing closed/);
});

test("forwards the request to a synchronous claimant", async () => {
	let channel = "";
	let seen: unknown;
	const pi = {
		events: {
			emit(name: string, payload: { claim: (fn: (value: typeof request) => { approved: boolean }) => void }) {
				channel = name;
				payload.claim((value) => {
					seen = value;
					return { approved: true };
				});
			},
		},
	};
	const result = await makeSafetyConfirm(pi as never)(request);
	assert.equal(channel, CONFIRM_CHANNEL);
	assert.deepEqual(seen, request);
	assert.deepEqual(result, { approved: true });
});

test("claimant failures are converted to fail-closed denials", async () => {
	const pi = {
		events: {
			emit(_name: string, payload: { claim: (fn: () => never) => void }) {
				payload.claim(() => {
					throw new Error("provider failed");
				});
			},
		},
	};
	const result = await makeSafetyConfirm(pi as never)(request);
	assert.equal(result.approved, false);
	assert.match(result.note ?? "", /provider failed/);
});
