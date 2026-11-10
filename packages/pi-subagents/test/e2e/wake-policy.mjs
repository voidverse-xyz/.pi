import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXT, jiti } from "./env.mjs";
const { createWakePump, persistedMailIds } = await jiti.import(join(EXT, "mail/wake-pump.ts"));

function fixture() {
	let now = 0, next = 0, idle = true, fail = false;
	const timers = new Map(), pending = [], injected = [], persisted = new Set();
	let snapshots = 0;
	const clock = {
		setTimeout(fn, delay) { const id = ++next; timers.set(id, { at: now + delay, fn }); return id; },
		clearTimeout(id) { timers.delete(id); },
	};
	const pump = createWakePump({
		hasMail: () => pending.length > 0,
		isIdle: () => idle,
		isPersisted: (ids) => ids.every((id) => persisted.has(id)),
		takeDigest() {
			snapshots++;
			const ids = [...pending];
			if (!ids.length) return null;
			return { digest: ids.join(","), envelopeIds: ids, begin() {}, commit() {
				for (const id of ids) { const at = pending.indexOf(id); if (at >= 0) pending.splice(at, 1); }
			} };
		},
		inject(digest, ids) { if (fail) throw Error("failed"); injected.push({ digest, ids }); pump.onMailArrived(); },
	}, clock);
	return { pump, pending, injected, persisted, timers, setIdle: (v) => idle = v, setFail: (v) => fail = v,
		get snapshots() { return snapshots; },
		tick(ms) {
			const end = now + ms;
			while (true) {
				const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]); now = due[1].at; due[1].fn();
			}
			now = end;
		},
	};
}

{
	const f = fixture(); f.pump.onSettled(); f.tick(250);
	assert.equal(f.timers.size, 0, "empty idle does not start a premature deadline");
	f.pending.push("a"); f.pump.onMailArrived();
	f.tick(100); f.pending.push("b"); f.pump.onMailArrived();
	f.tick(199); assert.equal(f.snapshots, 0); assert.equal(f.injected.length, 0);
	f.pending.push("c"); f.pump.onMailArrived(); f.tick(1);
	assert.equal(f.injected.length, 1); assert.equal(f.injected[0].digest, "a,b,c");
	assert.deepEqual(f.pending, ["a", "b", "c"], "void injection cannot commit");
	f.pump.onMailArrived(); f.tick(1000); assert.equal(f.injected.length, 1, "in-flight guard");
	for (const id of ["a", "b", "c"]) f.persisted.add(id);
	f.pending.push("d"); f.pump.onPersistence(); assert.deepEqual(f.pending, ["d"]);
	f.pump.onSettled(); f.tick(300); assert.equal(f.injected[1].digest, "d", "mail during injection survives");
	f.pump.shutdown();
}
for (const event of ["onInput", "onBeforeAgentStart", "shutdown"]) {
	const f = fixture(); f.pending.push("a"); f.pump.onSettled(); f.tick(299); f.pump[event](); f.tick(1);
	assert.equal(f.injected.length, 0, event); assert.equal(f.timers.size, 0); assert.deepEqual(f.pending, ["a"]);
	if (event !== "shutdown") { f.pump.onSettled(); f.tick(300); assert.equal(f.injected.length, 1); }
	f.pump.shutdown();
}
{
	const f = fixture(); f.pending.push("a"); f.pump.onSettled(); f.setIdle(false); f.tick(300);
	assert.equal(f.snapshots, 0, "actual idle recheck before snapshot"); f.setIdle(true); f.pump.onSettled(); f.tick(300);
	assert.equal(f.injected.length, 1); f.pump.shutdown();
}
{
	const f = fixture(); f.pending.push("a"); f.setFail(true); f.pump.onSettled(); f.tick(300);
	assert.deepEqual(f.pending, ["a"]); f.tick(3000); assert.equal(f.snapshots, 1, "failure never hot loops");
	f.setFail(false); f.pump.onMailArrived(); f.tick(300); assert.equal(f.injected.length, 1);
	f.pump.onSettled(); f.tick(3000); assert.equal(f.injected.length, 1, "unacknowledged run retains mail without hot loop");
	f.pump.onMailArrived(); f.tick(300); assert.equal(f.injected.length, 2, "redelivery after failed run");
	f.persisted.add("a"); f.pump.onSettled(); f.tick(300); assert.equal(f.injected.length, 2, "persisted inference failure never duplicates");
	f.pump.shutdown();
}
{
	const f = fixture(); f.pending.push("a"); f.pump.onSettled(); f.tick(300); f.pump.shutdown();
	f.persisted.add("a"); f.pump.onPersistence(); f.pump.onSettled(); f.tick(1000);
	assert.deepEqual(f.pending, ["a"], "shutdown leaves uncommitted mail for recovery");
	assert.equal(f.injected.length, 1);
}
assert.deepEqual([...persistedMailIds([
	{ type: "custom_message", customType: "mail", details: { envelopeIds: ["a", "b"] } },
	{ type: "custom_message", customType: "other", details: { envelopeIds: ["c"] } },
], "mail")], ["a", "b"]);
console.log("  ok  deterministic wake policy: debounce, no starvation, races, shutdown, failure and acknowledgement");
