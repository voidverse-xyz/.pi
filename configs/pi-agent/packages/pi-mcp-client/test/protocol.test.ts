import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "../extensions/mcp-client/config.ts";
import {
	buildMcpChildEnvironment,
	McpStdioClient,
} from "../extensions/mcp-client/protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "fake-mcp-server.mjs");

function serverConfig(mode: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		id: "fixture",
		command: process.execPath,
		args: [FIXTURE, mode],
		cwd: HERE,
		env: {},
		confirm: "never",
		autoRestart: true,
		startupTimeoutMs: 2_000,
		callTimeoutMs: 2_000,
		...overrides,
	};
}

async function waitForFile(path: string): Promise<string> {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			await access(path);
			return await readFile(path, "utf8");
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error("timed out waiting for fixture output");
}

test("connects, negotiates, lists tools, and calls a stdio MCP server", async () => {
	const client = new McpStdioClient({ config: serverConfig("happy") });
	try {
		await client.connect();
		assert.equal(client.connectionState, "ready");
		assert.equal(client.negotiatedProtocolVersion, "2025-11-25");
		assert.deepEqual(client.implementation, { name: "fake-mcp", version: "1.0.0" });
		const tools = await client.listTools();
		assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
		const result = await client.callTool("echo", { message: "hello" });
		assert.deepEqual(result, {
			content: [{ type: "text", text: "echo:hello" }],
			structuredContent: { echoed: "hello" },
			isError: false,
		});
	} finally {
		await client.close();
	}
	assert.equal(client.connectionState, "disconnected");
});

test("paginates tool discovery and answers server pings", async () => {
	const paginated = new McpStdioClient({ config: serverConfig("pagination") });
	const pinged = new McpStdioClient({ config: serverConfig("server-ping") });
	try {
		await paginated.connect();
		assert.deepEqual((await paginated.listTools()).map((tool) => tool.name), ["echo", "second"]);
		await pinged.connect();
		assert.deepEqual((await pinged.listTools()).map((tool) => tool.name), ["echo"]);
	} finally {
		await Promise.all([paginated.close(), pinged.close()]);
	}
});

test("rejects unsupported versions and malformed protocol records", async () => {
	const unsupported = new McpStdioClient({ config: serverConfig("unsupported-version") });
	await assert.rejects(unsupported.connect(), /unsupported protocol version/);
	await unsupported.close();

	const malformed = new McpStdioClient({ config: serverConfig("malformed-list") });
	try {
		await malformed.connect();
		await assert.rejects(malformed.listTools(), /malformed JSON-RPC|disconnected/);
	} finally {
		await malformed.close();
	}
});

test("sends cancellation after a tool timeout", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-mcp-client-test-"));
	const cancellationFile = join(directory, "cancelled");
	const client = new McpStdioClient({
		config: serverConfig("stall", {
			env: { CANCEL_FILE: "TEST_CANCEL_FILE" },
			callTimeoutMs: 80,
		}),
		environment: {
			...process.env,
			TEST_CANCEL_FILE: cancellationFile,
		},
	});
	try {
		await client.connect();
		await client.listTools();
		await assert.rejects(client.callTool("echo", { message: "wait" }), /timed out/);
		assert.match(await waitForFile(cancellationFile), /^\d+$/);
	} finally {
		await client.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("uses a minimal child environment plus explicit variable mappings", () => {
	const environment = buildMcpChildEnvironment(
		{ CHILD_TOKEN: "SOURCE_TOKEN" },
		{
			HOME: "/safe-home",
			PATH: "/safe-bin",
			SOURCE_TOKEN: "secret-value",
			UNRELATED_SECRET: "must-not-pass",
		},
	);
	assert.equal(environment.HOME, "/safe-home");
	assert.equal(environment.PATH, "/safe-bin");
	assert.equal(environment.CHILD_TOKEN, "secret-value");
	assert.equal(environment.UNRELATED_SECRET, undefined);
	assert.throws(
		() => buildMcpChildEnvironment({ REQUIRED: "MISSING" }, {}),
		/Required MCP environment variable MISSING is not set/,
	);
});

test("marks a server tool list stale when list_changed arrives", async () => {
	let changes = 0;
	const client = new McpStdioClient({
		config: serverConfig("list-changed"),
		onToolsChanged: () => changes++,
	});
	try {
		await client.connect();
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(changes, 1);
	} finally {
		await client.close();
	}
});
