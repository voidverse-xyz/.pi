import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import readline from "node:readline";

const mode = process.env.FAKE_CODEX_MODE || "success";
const requestLog = process.env.FAKE_REQUEST_LOG;
const childPidFile = process.env.FAKE_CHILD_PID_FILE;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";
const threadId = "thread-1";
const turnId = "turn-1";

if (mode === "stubborn-descendant") {
	const descendant = spawn(process.execPath, [
		"-e",
		"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
	], { stdio: "ignore" });
	if (childPidFile && descendant.pid) await writeFile(childPidFile, String(descendant.pid));
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
	if (!line.trim()) continue;
	const message = JSON.parse(line);
	if (requestLog) await appendFile(requestLog, `${JSON.stringify(message)}\n`);

	if (message.method === "initialize") {
		respond(message.id, { userAgent: mode === "old-version" ? "codex-cli/0.145.0" : "codex-cli/0.146.0" });
		continue;
	}
	if (message.method === "initialized") continue;
	if (message.method === "account/read") {
		respond(message.id, { account: { type: mode === "api-auth" ? "apiKey" : "chatgpt" } });
		continue;
	}
	if (message.method === "modelProvider/capabilities/read") {
		respond(message.id, { namespaceTools: true, imageGeneration: mode !== "capability-off", webSearch: false });
		continue;
	}
	if (message.method === "config/read") {
		respond(message.id, {
			config: mode === "risky-config"
				? { mcp_servers: { unsafe: { command: "bad" } } }
				: { mcp_servers: {}, plugins: {}, features: { apps: false, plugins: false } },
		});
		continue;
	}
	if (message.method === "thread/start") {
		respond(message.id, {
			thread: { id: threadId },
			instructionSources: mode === "instruction-source" ? [{ source: "AGENTS.md" }] : [],
		});
		continue;
	}
	if (message.method === "turn/start") {
		respond(message.id, { turn: { id: turnId } });
		if (mode === "hang") continue;
		if (mode === "server-request") {
			queueMicrotask(() => requestClient("item/tool/requestUserInput", {}));
			continue;
		}
		queueMicrotask(() => emitTurn());
		continue;
	}
	if (message.id !== undefined && message.method) {
		respond(message.id, {});
	}
}

function emitTurn() {
	if (mode === "wrong-thread") {
		notify("item/started", {
			threadId: "thread-other",
			turnId,
			item: { type: "imageGeneration", id: "image-1", status: "inProgress", result: "" },
		});
		return;
	}
	if (mode === "wrong-turn") {
		notify("item/started", {
			threadId,
			turnId: "turn-other",
			item: { type: "imageGeneration", id: "image-1", status: "inProgress", result: "" },
		});
		return;
	}
	if (mode === "forbidden-item") {
		notify("item/started", {
			threadId,
			turnId,
			item: { type: "commandExecution", id: "command-1" },
		});
		return;
	}
	if (mode !== "no-image") {
		emitImage("image-1");
		if (mode === "duplicate-image") emitImage("image-2");
	}
	notify("turn/completed", {
		threadId,
		turn: {
			id: turnId,
			status: mode === "failed-turn" ? "failed" : "completed",
			error: mode === "failed-turn" ? { message: "simulated failure" } : null,
		},
	});
}

function emitImage(id) {
	notify("item/started", {
		threadId,
		turnId,
		item: { type: "imageGeneration", id, status: "inProgress", result: "" },
	});
	notify("item/completed", {
		threadId,
		turnId,
		item: {
			type: "imageGeneration",
			id,
			status: mode === "failed-item" ? "failed" : "completed",
			result: mode === "bad-base64" ? "not!base64" : png,
			revisedPrompt: "A revised image prompt",
			savedPath: null,
		},
	});
}

function requestClient(method, params) {
	process.stdout.write(`${JSON.stringify({ id: 999, method, params })}\n`);
}

function respond(id, result) {
	process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method, params) {
	process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}
