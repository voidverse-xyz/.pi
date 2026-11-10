import assert from "node:assert/strict";
import test from "node:test";
import { ModeBridge, type ModeSnapshot } from "./mode-bridge.ts";
import { ModeLifecycle } from "./mode-lifecycle.ts";

function fixture() {
	const lifecycle = new ModeLifecycle();
	const events: ModeSnapshot[] = [];
	const bridge = new ModeBridge(lifecycle, (snapshot) => events.push(snapshot), "instance-a");
	function query() {
		let result: ModeSnapshot | undefined;
		bridge.query({ version: 1, respond: (snapshot: ModeSnapshot) => { result = snapshot; } });
		assert.ok(result, "query responds synchronously");
		return result;
	}
	return { lifecycle, events, bridge, query };
}

test("query is synchronous, read-only, and unavailable until restore", () => {
	const { bridge, events, query } = fixture();
	const initial = query();
	assert.deepEqual(initial, {
		version: 1, instanceId: "instance-a", revision: 0, contextRevision: 0,
		ready: false, sessionId: null, selectedMode: "off", enforcedMode: "off",
		runMode: null, pendingChange: false,
	});
	assert.ok(Object.isFrozen(initial));
	assert.throws(() => { (initial as { ready: boolean }).ready = true; }, TypeError);
	assert.deepEqual(query(), initial);
	assert.deepEqual(events, []);
	bridge.restored("session-a");
	assert.equal(query().ready, true);
	assert.equal(query().sessionId, "session-a");
	assert.equal(query().revision, 1);
});

test("malformed and unsupported queries are ignored", () => {
	const { bridge, events, query } = fixture();
	let calls = 0;
	const respond = () => { calls += 1; };
	for (const request of [null, undefined, [], "request", { respond },
		{ version: 2, respond }, { version: "1", respond }, { version: 1, respond: true }]) {
		bridge.query(request);
	}
	assert.equal(calls, 0);
	assert.equal(query().revision, 0);
	assert.equal(events.length, 0);
});

test("busy selections expose both authorities until settlement", () => {
	const { lifecycle, bridge, query, events } = fixture();
	bridge.restored("session-a");
	lifecycle.startRun();
	bridge.publish();
	lifecycle.select("plan");
	bridge.publish();
	assert.equal(query().selectedMode, "plan");
	assert.equal(query().enforcedMode, "off");
	assert.equal(query().pendingChange, true);
	lifecycle.settleRun();
	bridge.publish();
	assert.equal(query().enforcedMode, "plan");
	assert.equal(query().runMode, null);
	lifecycle.startRun();
	bridge.publish();
	lifecycle.select("off");
	bridge.publish();
	assert.equal(query().selectedMode, "off");
	assert.equal(query().enforcedMode, "plan");
	assert.equal(query().pendingChange, true);
	assert.deepEqual(events.map((event) => event.revision), [1, 2, 3, 4, 5, 6]);
	assert.ok(events.every((event) => event.contextRevision === 1));
});

test("context epochs change on every restore and shutdown, not ordinary Off runs", () => {
	const { lifecycle, bridge, query, events } = fixture();
	bridge.restored("session-a");
	lifecycle.startRun();
	bridge.publish();
	lifecycle.settleRun();
	bridge.publish();
	bridge.publish();
	assert.equal(events.length, 3, "duplicate publication is silent");
	assert.equal(query().contextRevision, 1);
	lifecycle.restore("off");
	bridge.restored("session-a");
	assert.equal(query().contextRevision, 2);
	bridge.shutdown();
	assert.equal(query().contextRevision, 3);
	assert.equal(query().ready, false);
	bridge.restored("session-b");
	assert.equal(query().contextRevision, 4);
	assert.equal(query().sessionId, "session-b");
	assert.deepEqual(events.map((event) => event.revision), [1, 2, 3, 4, 5, 6]);
});

test("each default bridge instance has a distinct identity", () => {
	const identities: string[] = [];
	for (let i = 0; i < 2; i += 1) {
		const bridge = new ModeBridge(new ModeLifecycle(), () => {});
		bridge.query({ version: 1, respond: (snapshot: ModeSnapshot) => identities.push(snapshot.instanceId) });
	}
	assert.ok(identities.every(Boolean));
	assert.notEqual(identities[0], identities[1]);
});
