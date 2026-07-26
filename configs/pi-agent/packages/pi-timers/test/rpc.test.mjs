import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const PACKAGES_ROOT = resolve(PACKAGE_ROOT, "..");
const EXTENSION = join(PACKAGE_ROOT, "extensions", "timers", "index.ts");
const INTROSPECT = join(HERE, "fixtures", "introspect-tools.ts");
const PI = "/opt/pi/pi";

function runRpc() {
	const directory = mkdtempSync(join(tmpdir(), "pi-timers-rpc-test-"));
	const introspectionPath = join(directory, "tools.json");
	const result = spawnSync(PI, [
		"--mode", "rpc",
		"--no-session",
		"--offline",
		"--no-extensions",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e", EXTENSION,
		"-e", INTROSPECT,
	], {
		cwd: PACKAGE_ROOT,
		env: { ...process.env, PI_TIMERS_INTROSPECT_FILE: introspectionPath },
		input: '{"id":"timers-load","type":"get_state"}\n',
		encoding: "utf8",
		timeout: 30_000,
	});
	try {
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(result.signal, null);
		const records = result.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		assert.equal(records.some((record) => record.type === "extension_error"), false);
		assert.equal(
			records.some((record) =>
				record.type === "response"
				&& record.command === "get_state"
				&& record.id === "timers-load"
				&& record.success === true
			),
			true,
		);
		return JSON.parse(readFileSync(introspectionPath, "utf8"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("registers the main-agent timer tool and command in the installed Pi runtime", { skip: !existsSync(PI) }, () => {
	const state = runRpc();
	const tool = state.all.find((candidate) => candidate.name === "manage_timers");
	assert.ok(tool);
	assert.match(tool.description, /main Pi agent/);
	assert.match(tool.description, /optional maxRuns limit/);
	assert.match(tool.description, /Subagents cannot use this tool/);
	assert.equal(tool.parameters.type, "object");
	assert.deepEqual(tool.parameters.required, ["action"]);
	assert.equal(tool.parameters.properties.intervalSeconds.minimum, 60);
	assert.equal(tool.parameters.properties.maxRuns.minimum, 1);
	assert.equal(Object.hasOwn(tool.parameters.properties.maxRuns, "maximum"), false);
	assert.equal(state.active.includes("manage_timers"), true);
	assert.equal(state.commands.includes("timers"), true);
});

test("in-process worker runtimes disable extensions and construct explicit tool allowlists", () => {
	const sources = [
		join(PACKAGES_ROOT, "pi-subagents", "extensions", "subagents", "runtime", "in-process.ts"),
		join(PACKAGES_ROOT, "pi-teams", "extensions", "teams", "runtime", "in-process.ts"),
		join(PACKAGES_ROOT, "pi-procedure", "extensions", "procedure", "runner", "agent-runner.ts"),
	].map((path) => readFileSync(path, "utf8"));
	for (const source of sources) {
		assert.match(source, /noExtensions:\s*true/);
		assert.match(source, /customTools:/);
		assert.doesNotMatch(source, /manage_timers/);
	}
});
