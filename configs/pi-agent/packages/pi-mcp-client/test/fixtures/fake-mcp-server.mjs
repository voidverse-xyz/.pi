import { writeFileSync } from "node:fs";

const mode = process.argv[2] || "happy";
let buffer = Buffer.alloc(0);

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolDefinitions() {
	const tools = [{
		name: "echo",
		title: "Echo",
		description: "Echo a message through the fake MCP server",
		inputSchema: {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: { echoed: { type: "string" } },
			required: ["echoed"],
		},
	}];
	if (mode === "required-task") {
		tools.push({
			name: "background_job",
			description: "Requires MCP tasks",
			inputSchema: { type: "object", additionalProperties: false },
			execution: { taskSupport: "required" },
		});
	}
	return tools;
}

function handle(message) {
	if (message.method === "initialize") {
		if (mode === "malformed-initialize") {
			process.stdout.write("not-json\n");
			return;
		}
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: mode === "unsupported-version" ? "1999-01-01" : "2025-11-25",
				capabilities: { tools: { listChanged: mode === "list-changed" } },
				serverInfo: { name: "fake-mcp", version: "1.0.0" },
				instructions: "This instruction must never be injected into Pi.",
			},
		});
		return;
	}
	if (message.method === "notifications/initialized") {
		if (mode === "server-ping") send({ jsonrpc: "2.0", id: "server-ping", method: "ping" });
		if (mode === "list-changed") {
			setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), 10).unref();
		}
		return;
	}
	if (message.method === "tools/list") {
		if (mode === "malformed-list") {
			process.stdout.write("{bad json}\n");
			return;
		}
		if (mode === "pagination" && !message.params?.cursor) {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: toolDefinitions(), nextCursor: "page-2" },
			});
			return;
		}
		const tools = mode === "pagination"
			? [{
				name: "second",
				description: "Second page tool",
				inputSchema: { type: "object", additionalProperties: false },
			}]
			: toolDefinitions();
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
		return;
	}
	if (message.method === "tools/call") {
		if (mode === "stall") return;
		if (message.params?.name === "fail") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { content: [{ type: "text", text: "Fake tool failure" }], isError: true },
			});
			return;
		}
		const echoed = String(message.params?.arguments?.message ?? "");
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				content: [{ type: "text", text: `echo:${echoed}` }],
				structuredContent: { echoed },
				isError: false,
			},
		});
		return;
	}
	if (message.method === "notifications/cancelled") {
		if (process.env.CANCEL_FILE) writeFileSync(process.env.CANCEL_FILE, String(message.params?.requestId ?? ""));
		return;
	}
	if (message.id !== undefined && message.result !== undefined) return;
	if (message.id !== undefined) {
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } });
	}
}

process.stdin.on("data", (chunk) => {
	buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
	while (true) {
		const newline = buffer.indexOf(0x0a);
		if (newline < 0) break;
		const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
		buffer = buffer.subarray(newline + 1);
		if (!line) continue;
		try {
			handle(JSON.parse(line));
		} catch {
			process.stdout.write("invalid fixture input\n");
		}
	}
});
process.stdin.on("end", () => process.exit(0));
