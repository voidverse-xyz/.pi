import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "./config.ts";

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
	LATEST_PROTOCOL_VERSION,
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
	"2024-10-07",
]);
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOOL_PAGES = 100;
const MAX_TOOLS = 512;
const SHUTDOWN_GRACE_MS = 2_000;

const POSIX_INHERITED_ENV = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
const WINDOWS_INHERITED_ENV = [
	"APPDATA",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"PATH",
	"PROCESSOR_ARCHITECTURE",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"USERNAME",
	"USERPROFILE",
	"PROGRAMFILES",
];

export type McpConnectionState = "disconnected" | "connecting" | "ready" | "closing";

export interface McpServerInfo {
	name: string;
	version: string;
	title?: string;
}

export interface McpToolDefinition {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	execution?: { taskSupport?: "forbidden" | "optional" | "required" };
}

export interface McpCallToolResult {
	content?: unknown[];
	structuredContent?: unknown;
	isError?: boolean;
}

export interface McpStdioClientOptions {
	config: McpServerConfig;
	environment?: NodeJS.ProcessEnv;
	onStateChange?: (state: McpConnectionState) => void;
	onToolsChanged?: () => void;
}

interface JsonRpcError {
	code: number;
	message: string;
}

interface PendingRequest {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeMessage(value: unknown, fallback: string): string {
	if (typeof value !== "string" || !value.trim()) return fallback;
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 500);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		timer.unref();
	});
}

function processExited(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
	if (processExited(child)) return true;
	return Promise.race([
		new Promise<boolean>((resolve) => child.once("close", () => resolve(true))),
		delay(timeoutMs).then(() => false),
	]);
}

export function buildMcpChildEnvironment(
	mapping: Readonly<Record<string, string>>,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const output: NodeJS.ProcessEnv = {};
	const inherited = process.platform === "win32" ? WINDOWS_INHERITED_ENV : POSIX_INHERITED_ENV;
	for (const name of inherited) {
		const value = source[name];
		if (value === undefined || value.startsWith("()")) continue;
		output[name] = value;
	}
	for (const [childName, sourceName] of Object.entries(mapping)) {
		const value = source[sourceName];
		if (value === undefined) {
			throw new Error(`Required MCP environment variable ${sourceName} is not set`);
		}
		if (value.startsWith("()")) {
			throw new Error(`Required MCP environment variable ${sourceName} has an unsafe value`);
		}
		output[childName] = value;
	}
	return output;
}

export class McpProtocolError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "McpProtocolError";
		this.code = code;
	}
}

export class McpStdioClient {
	readonly config: McpServerConfig;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly onStateChange?: (state: McpConnectionState) => void;
	private readonly onToolsChanged?: () => void;
	private child?: ChildProcessWithoutNullStreams;
	private state: McpConnectionState = "disconnected";
	private connectPromise?: Promise<void>;
	private readBuffer = Buffer.alloc(0);
	private nextRequestId = 1;
	private pending = new Map<number, PendingRequest>();
	private disposed = false;
	private connectedOnce = false;
	private protocolVersion?: string;
	private serverInfo?: McpServerInfo;
	private serverCapabilities: Record<string, unknown> = {};
	private stderrBytes = 0;

	constructor(options: McpStdioClientOptions) {
		this.config = options.config;
		this.environment = options.environment ?? process.env;
		this.onStateChange = options.onStateChange;
		this.onToolsChanged = options.onToolsChanged;
	}

	get connectionState(): McpConnectionState {
		return this.state;
	}

	get negotiatedProtocolVersion(): string | undefined {
		return this.protocolVersion;
	}

	get implementation(): McpServerInfo | undefined {
		return this.serverInfo;
	}

	get capabilities(): Readonly<Record<string, unknown>> {
		return this.serverCapabilities;
	}

	get discardedStderrBytes(): number {
		return this.stderrBytes;
	}

	async connect(): Promise<void> {
		if (this.disposed) throw new Error(`MCP server ${this.config.id} is shut down`);
		if (this.state === "ready") return;
		if (this.connectPromise) return this.connectPromise;
		if (this.connectedOnce && !this.config.autoRestart) {
			throw new Error(`MCP server ${this.config.id} disconnected and automatic restart is disabled`);
		}

		this.connectPromise = this.startConnection();
		try {
			await this.connectPromise;
		} finally {
			this.connectPromise = undefined;
		}
	}

	private async startConnection(): Promise<void> {
		this.setState("connecting");
		this.readBuffer = Buffer.alloc(0);
		this.stderrBytes = 0;
		const env = buildMcpChildEnvironment(this.config.env, this.environment);
		const child = spawn(this.config.command, this.config.args, {
			cwd: this.config.cwd,
			env,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.installProcessHandlers(child);

		try {
			await new Promise<void>((resolve, reject) => {
				const onSpawn = () => {
					child.removeListener("error", onError);
					resolve();
				};
				const onError = (error: Error) => {
					child.removeListener("spawn", onSpawn);
					reject(error);
				};
				child.once("spawn", onSpawn);
				child.once("error", onError);
			});

			const initialized = await this.requestRaw(
				"initialize",
				{
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: {
						name: "pi-mcp-client",
						version: "1.0.0",
					},
				},
				this.config.startupTimeoutMs,
				undefined,
				false,
			);
			this.acceptInitializeResult(initialized);
			await this.sendNotification("notifications/initialized");
			this.connectedOnce = true;
			this.setState("ready");
		} catch (error) {
			await this.stopChild(child);
			if (this.child === child) this.child = undefined;
			this.rejectAllPending(new Error(`MCP server ${this.config.id} failed during startup`));
			this.setState("disconnected");
			throw error;
		}
	}

	private installProcessHandlers(child: ChildProcessWithoutNullStreams): void {
		child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		child.stdout.on("error", () => this.failConnection("stdout failed"));
		child.stdin.on("error", () => this.failConnection("stdin failed"));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrBytes += chunk.length;
		});
		child.on("error", () => this.failConnection("process failed"));
		child.on("close", (code, signal) => {
			if (this.child !== child) return;
			this.child = undefined;
			const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			this.rejectAllPending(new Error(`MCP server ${this.config.id} disconnected (${reason})`));
			if (this.state !== "closing") this.setState("disconnected");
		});
	}

	private setState(state: McpConnectionState): void {
		if (this.state === state) return;
		this.state = state;
		this.onStateChange?.(state);
	}

	private onStdout(chunk: Buffer): void {
		if (this.readBuffer.length + chunk.length > MAX_MESSAGE_BYTES) {
			this.failConnection(`message exceeded ${MAX_MESSAGE_BYTES} bytes`);
			return;
		}
		this.readBuffer = this.readBuffer.length === 0 ? chunk : Buffer.concat([this.readBuffer, chunk]);
		while (true) {
			const newline = this.readBuffer.indexOf(0x0a);
			if (newline < 0) return;
			const lineBuffer = this.readBuffer.subarray(0, newline);
			this.readBuffer = this.readBuffer.subarray(newline + 1);
			const line = lineBuffer.toString("utf8").replace(/\r$/, "");
			if (!line) {
				this.failConnection("emitted an empty protocol record");
				return;
			}
			try {
				this.handleMessage(JSON.parse(line));
			} catch {
				this.failConnection("emitted malformed JSON-RPC");
				return;
			}
		}
	}

	private handleMessage(value: unknown): void {
		if (!isRecord(value) || value.jsonrpc !== "2.0") {
			throw new Error("invalid JSON-RPC envelope");
		}
		if (value.id !== undefined && ("result" in value || "error" in value)) {
			this.handleResponse(value);
			return;
		}
		if (typeof value.method === "string" && value.id !== undefined) {
			this.handleServerRequest(value);
			return;
		}
		if (typeof value.method === "string" && value.id === undefined) {
			this.handleServerNotification(value.method, value.params);
			return;
		}
		throw new Error("unknown JSON-RPC message shape");
	}

	private handleResponse(value: Record<string, unknown>): void {
		if (typeof value.id !== "number") return;
		if ("error" in value) {
			const error = isRecord(value.error) ? value.error : {};
			const code = typeof error.code === "number" ? error.code : -32603;
			const message = safeMessage(error.message, "MCP request failed");
			this.settle(value.id, undefined, new McpProtocolError(code, message));
			return;
		}
		this.settle(value.id, value.result);
	}

	private handleServerRequest(value: Record<string, unknown>): void {
		if (value.method === "ping") {
			void this.writeMessage({ jsonrpc: "2.0", id: value.id, result: {} });
			return;
		}
		void this.writeMessage({
			jsonrpc: "2.0",
			id: value.id,
			error: { code: -32601, message: "Client method not supported" },
		});
	}

	private handleServerNotification(method: string, params: unknown): void {
		if (method === "notifications/tools/list_changed") {
			this.onToolsChanged?.();
			return;
		}
		if (method !== "notifications/cancelled" || !isRecord(params)) return;
		const requestId = params.requestId;
		if (typeof requestId !== "number") return;
		this.settle(requestId, undefined, new Error(`MCP server ${this.config.id} cancelled the request`));
	}

	private acceptInitializeResult(value: unknown): void {
		if (!isRecord(value)) throw new Error(`MCP server ${this.config.id} returned an invalid initialize result`);
		if (typeof value.protocolVersion !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.has(value.protocolVersion)) {
			throw new Error(`MCP server ${this.config.id} selected an unsupported protocol version`);
		}
		if (!isRecord(value.capabilities) || !isRecord(value.serverInfo)) {
			throw new Error(`MCP server ${this.config.id} returned incomplete initialization metadata`);
		}
		if (typeof value.serverInfo.name !== "string" || typeof value.serverInfo.version !== "string") {
			throw new Error(`MCP server ${this.config.id} returned invalid implementation metadata`);
		}
		this.protocolVersion = value.protocolVersion;
		this.serverCapabilities = value.capabilities;
		this.serverInfo = {
			name: safeMessage(value.serverInfo.name, this.config.id),
			version: safeMessage(value.serverInfo.version, "unknown"),
			...(typeof value.serverInfo.title === "string"
				? { title: safeMessage(value.serverInfo.title, value.serverInfo.name) }
				: {}),
		};
	}

	private async ensureReady(): Promise<void> {
		if (this.state !== "ready") await this.connect();
		if (this.state !== "ready") throw new Error(`MCP server ${this.config.id} is unavailable`);
	}

	async listTools(): Promise<McpToolDefinition[]> {
		await this.ensureReady();
		if (!isRecord(this.serverCapabilities.tools)) return [];
		const tools: McpToolDefinition[] = [];
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (let page = 0; page < MAX_TOOL_PAGES; page++) {
			const result = await this.requestRaw(
				"tools/list",
				cursor ? { cursor } : {},
				this.config.startupTimeoutMs,
			);
			if (!isRecord(result) || !Array.isArray(result.tools)) {
				throw new Error(`MCP server ${this.config.id} returned an invalid tool list`);
			}
			for (const tool of result.tools) {
				if (!isRecord(tool)) throw new Error(`MCP server ${this.config.id} returned an invalid tool definition`);
				tools.push(tool as unknown as McpToolDefinition);
				if (tools.length > MAX_TOOLS) {
					throw new Error(`MCP server ${this.config.id} exposed more than ${MAX_TOOLS} tools`);
				}
			}
			if (result.nextCursor === undefined) return tools;
			if (typeof result.nextCursor !== "string" || !result.nextCursor || seenCursors.has(result.nextCursor)) {
				throw new Error(`MCP server ${this.config.id} returned an invalid pagination cursor`);
			}
			cursor = result.nextCursor;
			seenCursors.add(cursor);
		}
		throw new Error(`MCP server ${this.config.id} exceeded ${MAX_TOOL_PAGES} tool-list pages`);
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallToolResult> {
		if (signal?.aborted) throw new Error(`MCP tools/call cancelled`);
		await this.ensureReady();
		const result = await this.requestRaw(
			"tools/call",
			{ name, arguments: args },
			this.config.callTimeoutMs,
			signal,
			true,
		);
		if (!isRecord(result)) throw new Error(`MCP server ${this.config.id} returned an invalid tool result`);
		if (result.content !== undefined && !Array.isArray(result.content)) {
			throw new Error(`MCP server ${this.config.id} returned invalid tool content`);
		}
		if (result.isError !== undefined && typeof result.isError !== "boolean") {
			throw new Error(`MCP server ${this.config.id} returned an invalid error marker`);
		}
		return result as McpCallToolResult;
	}

	private requestRaw(
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
		allowCancellation = true,
	): Promise<unknown> {
		if (!this.child?.stdin.writable) return Promise.reject(new Error(`MCP server ${this.config.id} is not connected`));
		if (signal?.aborted) return Promise.reject(new Error(`MCP ${method} cancelled`));
		const id = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (allowCancellation) void this.sendCancellation(id, `${method} timed out`);
				this.settle(id, undefined, new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();
			const pending: PendingRequest = { method, resolve, reject, timer, ...(signal ? { signal } : {}) };
			if (signal && allowCancellation) {
				pending.onAbort = () => {
					void this.sendCancellation(id, `${method} cancelled`);
					this.settle(id, undefined, new Error(`MCP ${method} cancelled`));
				};
				signal.addEventListener("abort", pending.onAbort, { once: true });
			}
			this.pending.set(id, pending);
			this.writeMessage({ jsonrpc: "2.0", id, method, params }).catch(() => {
				this.settle(id, undefined, new Error(`MCP ${method} could not be sent`));
			});
		});
	}

	private settle(id: number, result?: unknown, error?: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}
		if (error) pending.reject(error);
		else pending.resolve(result);
	}

	private rejectAllPending(error: Error): void {
		for (const id of [...this.pending.keys()]) this.settle(id, undefined, error);
	}

	private async sendCancellation(requestId: number, reason: string): Promise<void> {
		try {
			await this.sendNotification("notifications/cancelled", { requestId, reason });
		} catch {
			// Cancellation is best effort and the caller still stops waiting.
		}
	}

	private sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.writeMessage({
			jsonrpc: "2.0",
			method,
			...(params ? { params } : {}),
		});
	}

	private writeMessage(message: Record<string, unknown>): Promise<void> {
		const child = this.child;
		if (!child?.stdin.writable) return Promise.reject(new Error("MCP transport is closed"));
		const line = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
			return Promise.reject(new Error("MCP request exceeds the transport limit"));
		}
		return new Promise((resolve, reject) => {
			child.stdin.write(line, (error) => {
				if (error) reject(new Error("MCP request write failed"));
				else resolve();
			});
		});
	}

	private failConnection(reason: string): void {
		if (this.state === "closing" || this.disposed) return;
		this.rejectAllPending(new Error(`MCP server ${this.config.id} ${reason}`));
		this.setState("disconnected");
		const child = this.child;
		if (child) void this.stopChild(child);
	}

	private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
		if (processExited(child)) return;
		try {
			child.stdin.end();
		} catch {
			// Continue through the signal escalation path.
		}
		if (await waitForExit(child, SHUTDOWN_GRACE_MS)) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// Continue to the final check.
		}
		if (await waitForExit(child, SHUTDOWN_GRACE_MS)) return;
		try {
			child.kill("SIGKILL");
		} catch {
			// The process may already have exited.
		}
		await waitForExit(child, SHUTDOWN_GRACE_MS);
	}

	async close(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.setState("closing");
		this.rejectAllPending(new Error(`MCP server ${this.config.id} shut down`));
		const child = this.child;
		if (child) await this.stopChild(child);
		if (this.child === child) this.child = undefined;
		this.readBuffer = Buffer.alloc(0);
		this.setState("disconnected");
	}
}
