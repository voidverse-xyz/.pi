import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const EXTENSION = join(PACKAGE_ROOT, "extensions", "mcp-client", "index.ts");
const SERVER_FIXTURE = join(HERE, "fixtures", "fake-mcp-server.mjs");
const INTROSPECT = join(HERE, "fixtures", "introspect-tools.ts");
const PI = "/opt/pi/pi";

function runRpc(eagerToolLimit) {
	const directory = mkdtempSync(join(tmpdir(), "pi-mcp-rpc-test-"));
	const configPath = join(directory, "mcp.json");
	const introspectionPath = join(directory, "tools.json");
	writeFileSync(configPath, JSON.stringify({
		version: 1,
		eagerToolLimit,
		servers: {
			fixture: {
				command: process.execPath,
				args: [SERVER_FIXTURE, "happy"],
				cwd: directory,
				confirm: "never",
			},
		},
	}));
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
		env: {
			...process.env,
			PI_MCP_CONFIG: configPath,
			PI_MCP_INTROSPECT_FILE: introspectionPath,
		},
		input: '{"id":"mcp-load","type":"get_state"}\n',
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
				&& record.id === "mcp-load"
				&& record.success === true
			),
			true,
		);
		return JSON.parse(readFileSync(introspectionPath, "utf8"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("registers configured MCP tools in the installed Pi runtime", { skip: !existsSync(PI) }, () => {
	const state = runRpc(24);
	const remoteTool = state.all.find((tool) => tool.name === "mcp_fixture_echo");
	assert.ok(remoteTool);
	assert.match(remoteTool.description, /untrusted external content/);
	assert.equal(remoteTool.parameters.type, "object");
	assert.equal(state.active.includes("mcp_fixture_echo"), true);
	assert.equal(state.active.includes("mcp_search_tools"), false);
	assert.equal(state.commands.includes("mcp"), true);
});

test("uses progressive discovery when the eager tool threshold is exceeded", { skip: !existsSync(PI) }, () => {
	const state = runRpc(0);
	assert.equal(state.active.includes("mcp_fixture_echo"), false);
	assert.equal(state.active.includes("mcp_search_tools"), true);
});
