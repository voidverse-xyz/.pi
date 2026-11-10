import assert from "node:assert/strict";
import test from "node:test";
import { ModeLifecycle } from "./mode-lifecycle.ts";

test("a busy mode change is selected immediately but keeps current-run enforcement", () => {
	const lifecycle = new ModeLifecycle("plan");

	assert.equal(lifecycle.startRun(), "plan");
	assert.equal(lifecycle.select("discuss"), true);
	assert.equal(lifecycle.selectedMode, "discuss");
	assert.equal(lifecycle.runMode, "plan");
	assert.equal(lifecycle.enforcedMode, "plan");
	assert.equal(lifecycle.hasPendingChange, true);
});

test("the latest busy selection becomes effective only after settlement", () => {
	const lifecycle = new ModeLifecycle("plan");
	lifecycle.startRun();

	lifecycle.select("discuss");
	lifecycle.select("quick");
	lifecycle.select("off");

	assert.equal(lifecycle.enforcedMode, "plan");
	lifecycle.settleRun();
	assert.equal(lifecycle.enforcedMode, "off");
	assert.equal(lifecycle.hasPendingChange, false);
	assert.equal(lifecycle.startRun(), "off");
});

test("an idle selection is the mode enforced by the next run", () => {
	const lifecycle = new ModeLifecycle("plan");

	assert.equal(lifecycle.select("quick"), true);
	assert.equal(lifecycle.enforcedMode, "quick");
	assert.equal(lifecycle.startRun(), "quick");
});

test("settling an older run does not clear a newer overlapping preflight snapshot", () => {
	const lifecycle = new ModeLifecycle("plan");
	lifecycle.startRun();
	lifecycle.select("discuss");
	lifecycle.startRun();

	lifecycle.settleRun();

	assert.equal(lifecycle.runMode, "discuss");
	assert.equal(lifecycle.enforcedMode, "discuss");
});

test("restoring branch state clears any ephemeral run snapshot", () => {
	const lifecycle = new ModeLifecycle("plan");
	lifecycle.startRun();
	lifecycle.select("off");

	lifecycle.restore("discuss");

	assert.equal(lifecycle.selectedMode, "discuss");
	assert.equal(lifecycle.runMode, undefined);
	assert.equal(lifecycle.enforcedMode, "discuss");
});
