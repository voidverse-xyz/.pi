import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_PLAN_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 2048;

export interface PlanTarget {
	projectRoot: string;
	absolutePath: string;
	relativePath: string;
	exists: boolean;
	mode?: number;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertSafeInputPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Plan path is required");
	if (trimmed.length > MAX_PATH_LENGTH) throw new Error("Plan path is too long");
	if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new Error("Plan path contains control characters");
	if (isAbsolute(trimmed)) throw new Error("Plan path must be relative to the project");
	if (trimmed.split(/[\\/]+/).includes("..")) throw new Error("Plan path may not contain '..' traversal");
	if (extname(trimmed).toLowerCase() !== ".md") throw new Error("Plan path must end in .md");
	return trimmed;
}

function assertInside(root: string, target: string): string {
	const rel = relative(root, target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Plan path must resolve to a file inside the project");
	}
	return rel;
}

async function inspectPath(root: string, relativePath: string): Promise<{ exists: boolean; mode?: number }> {
	const parts = relativePath.split(sep).filter(Boolean);
	let cursor = root;

	for (let index = 0; index < parts.length; index++) {
		cursor = join(cursor, parts[index]!);
		let stat;
		try {
			stat = await lstat(cursor);
		} catch (error) {
			if (isMissing(error)) return { exists: false };
			throw error;
		}
		if (stat.isSymbolicLink()) throw new Error(`Plan path may not traverse symlinks: ${relativePath}`);
		const isTarget = index === parts.length - 1;
		if (!isTarget && !stat.isDirectory()) {
			throw new Error(`Plan path parent is not a directory: ${parts.slice(0, index + 1).join("/")}`);
		}
		if (isTarget && !stat.isFile()) throw new Error("Plan target must be a regular file");
		if (isTarget) return { exists: true, mode: stat.mode & 0o777 };
	}
	return { exists: false };
}

export async function resolvePlanTarget(cwd: string, input: string): Promise<PlanTarget> {
	const safeInput = assertSafeInputPath(input);
	const lexicalRoot = resolve(cwd);
	const lexicalTarget = resolve(lexicalRoot, safeInput);
	const lexicalRelative = assertInside(lexicalRoot, lexicalTarget);
	const realRoot = await realpath(lexicalRoot);
	const absolutePath = resolve(realRoot, lexicalRelative);
	const relativeToRealRoot = assertInside(realRoot, absolutePath);
	const inspection = await inspectPath(realRoot, relativeToRealRoot);
	return {
		projectRoot: realRoot,
		absolutePath,
		relativePath: relativeToRealRoot.split(sep).join("/"),
		exists: inspection.exists,
		...(inspection.mode !== undefined ? { mode: inspection.mode } : {}),
	};
}

export function validatePlanContent(content: string): number {
	if (!content.trim()) throw new Error("Plan content may not be empty");
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_PLAN_BYTES) {
		throw new Error(`Plan content exceeds the ${MAX_PLAN_BYTES}-byte limit`);
	}
	return bytes;
}

export async function atomicWritePlan(target: PlanTarget, content: string): Promise<void> {
	validatePlanContent(content);
	const parent = dirname(target.absolutePath);
	await mkdir(parent, { recursive: true });

	// Re-resolve after mkdir so a symlink introduced in an existing parent is
	// rejected immediately before the write.
	const checked = await resolvePlanTarget(target.projectRoot, target.relativePath);
	if (checked.absolutePath !== target.absolutePath) throw new Error("Plan target changed while preparing the write");

	const tempPath = join(parent, `.${randomUUID()}.pi-plan.tmp`);
	let handle;
	try {
		handle = await open(
			tempPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			target.mode ?? 0o644,
		);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		if (target.exists) {
			await rename(tempPath, target.absolutePath);
		} else {
			// link() is create-only: if a file appeared after authorization, fail
			// rather than silently replacing a path the user approved as new.
			await link(tempPath, target.absolutePath);
			await rm(tempPath, { force: true });
		}
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(tempPath, { force: true }).catch(() => undefined);
	}
}
