import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, readdirSync, readFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_PROMPT_CHARS = 10_000;
const MAX_INPUT_IMAGES = 4;
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_PROTOCOL_BUFFER_CHARS = 64 * 1024 * 1024;

const CLIENT_NAME = "pi_codex_image_generation";
const CLIENT_TITLE = "Pi Codex Image Generation";
const CLIENT_VERSION = "1.0.0";
const MINIMUM_CODEX_VERSION = [0, 146, 0] as const;

const IMAGE_BASE_INSTRUCTIONS = [
	"You are a dedicated image generation worker.",
	"Use Codex native image generation to create or edit exactly one image from the supplied prompt and optional attached images.",
	"Never use shell, file, web search, browser, computer, MCP, app, plugin, collaboration, or user-interaction tools.",
	"Do not inspect the working directory or request more information.",
].join(" ");

const IMAGE_DEVELOPER_INSTRUCTIONS = [
	"Call native image generation exactly once.",
	"Treat attached local images as source material for the requested edit when present.",
	"Preserve source-image content except where the prompt requests a change.",
	"Return no substitute text-only answer if image generation is unavailable.",
].join(" ");

const IMAGE_CONFIG_OVERRIDES = {
	web_search: "disabled",
	project_doc_max_bytes: 0,
	mcp_servers: {},
	plugins: {},
	"features.shell_tool": false,
	"features.unified_exec": false,
	"features.code_mode": false,
	"features.code_mode_only": false,
	"features.multi_agent": false,
	"features.multi_agent_v2": false,
	"features.browser_use": false,
	"features.computer_use": false,
	"features.in_app_browser": false,
	"features.image_generation": true,
	"features.apps": false,
	"features.plugins": false,
	"features.tool_search": false,
	"tools.experimental_request_user_input.enabled": false,
	"tools.update_plan.enabled": false,
} as const;

const DEFAULT_APP_SERVER_ARGS = [
	"app-server",
	"--stdio",
	"-c",
	"mcp_servers={}",
	"-c",
	"plugins={}",
	"-c",
	"features.apps=false",
	"-c",
	"features.plugins=false",
] as const;

const ALLOWED_IMAGE_ITEM_TYPES = new Set([
	"userMessage",
	"agentMessage",
	"reasoning",
	"imageGeneration",
	"contextCompaction",
]);

export interface GeneratedImage {
	data: string;
	mimeType: SupportedImageMimeType;
	byteLength: number;
	status: string;
	revisedPrompt?: string;
}

export interface RunCodexImageGenerationOptions {
	command?: string;
	appServerArgs?: string[];
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
	onProgress?: (message: string) => void;
}

type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

interface PreparedInputImage {
	dataUrl: string;
	mimeType: SupportedImageMimeType;
	byteLength: number;
}

interface JsonRpcMessage {
	id?: number | string;
	method?: string;
	params?: any;
	result?: any;
	error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

interface ImageGenerationItem {
	type: "imageGeneration";
	id?: string;
	status?: string;
	result?: string;
	revisedPrompt?: string | null;
	savedPath?: string | null;
}

interface TurnCollector {
	promise: Promise<GeneratedImage>;
	setTurnId(turnId: string): void;
	dispose(reason?: Error): void;
}

class CodexAppServerClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly readyPromise: Promise<void>;
	private readonly exitedPromise: Promise<Error>;
	private readonly processClosedPromise: Promise<void>;
	private readonly processGroupId?: number;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly notificationListeners = new Set<(message: JsonRpcMessage) => void>();
	private buffer = "";
	private stderrTail = "";
	private nextId = 1;
	private disposed = false;
	private resolveExited!: (error: Error) => void;
	private resolveProcessClosed!: () => void;

	constructor(command: string, args: string[], cwd: string, env?: Record<string, string | undefined>) {
		this.child = spawn(command, args, {
			cwd,
			env: env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		this.processGroupId = process.platform !== "win32" ? this.child.pid : undefined;

		this.readyPromise = new Promise((resolve, reject) => {
			this.child.once("spawn", resolve);
			this.child.once("error", (error) => reject(codexSpawnError(error)));
		});
		this.exitedPromise = new Promise((resolve) => {
			this.resolveExited = resolve;
		});
		this.processClosedPromise = new Promise((resolve) => {
			this.resolveProcessClosed = resolve;
		});

		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
		});
		this.child.stdin.on("error", (error) => this.fail(error));
		this.child.on("error", (error) => this.fail(codexSpawnError(error)));
		this.child.on("exit", (code, signal) => {
			if (this.disposed) return;
			this.fail(codexExitError(code, signal, this.stderrTail));
		});
		this.child.on("close", () => this.resolveProcessClosed());
	}

	async ready(): Promise<void> {
		await this.readyPromise;
	}

	exited(): Promise<Error> {
		return this.exitedPromise;
	}

	onNotification(listener: (message: JsonRpcMessage) => void): () => void {
		this.notificationListeners.add(listener);
		return () => this.notificationListeners.delete(listener);
	}

	async request(method: string, params: unknown): Promise<any> {
		await this.ready();
		if (this.disposed) throw new Error("Codex app-server is unavailable");
		const id = this.nextId++;
		const response = new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		try {
			await this.write({ method, id, params });
		} catch (error) {
			this.pending.delete(id);
			throw error;
		}
		return response;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.ready();
		await this.write(params === undefined ? { method } : { method, params });
	}

	dispose(reason = new Error("Codex app-server closed")): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const pending of this.pending.values()) pending.reject(reason);
		this.pending.clear();
		this.resolveExited(reason);
		this.child.stdin.end();
		this.terminate("SIGTERM");
	}

	async close(reason = new Error("Codex app-server closed")): Promise<void> {
		this.dispose(reason);
		const directChildClosed = await settlesWithin(this.processClosedPromise, 1_000);
		if (this.processGroupId && this.processGroupExists()) {
			this.terminate("SIGKILL");
			if (!await waitUntil(() => !this.processGroupExists(), 1_000)) {
				throw new Error("Could not terminate the Codex app-server process group");
			}
		}
		if (!directChildClosed && !await settlesWithin(this.processClosedPromise, 1_000)) {
			this.child.kill("SIGKILL");
			if (!await settlesWithin(this.processClosedPromise, 1_000)) {
				throw new Error("Could not terminate Codex app-server");
			}
		}
	}

	private terminate(signal: NodeJS.Signals): void {
		if (this.processGroupId) {
			try {
				process.kill(-this.processGroupId, signal);
				return;
			} catch {
				// Fall back to signaling the direct child below.
			}
		}
		this.child.kill(signal);
	}

	private processGroupExists(): boolean {
		if (!this.processGroupId) return false;
		if (process.platform === "linux") {
			try {
				for (const entry of readdirSync("/proc")) {
					if (!/^\d+$/.test(entry)) continue;
					let stat: string;
					try {
						stat = readFileSync(`/proc/${entry}/stat`, "utf8");
					} catch {
						continue;
					}
					const match = stat.match(/^\d+ \(.+\) ([A-Z]) \d+ (\d+) /);
					if (!match || Number(match[2]) !== this.processGroupId) continue;
					if (!new Set(["Z", "X"]).has(match[1]!)) return true;
				}
				return false;
			} catch {
				// Fall through to the portable process-group probe.
			}
		}
		try {
			process.kill(-this.processGroupId, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	}

	private async write(message: JsonRpcMessage): Promise<void> {
		const line = `${JSON.stringify(message)}\n`;
		await new Promise<void>((resolve, reject) => {
			this.child.stdin.write(line, (error) => error ? reject(error) : resolve());
		});
	}

	private handleStdout(chunk: string): void {
		this.buffer += chunk;
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			if (newlineIndex > MAX_PROTOCOL_BUFFER_CHARS) {
				this.fail(new Error("Codex app-server emitted an oversized protocol message"));
				return;
			}
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line) this.handleLine(line);
			if (this.disposed) return;
			newlineIndex = this.buffer.indexOf("\n");
		}
		if (this.buffer.length > MAX_PROTOCOL_BUFFER_CHARS) {
			this.fail(new Error("Codex app-server emitted an oversized protocol message"));
		}
	}

	private handleLine(line: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			this.fail(new Error("Codex app-server emitted malformed JSON"));
			return;
		}
		if (!message || typeof message !== "object") {
			this.fail(new Error("Codex app-server emitted an invalid JSON-RPC message"));
			return;
		}

		if (message.id !== undefined && message.method === undefined) {
			const numericId = typeof message.id === "number" ? message.id : Number(message.id);
			if (!Number.isSafeInteger(numericId)) {
				this.fail(new Error("Codex app-server emitted an invalid JSON-RPC id"));
				return;
			}
			const pending = this.pending.get(numericId);
			if (!pending) return;
			this.pending.delete(numericId);
			if (message.error) pending.reject(jsonRpcError(message.error));
			else pending.resolve(message.result);
			return;
		}

		if (message.id !== undefined && message.method) {
			this.respondToServerRequest(message).catch((error) => this.fail(error));
			return;
		}

		if (message.method) {
			for (const listener of this.notificationListeners) {
				try {
					listener(message);
				} catch (error) {
					this.fail(error);
					return;
				}
			}
			return;
		}
		this.fail(new Error("Codex app-server emitted an invalid JSON-RPC message"));
	}

	private async respondToServerRequest(message: JsonRpcMessage): Promise<void> {
		if (message.method?.includes("requestApproval")) {
			await this.write({ id: message.id, result: { decision: "decline" } });
		} else {
			await this.write({
				id: message.id,
				error: { code: -32601, message: "Unsupported request in image-generation-only session" },
			});
		}
		this.fail(new Error(`Codex attempted unsupported server request: ${message.method}`));
	}

	private fail(error: unknown): void {
		this.dispose(error instanceof Error ? error : new Error(String(error)));
	}
}

export async function runCodexImageGeneration(
	prompt: string,
	inputImagePaths: string[] = [],
	options: RunCodexImageGenerationOptions = {},
): Promise<GeneratedImage> {
	const normalizedPrompt = validatePrompt(prompt);
	validateInputImageCount(inputImagePaths);

	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	let tempRoot: string | undefined;
	let client: CodexAppServerClient | undefined;
	let collector: TurnCollector | undefined;
	let cancellationError: Error | undefined;
	let operationError: Error | undefined;

	const cancel = (error: Error) => {
		if (cancellationError) return;
		cancellationError = error;
		collector?.dispose(error);
		client?.dispose(error);
	};
	const onAbort = () => cancel(new Error("Codex image generation cancelled"));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	const timeout = setTimeout(
		() => cancel(new Error(`Codex image generation timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	timeout.unref?.();

	try {
		if (cancellationError) throw cancellationError;
		tempRoot = await mkdtemp(join(tmpdir(), "pi-codex-image-generation-"));
		const workDir = join(tempRoot, "work");
		await mkdir(workDir, { recursive: true });
		if (cancellationError) throw cancellationError;

		const preparedImages = await prepareInputImages(inputImagePaths);
		const command = options.command ?? (process.env.CODEX_BIN?.trim() || "codex");
		const appServerArgs = options.appServerArgs ?? [...DEFAULT_APP_SERVER_ARGS];
		const childEnvironment = options.env ?? buildCodexEnvironment(
			process.env,
			await prepareIsolatedCodexHome(process.env, tempRoot),
		);
		client = new CodexAppServerClient(command, appServerArgs, workDir, childEnvironment);
		if (cancellationError) {
			client.dispose(cancellationError);
			throw cancellationError;
		}

		await client.ready();
		const initializeResponse = await client.request("initialize", {
			clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: CLIENT_VERSION },
			capabilities: { experimentalApi: true },
		});
		requireCompatibleCodexVersion(initializeResponse?.userAgent);
		await client.notify("initialized");
		await requireChatGptLogin(client);
		await requireImageGenerationCapability(client);
		await requireCleanEffectiveCodexConfiguration(client, workDir);

		const threadResponse = await client.request("thread/start", {
			cwd: workDir,
			approvalPolicy: "never",
			sandbox: "read-only",
			ephemeral: true,
			environments: [],
			selectedCapabilityRoots: [],
			dynamicTools: [],
			serviceName: CLIENT_NAME,
			baseInstructions: IMAGE_BASE_INSTRUCTIONS,
			developerInstructions: IMAGE_DEVELOPER_INSTRUCTIONS,
			config: IMAGE_CONFIG_OVERRIDES,
		});
		const threadId = threadResponse?.thread?.id;
		if (typeof threadId !== "string" || !threadId) {
			throw new Error("Codex app-server returned no thread id");
		}
		if (!Array.isArray(threadResponse.instructionSources)) {
			throw new Error("Installed Codex does not report instruction sources; update Codex before using image generation.");
		}
		if (threadResponse.instructionSources.length > 0) {
			throw new Error("Codex image generation refused inherited instruction sources.");
		}

		collector = collectImageTurn(client, threadId, options.onProgress);
		const startPromise = client.request("turn/start", {
			threadId,
			input: imagePrompt(normalizedPrompt, preparedImages),
			environments: [],
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly", networkAccess: false },
		}).then((response) => {
			const turnId = response?.turn?.id;
			if (typeof turnId !== "string" || !turnId) {
				throw new Error("Codex app-server returned no turn id");
			}
			collector!.setTurnId(turnId);
		});

		const imageOutcome = Promise.all([collector.promise, startPromise]).then(
			([result]) => ({ kind: "result" as const, result }),
			(error) => ({ kind: "error" as const, error: errorFromUnknown(error) }),
		);
		const exitOutcome = client.exited().then(
			(error) => ({ kind: "error" as const, error }),
		);

		const outcome = await Promise.race([imageOutcome, exitOutcome]);
		if (outcome.kind === "error") throw outcome.error;
		if (cancellationError) throw cancellationError;
		return outcome.result;
	} catch (error) {
		operationError = cancellationError ?? normalizeClientError(error);
		throw operationError;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
		const closeReason = cancellationError ?? new Error("Codex image generation finished");
		collector?.dispose(closeReason);
		const cleanupErrors: Error[] = [];
		try {
			await client?.close(closeReason);
		} catch (error) {
			cleanupErrors.push(errorFromUnknown(error));
		}
		if (tempRoot) {
			try {
				await rm(tempRoot, { recursive: true, force: true });
			} catch (error) {
				cleanupErrors.push(errorFromUnknown(error));
			}
		}
		if (cleanupErrors.length > 0) {
			const errors = operationError ? [operationError, ...cleanupErrors] : cleanupErrors;
			const prefix = operationError ? `${operationError.message}; ` : "";
			throw new AggregateError(errors, `${prefix}Codex image-generation cleanup failed`);
		}
	}
}

function collectImageTurn(
	client: CodexAppServerClient,
	threadId: string,
	onProgress?: (message: string) => void,
): TurnCollector {
	let expectedTurnId: string | undefined;
	let completedImage: GeneratedImage | undefined;
	let lastAgentMessage: string | undefined;
	const completedItemIds = new Set<string>();
	let settled = false;
	let resolveResult!: (result: GeneratedImage) => void;
	let rejectResult!: (error: Error) => void;
	const promise = new Promise<GeneratedImage>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});

	const unsubscribe = client.onNotification((message) => {
		try {
			handleNotification(message);
		} catch (error) {
			finishWithError(errorFromUnknown(error));
		}
	});

	function handleNotification(message: JsonRpcMessage): void {
		if (!["item/started", "item/completed", "turn/completed"].includes(message.method ?? "")) return;
		const params = message.params ?? {};
		if (params.threadId !== threadId) {
			finishWithError(new Error("Codex emitted a turn event without the expected thread id"));
			return;
		}
		const eventTurnId = message.method === "turn/completed" ? params.turn?.id ?? params.turnId : params.turnId;
		if (typeof eventTurnId !== "string" || !eventTurnId) {
			finishWithError(new Error("Codex emitted a turn event without a turn id"));
			return;
		}
		if (expectedTurnId && eventTurnId !== expectedTurnId) {
			finishWithError(new Error("Codex emitted an event for an unexpected turn id"));
			return;
		}
		expectedTurnId ??= eventTurnId;

		if (message.method === "item/started" || message.method === "item/completed") {
			const item = params.item;
			if (!item || typeof item !== "object" || typeof item.type !== "string") {
				finishWithError(new Error("Codex emitted an invalid turn item"));
				return;
			}
			if (!ALLOWED_IMAGE_ITEM_TYPES.has(item.type)) {
				finishWithError(new Error(`Codex attempted forbidden non-image item: ${item.type}`));
				return;
			}
			if (message.method === "item/started") {
				if (item.type === "imageGeneration") onProgress?.("Generating image with Codex…");
				return;
			}
			if (typeof item.id !== "string" || !item.id) {
				finishWithError(new Error("Codex emitted a completed item without an item id"));
				return;
			}
			if (completedItemIds.has(item.id)) return;
			completedItemIds.add(item.id);
			if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
				lastAgentMessage = item.text.trim().slice(0, 1_000);
			}
			if (item.type === "imageGeneration") {
				if (completedImage) {
					finishWithError(new Error("Codex generated more than one image"));
					return;
				}
				completedImage = normalizeGeneratedImage(item as ImageGenerationItem);
				onProgress?.("Codex generated the image; finalizing output…");
			}
			return;
		}

		const turn = params.turn ?? {};
		if (turn.status !== "completed") {
			const reason = typeof turn.error?.message === "string" ? turn.error.message : `turn status ${String(turn.status)}`;
			finishWithError(new Error(`Codex image generation failed: ${reason}`));
			return;
		}
		if (!completedImage) {
			const detail = lastAgentMessage ? `: ${lastAgentMessage}` : "";
			finishWithError(new Error(`Codex completed without using native image generation${detail}`));
			return;
		}
		finishWithResult(completedImage);
	}

	function finishWithResult(result: GeneratedImage): void {
		if (settled) return;
		settled = true;
		unsubscribe();
		resolveResult(result);
	}

	function finishWithError(error: Error): void {
		if (settled) return;
		settled = true;
		unsubscribe();
		rejectResult(error);
	}

	return {
		promise,
		setTurnId(turnId: string) {
			if (!turnId || (expectedTurnId && expectedTurnId !== turnId)) {
				const error = new Error("Codex turn/start returned an unexpected turn id");
				finishWithError(error);
				throw error;
			}
			expectedTurnId = turnId;
		},
		dispose(reason = new Error("Codex image-generation collector closed")) {
			if (settled) return;
			settled = true;
			unsubscribe();
			rejectResult(reason);
		},
	};
}

async function prepareInputImages(paths: string[]): Promise<PreparedInputImage[]> {
	const prepared: PreparedInputImage[] = [];
	let totalBytes = 0;

	for (const sourcePath of paths) {
		const pathStats = await lstat(sourcePath).catch(() => undefined);
		if (pathStats?.isSymbolicLink()) throw new Error(`Input image cannot be a symbolic link: ${sourcePath}`);
		if (!pathStats?.isFile()) throw new Error(`Input image is not a regular file: ${sourcePath}`);

		const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
		const handle = await open(sourcePath, fsConstants.O_RDONLY | noFollow).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") {
				throw new Error(`Input image cannot be a symbolic link: ${sourcePath}`);
			}
			throw error;
		});
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) throw new Error(`Input image is not a regular file: ${sourcePath}`);
			if (pathStats.dev !== stats.dev || pathStats.ino !== stats.ino) {
				throw new Error(`Input image changed while it was being opened: ${sourcePath}`);
			}
			if (stats.size > MAX_INPUT_IMAGE_BYTES) {
				throw new Error(`Input image exceeds ${formatMiB(MAX_INPUT_IMAGE_BYTES)}: ${sourcePath}`);
			}
			const image = await readBoundedFile(handle, MAX_INPUT_IMAGE_BYTES, sourcePath);
			const finalStats = await handle.stat();
			if (image.length !== stats.size || finalStats.size !== stats.size || finalStats.mtimeMs !== stats.mtimeMs) {
				throw new Error(`Input image changed while it was being prepared: ${sourcePath}`);
			}
			totalBytes += image.length;
			if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
				throw new Error(`Input images exceed ${formatMiB(MAX_TOTAL_INPUT_BYTES)} in total`);
			}
			const mimeType = detectImageMimeType(image.subarray(0, 16));
			if (!mimeType) throw new Error(`Unsupported input image format: ${sourcePath}`);
			prepared.push({
				dataUrl: `data:${mimeType};base64,${image.toString("base64")}`,
				mimeType,
				byteLength: image.length,
			});
		} finally {
			await handle.close();
		}
	}
	return prepared;
}

async function readBoundedFile(handle: FileHandle, maximumBytes: number, sourcePath: string): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (totalBytes <= maximumBytes) {
		const remaining = maximumBytes + 1 - totalBytes;
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
		if (bytesRead === 0) break;
		chunks.push(buffer.subarray(0, bytesRead));
		totalBytes += bytesRead;
	}
	if (totalBytes > maximumBytes) {
		throw new Error(`Input image exceeds ${formatMiB(maximumBytes)}: ${sourcePath}`);
	}
	return Buffer.concat(chunks, totalBytes);
}

function imagePrompt(prompt: string, images: PreparedInputImage[]): any[] {
	const input: any[] = [{ type: "text", text: prompt, text_elements: [] }];
	for (const image of images) {
		input.push({ type: "image", detail: "original", url: image.dataUrl });
	}
	return input;
}

function normalizeGeneratedImage(item: ImageGenerationItem): GeneratedImage {
	if (item.status !== "completed") {
		throw new Error(`Codex image generation item finished with status ${String(item.status ?? "unknown")}`);
	}
	if (typeof item.result !== "string" || !item.result.trim()) {
		throw new Error("Codex image generation returned no image data");
	}
	const { data, declaredMimeType } = stripDataUrl(item.result.trim());
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) {
		throw new Error("Codex image generation returned invalid base64 data");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.length === 0) throw new Error("Codex image generation returned an empty image");
	if (bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
		throw new Error(`Generated image exceeds ${formatMiB(MAX_OUTPUT_IMAGE_BYTES)}`);
	}
	const mimeType = detectImageMimeType(bytes.subarray(0, 16));
	if (!mimeType) throw new Error("Codex image generation returned an unsupported image format");
	if (declaredMimeType && declaredMimeType !== mimeType) {
		throw new Error("Codex image generation returned mismatched image metadata");
	}
	return {
		data: bytes.toString("base64"),
		mimeType,
		byteLength: bytes.length,
		status: typeof item.status === "string" ? item.status : "completed",
		revisedPrompt: typeof item.revisedPrompt === "string" && item.revisedPrompt.trim()
			? item.revisedPrompt.trim().slice(0, MAX_PROMPT_CHARS)
			: undefined,
	};
}

function stripDataUrl(value: string): { data: string; declaredMimeType?: SupportedImageMimeType } {
	if (!value.startsWith("data:")) return { data: value.replace(/\s+/g, "") };
	const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/i);
	if (!match) throw new Error("Codex image generation returned an unsupported data URL");
	return {
		declaredMimeType: match[1]!.toLowerCase() as SupportedImageMimeType,
		data: match[2]!.replace(/\s+/g, ""),
	};
}

function detectImageMimeType(header: Uint8Array): SupportedImageMimeType | undefined {
	if (header.length >= 8 && Buffer.from(header.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		return "image/png";
	}
	if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
	if (header.length >= 12 && Buffer.from(header.subarray(0, 4)).toString("ascii") === "RIFF"
		&& Buffer.from(header.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
	if (header.length >= 6) {
		const signature = Buffer.from(header.subarray(0, 6)).toString("ascii");
		if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
	}
	return undefined;
}

function validatePrompt(prompt: string): string {
	const normalized = prompt.trim();
	if (!normalized) throw new Error("Image prompt cannot be empty");
	if (normalized.length > MAX_PROMPT_CHARS) {
		throw new Error(`Image prompt exceeds ${MAX_PROMPT_CHARS} characters`);
	}
	return normalized;
}

function validateInputImageCount(paths: string[]): void {
	if (paths.length > MAX_INPUT_IMAGES) {
		throw new Error(`Image generation accepts at most ${MAX_INPUT_IMAGES} input images`);
	}
}

const CODEX_RUNTIME_ENVIRONMENT_KEYS = [
	"PATH",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
] as const;

const ISOLATED_HOME_DIRECTORIES = {
	XDG_CONFIG_HOME: "xdg-config",
	XDG_DATA_HOME: "xdg-data",
	XDG_CACHE_HOME: "xdg-cache",
	XDG_STATE_HOME: "xdg-state",
	XDG_RUNTIME_DIR: "xdg-runtime",
	APPDATA: "app-data",
	LOCALAPPDATA: "local-app-data",
	TMPDIR: "tmp",
	TMP: "tmp",
	TEMP: "tmp",
} as const;

export function buildCodexEnvironment(
	source: NodeJS.ProcessEnv,
	codexHomeOverride?: string,
): Record<string, string | undefined> {
	const environment: Record<string, string | undefined> = {};
	for (const key of CODEX_RUNTIME_ENVIRONMENT_KEYS) {
		if (source[key] !== undefined) environment[key] = source[key];
	}
	const codexHome = codexHomeOverride ?? configuredCodexHome(source);
	if (!codexHome) return environment;

	environment.CODEX_HOME = codexHome;
	if (codexHomeOverride) {
		environment.HOME = codexHome;
		environment.USERPROFILE = codexHome;
		for (const [key, directory] of Object.entries(ISOLATED_HOME_DIRECTORIES)) {
			environment[key] = join(codexHome, directory);
		}
	} else if (source.HOME) {
		environment.HOME = source.HOME;
	}
	return environment;
}

export async function prepareIsolatedCodexHome(
	source: NodeJS.ProcessEnv,
	tempRoot: string,
): Promise<string> {
	const sourceHome = configuredCodexHome(source);
	if (!sourceHome) {
		throw new Error("Cannot locate the Codex login. Set HOME, USERPROFILE, CODEX_HOME, or PI_CODEX_IMAGE_HOME.");
	}
	const sourceAuthPath = join(sourceHome, "auth.json");
	const resolvedAuthPath = await realpath(sourceAuthPath).catch(() => undefined);
	if (!resolvedAuthPath || !(await lstat(resolvedAuthPath).catch(() => undefined))?.isFile()) {
		throw new Error("Codex image generation requires a ChatGPT Codex login. Run `codex login` first.");
	}

	const isolatedHome = join(tempRoot, "codex-home");
	await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
	await Promise.all(
		[...new Set(Object.values(ISOLATED_HOME_DIRECTORIES))].map((directory) => {
			return mkdir(join(isolatedHome, directory), { recursive: true, mode: 0o700 });
		}),
	);
	const isolatedAuthPath = join(isolatedHome, "auth.json");
	try {
		await symlink(resolvedAuthPath, isolatedAuthPath, "file");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (!["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(code ?? "")) throw error;
		await copyFile(resolvedAuthPath, isolatedAuthPath);
		await chmod(isolatedAuthPath, 0o600);
	}
	return isolatedHome;
}

function configuredCodexHome(source: NodeJS.ProcessEnv): string | undefined {
	const homeDirectory = source.HOME?.trim() || source.USERPROFILE?.trim();
	return source.PI_CODEX_IMAGE_HOME?.trim()
		|| source.CODEX_HOME?.trim()
		|| (homeDirectory ? join(homeDirectory, ".codex") : undefined);
}

async function requireChatGptLogin(client: CodexAppServerClient): Promise<void> {
	let authMode: string | undefined;
	try {
		const response = await client.request("account/read", { refreshToken: false });
		authMode = response?.account?.type;
	} catch (error) {
		if (!isMethodCompatibilityError(error)) throw error;
		const response = await client.request("getAuthStatus", { includeToken: false, refreshToken: false });
		authMode = response?.authMethod;
	}
	if (!["chatgpt", "chatgptAuthTokens"].includes(authMode ?? "")) {
		throw new Error("Codex image generation requires a ChatGPT Codex login. Run `codex login` first.");
	}
}

async function requireImageGenerationCapability(client: CodexAppServerClient): Promise<void> {
	let response: any;
	try {
		response = await client.request("modelProvider/capabilities/read", {});
	} catch (error) {
		if (isMethodCompatibilityError(error)) {
			throw new Error("Installed Codex does not expose image-generation capabilities; update Codex.");
		}
		throw error;
	}
	if (response?.imageGeneration !== true) {
		throw new Error("The active Codex model provider does not support image generation");
	}
}

async function requireCleanEffectiveCodexConfiguration(client: CodexAppServerClient, cwd: string): Promise<void> {
	let response: any;
	try {
		response = await client.request("config/read", { includeLayers: false, cwd });
	} catch {
		throw new Error("Installed Codex cannot verify isolated image-generation configuration; update Codex.");
	}
	if (!response?.config || typeof response.config !== "object") {
		throw new Error("Installed Codex returned no verifiable effective configuration; update Codex.");
	}
	const riskyPaths = new Set<string>();
	inspectConfigTree(response.config, "effective", riskyPaths);
	if (riskyPaths.size > 0) {
		throw new Error(`Codex image generation refused enabled external configuration: ${[...riskyPaths].join(", ")}`);
	}
}

const RISKY_CONFIG_KEYS = new Set([
	"mcpservers",
	"hooks",
	"plugins",
	"apps",
	"connectors",
	"skills",
	"instructions",
	"developerinstructions",
]);

function inspectConfigTree(value: unknown, path: string, riskyPaths: Set<string>): void {
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const childPath = `${path}.${key}`;
		const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
		if (RISKY_CONFIG_KEYS.has(normalizedKey) && isEnabledConfigValue(normalizedKey, child)) {
			riskyPaths.add(childPath);
		}
		inspectConfigTree(child, childPath, riskyPaths);
	}
}

function isEnabledConfigValue(key: string, value: unknown): boolean {
	if (value === null || value === undefined || value === false || value === "") return false;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value !== "object") return true;
	const object = value as Record<string, unknown>;
	const entries = Object.entries(object);
	if (entries.length === 0 || object.enabled === false) return false;
	if (key === "mcpservers") {
		return entries.some(([, server]) => {
			return !server || typeof server !== "object" || (server as Record<string, unknown>).enabled !== false;
		});
	}
	return true;
}

function requireCompatibleCodexVersion(userAgent: unknown): void {
	if (typeof userAgent !== "string") {
		throw new Error("Installed Codex did not report its version; update Codex before using image generation.");
	}
	const match = userAgent.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		throw new Error("Installed Codex reported an unrecognized version; update Codex before using image generation.");
	}
	const actual = match.slice(1, 4).map(Number);
	for (let index = 0; index < MINIMUM_CODEX_VERSION.length; index++) {
		if (actual[index]! > MINIMUM_CODEX_VERSION[index]!) return;
		if (actual[index]! < MINIMUM_CODEX_VERSION[index]!) {
			throw new Error("Codex image generation requires Codex 0.146.0 or newer.");
		}
	}
}

function formatMiB(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref?.();
		promise.then(() => finish(true), () => finish(true));
	});
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function jsonRpcError(error: NonNullable<JsonRpcMessage["error"]>): Error {
	const message = error.message || `JSON-RPC error ${String(error.code ?? "unknown")}`;
	return new Error(message);
}

function isMethodCompatibilityError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /method not found|unknown method|-32601/i.test(message);
}

function codexSpawnError(error: unknown): Error {
	const value = error as NodeJS.ErrnoException;
	if (value?.code === "ENOENT") {
		return new Error("Codex CLI was not found. Install `codex`, ensure it is on PATH, and run `codex login`.");
	}
	return new Error(`Could not start Codex app-server: ${value?.message ?? String(error)}`);
}

function codexExitError(code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
	if (/not logged in|login required|authentication|unauthorized/i.test(stderr)) {
		return new Error("Codex is not logged in. Run `codex login` first.");
	}
	const detail = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
	return new Error(`Codex app-server exited unexpectedly (${detail})`);
}

function normalizeClientError(error: unknown): Error {
	if (error instanceof Error) {
		if (/experimental|unknown field|invalid params|not supported/i.test(error.message)) {
			return new Error(`Installed Codex is incompatible with isolated image generation; update Codex. (${error.message})`);
		}
		return error;
	}
	return new Error(String(error));
}

export function mimeTypeForOutputExtension(path: string): SupportedImageMimeType | undefined {
	switch (extname(path).toLowerCase()) {
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return undefined;
	}
}
