import test from "node:test";
import assert from "node:assert/strict";
import { createEmergencyInput } from "../extensions/swarm/emergency-input.mjs";

function fixture() {
	let enabled = true;
	let canCapture = true;
	let stops = 0;
	const pending = [];
	const input = createEmergencyInput({ enabled: () => enabled, canCapture: () => canCapture,
		stop: () => { stops++; }, pendingChanged: text => pending.push(text) });
	return { input, pending, stops: () => stops,
		enable: value => { enabled = value; }, capture: value => { canCapture = value; } };
}

test("literal emergency stop consumes only submission, preserving focused search and input", () => {
	const f = fixture();
	for (const character of "/swarm stop") assert.equal(f.input.handle(character), undefined);
	assert.equal(f.stops(), 0);
	assert.deepEqual(f.input.handle("\r"), { consume: true });
	assert.equal(f.stops(), 1);
	assert.equal(f.pending.at(-1), "");
});

test("handles terminal chunks and enhanced-protocol Enter", () => {
	for (const enter of ["\r", "\n", "\r\n", "\x1b[13u"]) {
		const f = fixture();
		f.input.handle("/swarm stop");
		assert.deepEqual(f.input.handle(enter), { consume: true });
		assert.equal(f.stops(), 1);
	}
	const f = fixture();
	assert.deepEqual(f.input.handle("/swarm stop\r"), { consume: true });
	assert.equal(f.stops(), 1);
});

test("search, other commands and ordinary text pass through intact without stopping", () => {
	const f = fixture();
	for (const data of ["plain text", "/sw", "itch", "/swarm stop now\r", "/swarm stop\rmore text"]) {
		assert.equal(f.input.handle(data), undefined);
	}
	assert.equal(f.input.handle("/"), undefined, "dashboard search must open on the first key");
	assert.equal(f.input.handle("query"), undefined);
	assert.equal(f.input.handle("\r"), undefined);
	assert.equal(f.stops(), 0);
});

test("Escape and backspace retain native behavior while cancelling or editing the prefix", () => {
	const f = fixture();
	f.input.handle("/swarm sto");
	assert.equal(f.input.handle("\x7f"), undefined);
	assert.equal(f.pending.at(-1), "/swarm st");
	f.input.handle("op"); f.input.handle("\r");
	assert.equal(f.stops(), 1);
	f.input.handle("/swarm stop");
	assert.equal(f.input.handle("\x1b"), undefined);
	assert.equal(f.input.handle("\r"), undefined);
	assert.equal(f.stops(), 1);
});

test("pasted commands need a separate physical Enter and multiline pastes pass through", () => {
	const f = fixture();
	assert.equal(f.input.handle("\x1b[200~/swarm stop\x1b[201~"), undefined);
	assert.equal(f.stops(), 0);
	f.input.handle("\r");
	assert.equal(f.stops(), 1);
	assert.equal(f.input.handle("\x1b[200~/swarm stop\nother text\x1b[201~"), undefined);
	assert.equal(f.stops(), 1);
});

test("inactive runs and existing drafts are not intercepted; disabling clears the observed prefix", () => {
	const f = fixture();
	f.capture(false);
	assert.equal(f.input.handle("/swarm stop\r"), undefined);
	f.capture(true); f.enable(false);
	assert.equal(f.input.handle("/swarm stop\r"), undefined);
	f.enable(true); f.input.handle("/sw"); f.enable(false);
	assert.equal(f.input.handle("x"), undefined);
	assert.equal(f.stops(), 0);
	f.input.reset();
	assert.equal(f.pending.at(-1), "");
});


test("enhanced key presses and releases preserve the exact stop command", () => {
	const f = fixture();
	for (const character of "/swarm stop") {
		const code = character.charCodeAt(0);
		assert.equal(f.input.handle(`\x1b[${code}u`), undefined);
		assert.equal(f.input.handle(`\x1b[${code};1:3u`), undefined);
	}
	assert.equal(f.stops(), 0);
	assert.deepEqual(f.input.handle("\x1b[13u"), { consume: true });
	assert.equal(f.stops(), 1);
});

test("fragmented paste with an embedded Enter never submits the stop command", () => {
	const f = fixture();
	for (const chunk of ["\x1b[200~", "/swarm", " stop\r", "\x1b[201~"]) assert.equal(f.input.handle(chunk), undefined);
	assert.equal(f.stops(), 0); assert.equal(f.input.handle("\r"), undefined);
	for (const chunk of ["\x1b[200~", "/swarm", " stop", "\x1b[201~"]) f.input.handle(chunk);
	assert.equal(f.stops(), 0);
	assert.deepEqual(f.input.handle("\r"), { consume: true }); assert.equal(f.stops(), 1);
});


test("release-looking bytes inside a fragmented paste remain paste data", () => {
	const f = fixture();
	for (const chunk of ["\x1b[200~", "/swarm", "\x1b[115;1:3u", " stop", "\x1b[201~", "\r"]) f.input.handle(chunk);
	assert.equal(f.stops(), 0);
});
