#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "extensions", "config-alias-guard", "index.ts");

function findPiPackage() {
	const home = process.env.HOME ?? "";
	const candidates = [
		process.env.PI_SDK_DIR,
		join(home, ".local/lib/node_modules/@earendil-works/pi-coding-agent"),
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "dist", "cli.js"))) return candidate;
	}
	throw new Error("@earendil-works/pi-coding-agent not found; install Pi globally or set PI_SDK_DIR");
}

const PI_PACKAGE = findPiPackage();
const scratch = mkdtempSync(join(tmpdir(), "config-alias-guard-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const trustWarningPatch = Symbol.for("void-agent.config-alias-trust-warning-patch");
let interactiveModePrototype;
let originalWarningRenderer;
let forwardingWarningRenderer;

try {
	const agentDir = join(scratch, "agent");
	const aliasedCwd = join(scratch, "aliased-workspace");
	const ordinaryCwd = join(scratch, "ordinary-workspace");
	const missingCwd = join(scratch, "missing-config-workspace");
	mkdirSync(agentDir);
	mkdirSync(aliasedCwd);
	mkdirSync(join(ordinaryCwd, ".pi"), { recursive: true });
	mkdirSync(missingCwd);
	symlinkSync("..", join(aliasedCwd, ".pi"), "dir");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const { InteractiveMode } = await import(join(PI_PACKAGE, "dist", "modes", "interactive", "interactive-mode.js"));
	interactiveModePrototype = InteractiveMode.prototype;
	originalWarningRenderer = interactiveModePrototype.renderProjectTrustWarningIfNeeded;
	let forwardedWarnings = 0;
	forwardingWarningRenderer = () => {
		forwardedWarnings++;
	};
	interactiveModePrototype.renderProjectTrustWarningIfNeeded = forwardingWarningRenderer;

	const { loadExtensions } = await import(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js"));
	const loaded = await loadExtensions([EXTENSION], scratch);
	assert.deepEqual(loaded.errors, [], `extension load errors: ${JSON.stringify(loaded.errors)}`);
	assert.equal(loaded.extensions.length, 1, "exactly one extension loads");

	const handlers = loaded.extensions[0].handlers.get("project_trust") ?? [];
	assert.equal(handlers.length, 1, "one project_trust handler registers");
	const decide = (cwd) => handlers[0]({ type: "project_trust", cwd }, {});

	assert.deepEqual(await decide(aliasedCwd), { trusted: "no" }, "the global/project alias stays project-untrusted");
	assert.deepEqual(await decide(ordinaryCwd), { trusted: "undecided" }, "an unrelated project stays undecided");
	assert.deepEqual(await decide(missingCwd), { trusted: "undecided" }, "an inaccessible alias stays undecided");

	const patchedWarningRenderer = interactiveModePrototype.renderProjectTrustWarningIfNeeded;
	patchedWarningRenderer.call({ sessionManager: { getCwd: () => aliasedCwd } });
	assert.equal(forwardedWarnings, 0, "the misleading alias warning is suppressed");
	patchedWarningRenderer.call({ sessionManager: { getCwd: () => ordinaryCwd } });
	assert.equal(forwardedWarnings, 1, "unrelated project warnings still use Pi's renderer");

	for (const handler of loaded.extensions[0].handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown" }, {});
	}
	assert.equal(
		interactiveModePrototype.renderProjectTrustWarningIfNeeded,
		forwardingWarningRenderer,
		"private trust-warning renderer restores on shutdown",
	);

	console.log("config alias guard tests passed");
} finally {
	if (interactiveModePrototype && originalWarningRenderer) {
		interactiveModePrototype.renderProjectTrustWarningIfNeeded = originalWarningRenderer;
		delete interactiveModePrototype[trustWarningPatch];
	}
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(scratch, { recursive: true, force: true });
}
