import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	mimeTypeForOutputExtension,
	type GeneratedImage,
} from "./client.ts";
import {
	saveWindowsOutput,
	validateWindowsOutput,
	validateWindowsOutputPath,
} from "./windows-output.ts";

export interface SavedImage {
	absolutePath: string;
	displayPath: string;
}

interface AnchoredOutputParent {
	handle: FileHandle;
	targetPath: string;
	temporaryPath: string;
}

export async function resolveInputImagePaths(cwd: string, paths: string[]): Promise<string[]> {
	return paths.map((path) => resolve(cwd, stripAtPrefix(path)));
}

export async function validateOutputRequest(
	cwd: string,
	requestedPath: string,
	overwrite: boolean,
): Promise<void> {
	const absolutePath = await resolveConfinedOutputPath(cwd, requestedPath);
	if (process.platform === "win32") validateWindowsOutputPath(requestedPath);
	requireOutputMimeType(absolutePath);
	await withFileMutationQueue(absolutePath, async () => {
		if (process.platform === "win32") {
			const rootPath = await realpath(resolve(cwd));
			await validateWindowsOutput(rootPath, absolutePath, requestedPath, overwrite);
			return;
		}
		const anchored = await openAnchoredOutputParent(absolutePath);
		try {
			await requireWritableTargetState(anchored.targetPath, requestedPath, overwrite);
		} finally {
			await anchored.handle.close();
		}
	});
}

export async function saveGeneratedImage(
	cwd: string,
	requestedPath: string,
	image: GeneratedImage,
	overwrite: boolean,
	signal?: AbortSignal,
): Promise<SavedImage> {
	throwIfAborted(signal);
	const absolutePath = await resolveConfinedOutputPath(cwd, requestedPath);
	if (process.platform === "win32") validateWindowsOutputPath(requestedPath);
	const expectedMimeType = requireOutputMimeType(absolutePath);
	if (expectedMimeType !== image.mimeType) {
		throw new Error(
			`Generated image is ${image.mimeType}, but output path requests ${expectedMimeType}. Use a matching extension.`,
		);
	}

	await withFileMutationQueue(absolutePath, async () => {
		throwIfAborted(signal);
		if (process.platform === "win32") {
			const rootPath = await realpath(resolve(cwd));
			await saveWindowsOutput(
				rootPath,
				absolutePath,
				requestedPath,
				Buffer.from(image.data, "base64"),
				overwrite,
				signal,
			);
			return;
		}
		const anchored = await openAnchoredOutputParent(absolutePath);
		try {
			await requireWritableTargetState(anchored.targetPath, requestedPath, overwrite);
			throwIfAborted(signal);
			const handle = await open(anchored.temporaryPath, "wx", 0o600);
			try {
				await handle.writeFile(Buffer.from(image.data, "base64"));
				await handle.sync();
			} catch (error) {
				await handle.close().catch(() => undefined);
				await rm(anchored.temporaryPath, { force: true }).catch(() => undefined);
				throw error;
			}
			await handle.close();
			try {
				throwIfAborted(signal);
				if (overwrite) {
					await rename(anchored.temporaryPath, anchored.targetPath);
				} else {
					await link(anchored.temporaryPath, anchored.targetPath);
					await rm(anchored.temporaryPath, { force: true });
				}
			} catch (error) {
				await rm(anchored.temporaryPath, { force: true }).catch(() => undefined);
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					throw new Error(`Output already exists; set overwrite=true to replace it: ${requestedPath}`);
				}
				throw error;
			}
		} finally {
			await anchored.handle.close();
		}
	});

	const displayRelative = relative(cwd, absolutePath);
	return {
		absolutePath,
		displayPath: displayRelative && !displayRelative.startsWith("..") && !isAbsolute(displayRelative)
			? displayRelative
			: absolutePath,
	};
}

async function resolveConfinedOutputPath(cwd: string, requestedPath: string): Promise<string> {
	const cleaned = stripAtPrefix(requestedPath).trim();
	if (!cleaned) throw new Error("Output path cannot be empty");

	const lexicalRoot = resolve(cwd);
	const lexicalTarget = resolve(lexicalRoot, cleaned);
	if (!isWithin(lexicalRoot, lexicalTarget)) {
		throw new Error("Output path must stay within the current working directory");
	}

	const realRoot = await realpath(lexicalRoot);
	const realParent = await realpath(dirname(lexicalTarget)).catch(() => undefined);
	if (!realParent) {
		throw new Error("Output parent directory must already exist");
	}
	if (!isWithin(realRoot, realParent)) {
		throw new Error("Output path resolves outside the current working directory");
	}
	return join(realParent, basename(lexicalTarget));
}

async function openAnchoredOutputParent(absolutePath: string): Promise<AnchoredOutputParent> {
	if (process.platform !== "linux") {
		throw new Error("Secure image output currently requires Linux descriptor-relative filesystem support");
	}
	const parentPath = dirname(absolutePath);
	const expected = await lstat(parentPath).catch(() => undefined);
	if (!expected?.isDirectory() || expected.isSymbolicLink()) {
		throw new Error("Output parent directory changed while preparing the image");
	}
	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const directoryOnly = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
	const handle = await open(parentPath, fsConstants.O_RDONLY | noFollow | directoryOnly);
	try {
		const opened = await handle.stat();
		if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
			throw new Error("Output parent directory changed while it was being opened");
		}
		const descriptorRoot = `/proc/self/fd/${handle.fd}`;
		const openedParentPath = await realpath(descriptorRoot);
		if (resolve(openedParentPath) !== resolve(parentPath)) {
			throw new Error("Output parent directory escaped the approved path while it was being opened");
		}
		const targetName = basename(absolutePath);
		return {
			handle,
			targetPath: join(descriptorRoot, targetName),
			temporaryPath: join(descriptorRoot, `.${targetName}.pi-image-${randomUUID()}.tmp`),
		};
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function requireWritableTargetState(
	targetPath: string,
	requestedPath: string,
	overwrite: boolean,
): Promise<void> {
	const existing = await lstat(targetPath).catch(() => undefined);
	if (existing?.isSymbolicLink()) {
		throw new Error(`Refusing to replace symbolic link: ${requestedPath}`);
	}
	if (existing && !overwrite) {
		throw new Error(`Output already exists; set overwrite=true to replace it: ${requestedPath}`);
	}
	if (existing && !existing.isFile()) {
		throw new Error(`Output path is not a regular file: ${requestedPath}`);
	}
}

function requireOutputMimeType(absolutePath: string): NonNullable<ReturnType<typeof mimeTypeForOutputExtension>> {
	const mimeType = mimeTypeForOutputExtension(absolutePath);
	if (!mimeType) {
		throw new Error("Output path must end in .png, .jpg, .jpeg, .webp, or .gif");
	}
	return mimeType;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Codex image generation cancelled");
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}
