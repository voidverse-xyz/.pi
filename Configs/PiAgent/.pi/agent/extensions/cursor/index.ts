/**
 * Cursor provider for Pi.
 *
 * Supports:
 * - Host credentials from Cursor app / CLI login on this machine
 * - Cursor dashboard API keys
 *
 * Shows in /login under "Use a subscription".
 */

import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { createInterface } from "node:readline";
import * as path from "node:path";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
	TextContent,
} from "@earendil-works/pi-ai/compat";
import {
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "cursor";
const PROVIDER_NAME = "Cursor";
const HOST_SESSION_MARKER = "__cursor_host_session__";
const CURSOR_API_BASE = "https://api.cursor.com";
const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";
const CURSOR_AGENT_ENV = "CURSOR_AGENT_PATH";
const FALLBACK_AGENT = "agent";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 128_000;

const FALLBACK_MODELS: ProviderModelConfig[] = [
	{
		id: "composer-2.5",
		name: "Composer 2.5",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "claude-opus-4-8-thinking-high",
		name: "Opus 4.8 1M Thinking",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "gpt-5.3-codex",
		name: "Codex 5.3",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
];

interface AgentCommand {
	command: string;
	args: string[];
	shell: boolean;
	env?: NodeJS.ProcessEnv;
}

function latestCursorAgentVersionDir(versionsDir: string): string | undefined {
	if (!fs.existsSync(versionsDir)) {
		return undefined;
	}

	return fs
		.readdirSync(versionsDir)
		.filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}/.test(name))
		.sort((a, b) => b.localeCompare(a))[0];
}

function resolveAgentCommand(extraArgs: string[], apiKey?: string): AgentCommand {
	const override = process.env[CURSOR_AGENT_ENV] || process.env.AGENT_PATH;
	const args = apiKey ? [...extraArgs, "--api-key", apiKey] : extraArgs;

	if (override) {
		return {
			command: override,
			args,
			shell: process.platform === "win32",
		};
	}

	if (process.platform === "win32") {
		const agentRoot = path.join(process.env.LOCALAPPDATA ?? "", "cursor-agent");
		const versionName = latestCursorAgentVersionDir(path.join(agentRoot, "versions"));
		if (versionName) {
			const nodePath = path.join(agentRoot, "versions", versionName, "node.exe");
			const indexPath = path.join(agentRoot, "versions", versionName, "index.js");
			if (fs.existsSync(nodePath) && fs.existsSync(indexPath)) {
				return {
					command: nodePath,
					args: [indexPath, ...args],
					shell: false,
				};
			}
		}

		const cmdPath = path.join(agentRoot, "agent.cmd");
		if (fs.existsSync(cmdPath)) {
			return {
				command: cmdPath,
				args,
				shell: true,
			};
		}
	}

	return {
		command: FALLBACK_AGENT,
		args,
		shell: process.platform === "win32",
	};
}

function spawnAgent(
	extraArgs: string[],
	options: {
		apiKey?: string;
		cwd?: string;
		stdio?: SpawnOptions["stdio"];
		discovery?: boolean;
	},
) {
	const { command, args, shell } = resolveAgentCommand(extraArgs, options.apiKey);
	const env = { ...process.env };
	// Invalid CURSOR_API_KEY env vars break `agent models`; discovery uses CLI login instead.
	if (options.discovery) {
		delete env[CURSOR_API_KEY_ENV];
	}

	return spawn(command, args, {
		cwd: options.cwd,
		shell,
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
		env,
	});
}

function isHostSessionCredential(apiKey?: string): boolean {
	return apiKey === HOST_SESSION_MARKER;
}

async function runAgentCapture(args: string[], timeoutMs = 10_000): Promise<{
	stdout: string;
	stderr: string;
	code: number | null;
}> {
	return new Promise((resolve) => {
		const child = spawnAgent(args, { discovery: true });
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", () => resolve({ stdout, stderr, code: 1 }));
		child.on("close", (code) => resolve({ stdout, stderr, code }));

		setTimeout(() => {
			child.kill();
			resolve({ stdout, stderr, code: null });
		}, timeoutMs);
	});
}

async function getHostAuthStatus(): Promise<{ loggedIn: boolean; email?: string }> {
	const { stdout, code } = await runAgentCapture(["status"]);
	if (code !== 0) {
		return { loggedIn: false };
	}

	const match = stdout.match(/Logged in as\s+(.+)/i);
	return {
		loggedIn: !!match,
		email: match?.[1]?.trim(),
	};
}

function createHostSessionCredentials(email?: string): OAuthCredentials {
	return {
		access: HOST_SESSION_MARKER,
		refresh: HOST_SESSION_MARKER,
		expires: Date.now() + 24 * 60 * 60 * 1000,
		email,
	};
}

async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const choice = await callbacks.onSelect({
		message: "Choose Cursor authentication:",
		options: [
			{
				id: "host",
				label: "Cursor app / CLI login (this machine)",
			},
			{
				id: "apikey",
				label: "Cursor API key (dashboard)",
			},
		],
	});

	if (choice === "apikey") {
		const apiKey = (
			await callbacks.onPrompt({
				message: "Enter Cursor API key:",
				placeholder: "key_...",
			})
		).trim();
		if (!apiKey) {
			throw new Error("API key cannot be empty.");
		}
		return {
			access: apiKey,
			refresh: "",
			expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
		};
	}

	callbacks.onProgress?.("Checking Cursor app / CLI login on this machine...");
	const status = await getHostAuthStatus();
	if (!status.loggedIn) {
		throw new Error(
			"Cursor is not logged in on this machine. Sign into the Cursor app or run `agent login`, then try again.",
		);
	}

	const email = status.email ?? "local account";
	callbacks.onProgress?.(`Using host session for ${email}`);
	return createHostSessionCredentials(email);
}

async function refreshCursorToken(
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	if (!isHostSessionCredential(credentials.access)) {
		return credentials;
	}

	const status = await getHostAuthStatus();
	if (!status.loggedIn) {
		throw new Error(
			"Host Cursor session is no longer available. Sign into the Cursor app or run `agent login`.",
		);
	}

	return createHostSessionCredentials(status.email);
}

function getPiAuthPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

async function syncHostAuthToDisk(): Promise<void> {
	const authPath = getPiAuthPath();
	let data: Record<string, unknown> = {};

	if (fs.existsSync(authPath)) {
		try {
			data = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
		} catch {
			data = {};
		}
	}

	if (data[PROVIDER_ID]) {
		return;
	}

	const status = await getHostAuthStatus();
	if (!status.loggedIn) {
		return;
	}

	data[PROVIDER_ID] = {
		type: "oauth",
		...createHostSessionCredentials(status.email),
	};

	fs.mkdirSync(path.dirname(authPath), { recursive: true });
	fs.writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function resolveCursorAuth(apiKey?: string): Promise<{
	useHostSession: boolean;
	apiKey?: string;
}> {
	const trimmed = apiKey?.trim();
	if (trimmed && !isHostSessionCredential(trimmed)) {
		return { useHostSession: false, apiKey: trimmed };
	}

	const status = await getHostAuthStatus();
	if (!status.loggedIn) {
		throw new Error(
			`No Cursor credentials. Run /login and choose "${PROVIDER_NAME}", or sign into the Cursor app / run \`agent login\` on this machine.`,
		);
	}

	return { useHostSession: true };
}

function modelSupportsReasoning(id: string): boolean {
	return /thinking|codex/i.test(id);
}

function toText(content: string | (TextContent | { type: string; text?: string })[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function buildPrompt(context: Context): string {
	const sections: string[] = [];

	if (context.systemPrompt?.trim()) {
		sections.push(`System:\n${context.systemPrompt.trim()}`);
	}

	for (const message of context.messages) {
		sections.push(formatMessage(message));
	}

	return sections.join("\n\n");
}

function formatMessage(message: Message): string {
	if (message.role === "user") {
		return `User:\n${toText(message.content)}`;
	}

	if (message.role === "toolResult") {
		const status = message.isError ? "error" : "ok";
		return `Tool result (${message.toolName}, ${status}):\n${toText(message.content)}`;
	}

	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "thinking") {
			parts.push(`[thinking]\n${block.thinking}`);
		} else if (block.type === "toolCall") {
			parts.push(
				`[tool call ${block.name} ${JSON.stringify(block.arguments)}]`,
			);
		}
	}

	return `Assistant:\n${parts.join("\n")}`;
}

async function discoverModelsFromAgent(): Promise<ProviderModelConfig[]> {
	return new Promise((resolve) => {
		const child = spawnAgent(["models"], { discovery: true });

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", () => resolve([]));
		child.on("close", (code) => {
			if (code !== 0) {
				resolve([]);
				return;
			}

			const models: ProviderModelConfig[] = [];
			for (const line of stdout.split(/\r?\n/)) {
				const match = line.match(/^(\S+)\s+-\s+(.+)$/);
				if (!match) {
					continue;
				}

				const [, id, label] = match;
				models.push({
					id,
					name: label.replace(/\s+\((current|default)\)\s*$/i, "").trim(),
					reasoning: modelSupportsReasoning(id),
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: /1m/i.test(label) ? 1_000_000 : DEFAULT_CONTEXT_WINDOW,
					maxTokens: DEFAULT_MAX_TOKENS,
				});
			}

			resolve(models);
		});

		setTimeout(() => {
			child.kill();
			resolve([]);
		}, 15_000);
	});
}

async function discoverModelsFromApi(apiKey?: string): Promise<ProviderModelConfig[] | undefined> {
	if (!apiKey) {
		return undefined;
	}

	try {
		const auth = Buffer.from(`${apiKey}:`).toString("base64");
		const response = await fetch(`${CURSOR_API_BASE}/v1/models`, {
			headers: {
				Authorization: `Basic ${auth}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return undefined;
		}

		const payload = (await response.json()) as {
			items?: Array<{
				id: string;
				displayName?: string;
				variants?: Array<{ displayName?: string; isDefault?: boolean }>;
			}>;
		};

		if (!payload.items?.length) {
			return undefined;
		}

		return payload.items.map((item) => ({
			id: item.id,
			name: item.displayName ?? item.id,
			reasoning: modelSupportsReasoning(item.id),
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		}));
	} catch {
		return undefined;
	}
}

function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function extractAssistantText(event: {
	message?: { content?: Array<{ type?: string; text?: string }> };
}): string {
	const parts = event.message?.content ?? [];
	return parts
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("");
}

function streamCursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output = createEmptyAssistantMessage(model);

		try {
			const { useHostSession, apiKey: resolvedApiKey } =
				await resolveCursorAuth(options?.apiKey);

			const prompt = buildPrompt(context);
			if (!prompt.trim()) {
				throw new Error("No prompt content to send to Cursor.");
			}

			const child = spawnAgent(
				[
					"-p",
					prompt,
					"--model",
					model.id,
					"--output-format",
					"stream-json",
					"--stream-partial-output",
					"--trust",
				],
				{
					apiKey: useHostSession ? undefined : resolvedApiKey,
					cwd: options?.cwd,
				},
			);

			const abort = () => {
				if (!child.killed) {
					child.kill();
				}
			};
			options?.signal?.addEventListener("abort", abort, { once: true });

			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			stream.push({ type: "start", partial: output });

			let textStarted = false;
			let emittedText = "";
			let contentIndex = 0;

			const rl = createInterface({ input: child.stdout });
			for await (const line of rl) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}

				if (event.type === "assistant") {
					const text = extractAssistantText(
						event as { message?: { content?: Array<{ type?: string; text?: string }> } },
					);
					if (!text || text.length <= emittedText.length) {
						continue;
					}

					const delta = text.slice(emittedText.length);
					emittedText = text;

					if (!textStarted) {
						output.content.push({ type: "text", text: "" });
						contentIndex = output.content.length - 1;
						stream.push({
							type: "text_start",
							contentIndex,
							partial: output,
						});
						textStarted = true;
					}

					const textBlock = output.content[contentIndex];
					if (textBlock?.type === "text") {
						textBlock.text = emittedText;
					}

					stream.push({
						type: "text_delta",
						contentIndex,
						delta,
						partial: output,
					});
				}

				if (event.type === "result") {
					const usage = (event.usage ?? {}) as {
						inputTokens?: number;
						outputTokens?: number;
						cacheReadTokens?: number;
						cacheWriteTokens?: number;
					};
					output.usage.input = usage.inputTokens ?? 0;
					output.usage.output = usage.outputTokens ?? 0;
					output.usage.cacheRead = usage.cacheReadTokens ?? 0;
					output.usage.cacheWrite = usage.cacheWriteTokens ?? 0;
					output.usage.totalTokens =
						output.usage.input +
						output.usage.output +
						output.usage.cacheRead +
						output.usage.cacheWrite;
					calculateCost(model, output.usage);

					if (event.is_error) {
						throw new Error(
							typeof event.result === "string"
								? event.result
								: "Cursor agent returned an error.",
						);
					}
				}
			}

			await new Promise<void>((resolve, reject) => {
				child.on("error", reject);
				child.on("close", (code) => {
					if (code !== 0 && !options?.signal?.aborted) {
						reject(
							new Error(
								stderr.trim() ||
									`Cursor agent exited with code ${code ?? "unknown"}`,
							),
						);
						return;
					}
					resolve();
				});
			});

			options?.signal?.removeEventListener("abort", abort);

			if (!textStarted) {
				throw new Error("Cursor agent returned no assistant text.");
			}

			const textBlock = output.content[contentIndex];
			if (textBlock?.type === "text") {
				stream.push({
					type: "text_end",
					contentIndex,
					content: textBlock.text,
					partial: output,
				});
			}

			stream.push({
				type: "done",
				reason: "stop",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default async function (pi: ExtensionAPI) {
	await syncHostAuthToDisk();

	const agentModels = await discoverModelsFromAgent();
	const apiModels = await discoverModelsFromApi(process.env[CURSOR_API_KEY_ENV]);
	const models =
		agentModels.length > 0
			? agentModels
			: apiModels && apiModels.length > 0
				? apiModels
				: FALLBACK_MODELS;

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: CURSOR_API_BASE,
		apiKey: `$${CURSOR_API_KEY_ENV}`,
		api: "cursor-api",
		authHeader: true,
		models,
		oauth: {
			name: PROVIDER_NAME,
			login: loginCursor,
			refreshToken: refreshCursorToken,
			getApiKey: (credentials) => credentials.access,
		},
		streamSimple: streamCursor,
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.modelRegistry.authStorage.hasAuth(PROVIDER_ID)) {
			return;
		}

		const hostStatus = await getHostAuthStatus();
		if (!hostStatus.loggedIn) {
			return;
		}

		ctx.modelRegistry.authStorage.set(PROVIDER_ID, {
			type: "oauth",
			...createHostSessionCredentials(hostStatus.email),
		});
		ctx.modelRegistry.refresh();
	});
}
