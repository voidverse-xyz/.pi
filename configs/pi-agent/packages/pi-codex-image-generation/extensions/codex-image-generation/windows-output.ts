import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(new URL("./windows-output.py", import.meta.url));
const MAX_PROTOCOL_CHARS = 4_000;
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
}

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
): Promise<void> {
	const prepared = await buildRequest("validate", rootPath, absolutePath, requestedPath, overwrite);
	await runHelper(prepared);
}

export async function saveWindowsOutput(
	rootPath: string,
	absolutePath: string,
	requestedPath: string,
	image: Buffer,
	overwrite: boolean,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw new Error("Codex image generation cancelled");
	const prepared = await buildRequest("save", rootPath, absolutePath, requestedPath, overwrite, signal);
	prepared.request.byteLength = image.length;
	await runHelper(prepared, image, signal);
}

async function buildRequest(
	action: WindowsOutputRequest["action"],
	rootPath: string,
	absolutePath: string,
	requestedPath: string,
	overwrite: boolean,
	signal?: AbortSignal,
): Promise<PreparedWindowsOutputRequest> {
	const pathWithinRoot = relative(rootPath, absolutePath);
	const segments = pathWithinRoot.split(sep).filter(Boolean);
	if (!pathWithinRoot || pathWithinRoot.startsWith("..") || segments.length === 0) {
		throw new Error("Output path must stay within the current working directory");
	}
	const [wslHelperPath, wslRootPath] = await convertToWslPaths([helperPath, rootPath], signal);
	return {
		helperPath: wslHelperPath,
		request: {
			action,
			root: wslRootPath,
			segments,
			requestedPath,
			overwrite,
		},
	};
}

async function convertToWslPaths(paths: string[], signal?: AbortSignal): Promise<string[]> {
	const cancellableSignal = typeof signal?.addEventListener === "function" ? signal : undefined;
	return Promise.all(paths.map(async (path) => {
		let stdout: string;
		try {
			const wslCompatiblePath = path.replaceAll("\\", "/");
			({ stdout } = await execFileAsync(
				"wsl.exe",
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
				throw new Error("Secure image output on Windows requires WSL with Python 3");
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

async function runHelper(
	prepared: PreparedWindowsOutputRequest,
	image?: Buffer,
	signal?: AbortSignal,
): Promise<void> {
	const child = spawn("wsl.exe", ["--exec", "python3", prepared.helperPath], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const closePromise = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
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

	const sendDecision = (decision: "CANCEL" | "COMMIT") => {
		if (decisionSent) return;
		decisionSent = true;
		commitAuthorized = decision === "COMMIT";
		if (commitAuthorized) clearTimeout(operationTimer);
		child.stdin.end(`${decision}\n`);
	};
	const requestCancellation = () => {
		if (commitAuthorized) return;
		abortRequested = true;
		if (inputWritten && image) sendDecision("CANCEL");
	};
	const onAbort = () => requestCancellation();
	const operationTimer = setTimeout(() => {
		if (commitAuthorized) return;
		helperTimedOut = true;
		requestCancellation();
		terminationTimer = setTimeout(() => child.kill(), OUTPUT_HELPER_TERMINATION_GRACE_MS);
		terminationTimer.unref?.();
	}, OUTPUT_HELPER_TIMEOUT_MS);
	operationTimer.unref?.();
	if (canListenForAbort) signal.addEventListener("abort", onAbort, { once: true });

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
			await closePromise.catch(() => undefined);
			if (abortRequested) throw new Error("Codex image generation cancelled");
			throw helperError ? new Error(helperError) : error;
		}

		let code: number | null;
		try {
			[code] = await closePromise;
		} catch {
			throw new Error("Secure image output on Windows requires WSL with Python 3");
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

async function writeChunk(child: ChildProcessWithoutNullStreams, chunk: Buffer): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		child.stdin.write(chunk, (error) => error ? reject(error) : resolve());
	});
}
