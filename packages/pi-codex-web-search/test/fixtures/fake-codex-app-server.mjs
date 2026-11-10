import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_CODEX_MODE ?? "success";
if (process.env.FAKE_CODEX_PID_FILE) writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));
const input = createInterface({ input: process.stdin });

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
	send({ id, result: value });
}

function error(id, message, code = -32602) {
	send({ id, error: { code, message } });
}

input.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "initialized") return;

	if (message.method === "initialize") {
		result(message.id, {
			userAgent: mode === "old-version" ? "fake-codex/0.144.0" : "fake-codex/0.145.0",
			codexHome: "/tmp/fake-codex-home",
			platformFamily: "unix",
			platformOs: "linux",
		});
		return;
	}

	if (message.method === "account/read") {
		const accountType = mode === "personal-access-token" ? "personalAccessToken" : "chatgpt";
		result(message.id, {
			account: mode === "logged-out" ? null : { type: accountType, planType: "pro" },
			requiresOpenaiAuth: true,
		});
		return;
	}

	if (message.method === "config/read") {
		const config = mode === "risky-config"
			? { mcp_servers: { local: { command: "unsafe-server" } } }
			: {};
		result(message.id, {
			config,
			origins: {},
			layers: mode === "risky-config" ? [{ name: "user", version: "1", config }] : [],
		});
		return;
	}

	if (message.method === "thread/start") {
		const params = message.params ?? {};
		const isolated = params.ephemeral === true
			&& params.sandbox === "read-only"
			&& params.approvalPolicy === "never"
			&& Array.isArray(params.environments)
			&& params.environments.length === 0
			&& Array.isArray(params.selectedCapabilityRoots)
			&& params.selectedCapabilityRoots.length === 0
			&& params.config?.web_search === "live"
			&& params.config?.project_doc_max_bytes === 0;
		if (!isolated) {
			error(message.id, "thread was not isolated");
			return;
		}
		result(message.id, {
			thread: { id: "thread-1", path: null, ephemeral: true, turns: [] },
			instructionSources: mode === "inherited-instructions" ? ["/tmp/global/AGENTS.md"] : [],
		});
		return;
	}

	if (message.method === "turn/start") {
		const params = message.params ?? {};
		const isolated = params.threadId === "thread-1"
			&& params.approvalPolicy === "never"
			&& params.sandboxPolicy?.type === "readOnly"
			&& params.sandboxPolicy?.networkAccess === false
			&& Array.isArray(params.environments)
			&& params.environments.length === 0;
		if (!isolated) {
			error(message.id, "turn was not isolated");
			return;
		}
		if (mode === "early-forbidden") {
			emitItemStarted("commandExecution");
			return;
		}
		if (mode === "early-success" || mode === "early-success-wrong-start") {
			emitSuccessfulTurn("success");
			setTimeout(() => {
				result(message.id, {
					turn: {
						id: mode === "early-success" ? "turn-1" : "turn-other",
						status: "inProgress",
						items: [],
					},
				});
			}, 20);
			return;
		}
		if (mode === "server-request") {
			send({
				id: "approval-1",
				method: "item/permissions/requestApproval",
				params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
			});
			return;
		}
		if (mode === "malformed-json") {
			process.stdout.write("{not-json}\n");
			return;
		}
		if (mode === "oversized-json") {
			process.stdout.write(`${"x".repeat(2 * 1024 * 1024 + 1)}\n`);
			return;
		}

		result(message.id, {
			turn: { id: "turn-1", status: "inProgress", items: [] },
		});

		if (mode === "hang" || mode === "stubborn-hang") return;
		if (mode === "forbidden") {
			emitItemStarted("commandExecution");
			return;
		}
		const forbiddenItems = {
			"unknown-item": "futureExecutableTool",
			"collab-item": "collabAgentToolCall",
			"dynamic-item": "dynamicToolCall",
			"image-item": "imageGeneration",
			"sleep-item": "sleep",
		};
		if (forbiddenItems[mode]) {
			emitItemStarted(forbiddenItems[mode]);
			return;
		}
		if (mode === "wrong-turn") {
			emitItemStarted("webSearch", "turn-other");
			return;
		}
		if (mode === "missing-thread") {
			send({
				method: "item/started",
				params: { turnId: "turn-1", item: { id: "search-1", type: "webSearch" } },
			});
			return;
		}
		if (mode === "no-search") {
			emitAnswerAndCompletion(JSON.stringify({
				answer: "An unsupported answer.",
				sources: [{ title: "Source", url: "https://example.com/source" }],
			}));
			return;
		}

		queueMicrotask(() => emitSuccessfulTurn(mode));
		return;
	}

	if (message.method === "turn/interrupt") {
		result(message.id, {});
		return;
	}

	if (message.id !== undefined) error(message.id, "Method not found", -32601);
});

function emitItemStarted(type, turnId = "turn-1") {
	send({
		method: "item/started",
		params: {
			threadId: "thread-1",
			turnId,
			item: { id: "item-1", type, status: "inProgress" },
		},
	});
}

function emitSuccessfulTurn(selectedMode) {
	emitItemStarted("webSearch");
	const results = selectedMode === "no-source" ? [] : [
		{ type: "web", title: "Primary source", url: "https://example.com/primary", snippet: "Primary evidence" },
		{ type: "web", title: "Duplicate", url: "https://example.com/primary" },
	];
	send({
		method: "item/completed",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			item: { id: "search-1", type: "webSearch", query: "current answer", results },
		},
	});

	let answerText;
	if (selectedMode === "plain") {
		answerText = "A plain fallback answer with [another source](https://example.org/secondary).";
	} else if (selectedMode === "whitespace-answer") {
		answerText = JSON.stringify({ answer: "   ", sources: results });
	} else if (selectedMode === "no-source") {
		answerText = JSON.stringify({ answer: "An answer without citations.", sources: [] });
	} else {
		answerText = JSON.stringify({
			answer: "The current answer is supported by the [primary source](https://example.com/primary).",
			sources: [
				{ title: "Primary source", url: "https://example.com/primary" },
				{ title: "Secondary source", url: "https://example.org/secondary" },
			],
		});
	}
	emitAnswerAndCompletion(answerText);
}

function emitAnswerAndCompletion(answerText) {
	send({
		method: "item/completed",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			item: { id: "answer-1", type: "agentMessage", text: answerText },
		},
	});
	send({
		method: "turn/completed",
		params: {
			threadId: "thread-1",
			turn: {
				id: "turn-1",
				status: "completed",
				items: [{ id: "answer-1", type: "agentMessage", text: answerText }],
			},
		},
	});
}

process.on("SIGTERM", () => {
	if (mode !== "stubborn-hang") process.exit(0);
});
