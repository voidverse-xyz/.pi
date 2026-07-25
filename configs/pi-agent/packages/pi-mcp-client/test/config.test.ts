import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_CALL_TIMEOUT_MS,
	DEFAULT_EAGER_SCHEMA_BYTES,
	DEFAULT_EAGER_TOOL_LIMIT,
	DEFAULT_STARTUP_TIMEOUT_MS,
	loadMcpConfig,
	resolveMcpConfigPath,
} from "../extensions/mcp-client/config.ts";

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-mcp-config-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("resolves the default and absolute override config paths", () => {
	assert.equal(resolveMcpConfigPath("/agent", undefined), join("/agent", "mcp.json"));
	assert.equal(resolveMcpConfigPath("/agent", "/config/custom.json"), "/config/custom.json");
	assert.throws(() => resolveMcpConfigPath("/agent", "relative.json"), /must be an absolute path/);
});

test("returns an inert configuration when mcp.json is absent", async () => {
	await withTempDirectory(async (directory) => {
		const path = join(directory, "missing.json");
		const config = await loadMcpConfig(path, directory);
		assert.equal(config.found, false);
		assert.deepEqual(config.servers, []);
		assert.equal(config.eagerToolLimit, DEFAULT_EAGER_TOOL_LIMIT);
		assert.equal(config.eagerSchemaBytes, DEFAULT_EAGER_SCHEMA_BYTES);
	});
});

test("loads bounded multi-server config and maps environment variable names", async () => {
	await withTempDirectory(async (directory) => {
		const path = join(directory, "mcp.json");
		await writeFile(path, JSON.stringify({
			version: 1,
			eagerToolLimit: 8,
			eagerSchemaBytes: 12_000,
			servers: {
				github: {
					command: "node",
					args: ["server.js"],
					cwd: directory,
					env: { GITHUB_TOKEN: "SOURCE_GITHUB_TOKEN" },
					confirm: "never",
					autoRestart: false,
					startupTimeoutMs: 3_000,
					callTimeoutMs: 4_000,
				},
				disabled: { enabled: false, command: "ignored" },
			},
		}));
		const config = await loadMcpConfig(path, directory);
		assert.equal(config.found, true);
		assert.equal(config.eagerToolLimit, 8);
		assert.equal(config.eagerSchemaBytes, 12_000);
		assert.deepEqual(config.warnings, []);
		assert.deepEqual(config.servers, [{
			id: "github",
			command: "node",
			args: ["server.js"],
			cwd: directory,
			env: { GITHUB_TOKEN: "SOURCE_GITHUB_TOKEN" },
			confirm: "never",
			autoRestart: false,
			startupTimeoutMs: 3_000,
			callTimeoutMs: 4_000,
		}]);
	});
});

test("fails closed on invalid roots and skips malformed servers", async () => {
	await withTempDirectory(async (directory) => {
		const invalidRoot = join(directory, "invalid-root.json");
		await writeFile(invalidRoot, JSON.stringify({ version: 2, servers: {} }));
		const rejected = await loadMcpConfig(invalidRoot, directory);
		assert.deepEqual(rejected.servers, []);
		assert.match(rejected.warnings.join("\n"), /version must be 1/);

		const malformedServers = join(directory, "malformed-servers.json");
		await writeFile(malformedServers, JSON.stringify({
			version: 1,
			servers: {
				"Bad Id": { command: "node" },
				relative: { command: "node", cwd: "relative" },
				literal_secret: { command: "node", env: { TOKEN: "not a valid source name!" } },
				defaults: { command: "node" },
			},
		}));
		const config = await loadMcpConfig(malformedServers, directory);
		assert.equal(config.servers.length, 1);
		assert.deepEqual(config.servers[0], {
			id: "defaults",
			command: "node",
			args: [],
			cwd: directory,
			env: {},
			confirm: "always",
			autoRestart: true,
			startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
			callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
		});
		assert.equal(config.warnings.length, 3);
	});
});

test("rejects malformed and oversized config files without throwing", async () => {
	await withTempDirectory(async (directory) => {
		const malformed = join(directory, "malformed.json");
		await writeFile(malformed, "{");
		assert.match((await loadMcpConfig(malformed, directory)).warnings[0]!, /not valid JSON/);

		const oversized = join(directory, "oversized.json");
		await writeFile(oversized, "x".repeat(256 * 1024 + 1));
		assert.match((await loadMcpConfig(oversized, directory)).warnings[0]!, /exceeds/);
	});
});
