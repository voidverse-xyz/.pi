import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(new URL("./windows-output.py", import.meta.url));
const MAX_PROTOCOL_CHARS = 4_000;
const WSL_REQUIREMENT_ERROR = "Secure image output on Windows requires WSL with Python 3";
const WSL_PATH_TIMEOUT_MS = 15_000;
const OUTPUT_HELPER_TIMEOUT_MS = 60_000;
const OUTPUT_HELPER_TERMINATION_GRACE_MS = 5_000;

interface WindowsOutputRequest {
	action: "validate" | "save";
	root: string;
	segments: string[];
	requestedPath: string;
	overwrite: boolean;
	byteLength?: number;
}

interface PreparedWindowsOutputRequest {
	helperPath: string;
	request: WindowsOutputRequest;
	wslExecutable: string;
}

interface WindowsOutputRuntimeOptions {
	helperTimeoutMs?: number;
	terminationGraceMs?: number;
	execFile?: typeof execFileAsync;
	spawn?: typeof spawn;
	wslExecutable?: string;
}

type AccessFile = (path: string, mode?: number) => Promise<void>;

export function validateWindowsOutputPath(requestedPath: string): void {
	const cleaned = requestedPath.startsWith("@") ? requestedPath.slice(1).trim() : requestedPath.trim();
	if (isAbsolute(cleaned) || /^[a-z]:/i.test(cleaned) || /^[/\\]{2}/.test(cleaned)) {
		throw new Error("Image output paths must be relative on Windows");
	}
	const segments = cleaned.split(/[/\\]/);
	const reservedName = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
	if (segments.some((segment) => {
		return !segment
			|| segment === "."
			|| segment === ".."
			|| segment.includes(":")
			|| /[<>"|?*]/.test(segment)
			|| /[. ]$/.test(segment)
			|| /[\u0000-\u001f]/.test(segment)
			|| reservedName.test(segment);
	})) {
		throw new Error("Image output path contains a Windows-reserved or ambiguous component");
	}
}

export async function validateWindowsOutput(
	rootPath: string,
	absolutePath: string,
	requestedPath: string,
	overwrite: boolean,
	signal?: AbortSignal,
	runtimeOptions: WindowsOutputRuntimeOptions = {},
): Promise<void> {
	const prepared = await buildRequest(
		"validate",
		rootPath,
		absolutePath,
		requestedPath,
		overwrite,
		signal,
		runtimeOptions,
	);
	await runHelper(prepared, undefined, signal, runtimeOptions);
}

export async function saveWindowsOutput(
	rootPath: string,
	absolutePath: string,
	requestedPath: string,
	image: Buffer,
	overwrite: boolean,
	signal?: AbortSignal,
	runtimeOptions: WindowsOutputRuntimeOptions = {},
): Promise<void> {
	if (signal?.aborted) throw new Error("Codex image generation cancelled");
	const prepared = await buildRequest("save", rootPath, absolutePath, requestedPath, overwrite, signal, runtimeOptions);
	prepared.request.byteLength = image.length;
	await runHelper(prepared, image, signal, runtimeOptions);
}

async function buildRequest(
	action: WindowsOutputRequest["action"],
	rootPath: string,
	absolutePath: string,
	requestedPath: string,
	overwrite: boolean,
	signal?: AbortSignal,
	runtimeOptions: WindowsOutputRuntimeOptions = {},
): Promise<PreparedWindowsOutputRequest> {
	const pathWithinRoot = relative(rootPath, absolutePath);
	const segments = pathWithinRoot.split(sep).filter(Boolean);
	if (!pathWithinRoot || pathWithinRoot.startsWith("..") || segments.length === 0) {
		throw new Error("Output path must stay within the current working directory");
	}
	const wslExecutable = runtimeOptions.wslExecutable ?? await resolveWslExecutable();
	const [wslHelperPath, wslRootPath] = await convertToWslPaths(
		[helperPath, rootPath],
		wslExecutable,
		signal,
		runtimeOptions,
	);
	return {
		helperPath: wslHelperPath,
		request: {
			action,
			root: wslRootPath,
			segments,
			requestedPath,
			overwrite,
		},
		wslExecutable,
	};
}

async function convertToWslPaths(
	paths: string[],
	wslExecutable: string,
	signal: AbortSignal | undefined,
	runtimeOptions: WindowsOutputRuntimeOptions,
): Promise<string[]> {
	const cancellableSignal = typeof signal?.addEventListener === "function" ? signal : undefined;
	const execFileCommand = runtimeOptions.execFile ?? execFileAsync;
	return Promise.all(paths.map(async (path) => {
		let stdout: string;
		try {
			const wslCompatiblePath = path.replaceAll("\\", "/");
			({ stdout } = await execFileCommand(
				wslExecutable,
				["--exec", "wslpath", "-a", "-u", wslCompatiblePath],
				{
					encoding: "utf8",
					maxBuffer: 64 * 1024,
					signal: cancellableSignal,
					timeout: WSL_PATH_TIMEOUT_MS,
					windowsHide: true,
				},
			));
		} catch (error) {
			if (signal?.aborted) throw new Error("Codex image generation cancelled");
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(WSL_REQUIREMENT_ERROR);
			}
			throw new Error("WSL could not map the image output path");
		}
		const converted = stdout.trim();
		if (!converted || converted.includes("\n") || converted.includes("\r")) {
			throw new Error("WSL could not map the image output path");
		}
		return converted;
	}));
}

export async function resolveWslExecutable(
	source: NodeJS.ProcessEnv = process.env,
	accessFile: AccessFile = access,
): Promise<string> {
	const systemRoot = source.SystemRoot?.trim();
	const systemDrive = source.SystemDrive?.trim();
	if (!systemRoot || !systemDrive || !isSystemDrivePath(systemRoot, systemDrive)) {
		throw new Error(WSL_REQUIREMENT_ERROR);
	}

	const resolved = win32.join(systemRoot, "System32", "wsl.exe");
	try {
		await accessFile(resolved, fsConstants.X_OK);
	} catch {
		throw new Error(WSL_REQUIREMENT_ERROR);
	}
	return resolved;
}

function isSystemDrivePath(path: string, systemDrive: string): boolean {
	const parsed = win32.parse(path);
	if (!win32.isAbsolute(path) || !/^[a-z]:[\\/]$/i.test(parsed.root)) return false;
	if (!/^[a-z]:$/i.test(systemDrive) || parsed.root.slice(0, 2).toLowerCase() !== systemDrive.toLowerCase()) {
		return false;
	}
	return !path.slice(parsed.root.length).split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

async function runHelper(
	prepared: PreparedWindowsOutputRequest,
	image?: Buffer,
	signal?: AbortSignal,
	runtimeOptions: WindowsOutputRuntimeOptions = {},
): Promise<void> {
	const spawnChild = runtimeOptions.spawn ?? spawn;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawnChild(prepared.wslExecutable, ["--exec", "python3", prepared.helperPath], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		throw normalizeHelperStartError(error);
	}
	const closePromise = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, childSignal) => resolve([code, childSignal]));
	});
	let stdoutBuffer = "";
	let helperError: string | undefined;
	let inputWritten = false;
	let decisionSent = false;
	let commitAuthorized = false;
	let abortRequested = signal?.aborted ?? false;
	let helperTimedOut = false;
	let sawReady = false;
	let sawOk = false;
	let terminationTimer: ReturnType<typeof setTimeout> | undefined;
	const canListenForAbort = typeof signal?.addEventListener === "function";
	const helperTimeoutMs = Math.max(1, runtimeOptions.helperTimeoutMs ?? OUTPUT_HELPER_TIMEOUT_MS);
	const terminationGraceMs = Math.max(
		1,
		runtimeOptions.terminationGraceMs ?? OUTPUT_HELPER_TERMINATION_GRACE_MS,
	);

	const sendDecision = (decision: "CANCEL" | "COMMIT") => {
		if (decisionSent) return;
		decisionSent = true;
		commitAuthorized = decision === "COMMIT";
		child.stdin.end(`${decision}\n`);
	};
	const armTermination = () => {
		if (terminationTimer) return;
		terminationTimer = setTimeout(() => child.kill(), terminationGraceMs);
		terminationTimer.unref?.();
	};
	const requestCancellation = () => {
		if (commitAuthorized) return;
		abortRequested = true;
		if (inputWritten && image) sendDecision("CANCEL");
		armTermination();
	};
	const onAbort = () => requestCancellation();
	const operationTimer = setTimeout(() => {
		helperTimedOut = true;
		if (commitAuthorized) armTermination();
		else requestCancellation();
	}, helperTimeoutMs);
	operationTimer.unref?.();
	if (canListenForAbort) signal.addEventListener("abort", onAbort, { once: true });
	if (abortRequested) requestCancellation();

	child.stdin.on("error", () => {
		helperError ??= "Windows image-output helper input failed";
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer = `${stdoutBuffer}${chunk}`;
		if (stdoutBuffer.length > MAX_PROTOCOL_CHARS) {
			helperError = "Windows image-output helper emitted an oversized response";
			child.kill();
			return;
		}
		let newline = stdoutBuffer.indexOf("\n");
		while (newline !== -1) {
			const line = stdoutBuffer.slice(0, newline).trim();
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (line === "READY" && image) {
				sawReady = true;
				if (!decisionSent) sendDecision(abortRequested ? "CANCEL" : "COMMIT");
			} else if (line === "OK") {
				sawOk = true;
			} else if (line.startsWith("ERROR\t")) {
				helperError = line.slice("ERROR\t".length);
			}
			newline = stdoutBuffer.indexOf("\n");
		}
	});
	child.stderr.resume();

	try {
		try {
			await writeChunk(child, Buffer.from(`${JSON.stringify(prepared.request)}\n`, "utf8"));
			if (image) await writeChunk(child, image);
			inputWritten = true;
			if (image) {
				if (abortRequested && !decisionSent) sendDecision("CANCEL");
			} else {
				child.stdin.end();
			}
		} catch (error) {
			child.stdin.destroy();
			const startupError = await closePromise.then(
				() => undefined,
				(closeError) => normalizeHelperStartError(closeError),
			);
			if (abortRequested) throw new Error("Codex image generation cancelled");
			if (startupError) throw startupError;
			throw helperError ? new Error(helperError) : error;
		}

		let code: number | null;
		try {
			[code] = await closePromise;
		} catch (error) {
			throw normalizeHelperStartError(error);
		}
		if (helperTimedOut) throw new Error("Windows image-output helper timed out");
		if (abortRequested && !commitAuthorized) throw new Error("Codex image generation cancelled");
		if (helperError) throw new Error(helperError);
		if (code !== 0) throw new Error("Windows image-output helper failed");
		if (!sawOk || (image && !sawReady)) {
			throw new Error("Windows image-output helper returned an incomplete response");
		}
	} finally {
		clearTimeout(operationTimer);
		if (terminationTimer) clearTimeout(terminationTimer);
		if (canListenForAbort) signal.removeEventListener("abort", onAbort);
	}
}

function normalizeHelperStartError(error: unknown): Error {
	if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
		return new Error(WSL_REQUIREMENT_ERROR);
	}
	return new Error("Windows image-output helper failed to start");
}

async function writeChunk(child: ChildProcessWithoutNullStreams, chunk: Buffer): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		child.stdin.write(chunk, (error) => error ? reject(error) : resolve());
	});
}
