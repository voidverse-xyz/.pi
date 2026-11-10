import {
	lstatSync,
	opendirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { requireCondition as check } from "./errors.mjs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function hash(value) { return createHash("sha256").update(value).digest("hex"); }

/** Read-only path validation and content fingerprints. Pi owns all coding IO. */
export class WorkspaceFiles {
	#root;
	#identity;
	#protected;
	#submodules;
	constructor(root, { protectedPaths = [], submodulePaths = [] } = {}) {
		check(typeof root === "string" && isAbsolute(root), "INPUT", "Expected absolute workspace root");
		this.#root = realpathSync(root);
		check(this.#root === resolve(root), "PATH", "Workspace aliases are unsupported");
		const stat = lstatSync(root);
		check(stat.isDirectory(), "PATH", "Workspace must be a directory");
		this.#identity = [stat.dev, stat.ino, stat.birthtimeMs].join(":");
		this.#protected = protectedPaths;
		this.#submodules = submodulePaths;
	}
	path(path, { allowSubmodules = false } = {}) {
		this.#checkRoot();
		check(typeof path === "string" && path.length > 0 && !path.includes("\0"), "INPUT", "Invalid workspace path");
		const parts = (process.platform === "win32" ? path.toLowerCase() : path).replaceAll("\\", "/").split("/");
		check(!parts.some(part => ["..", ".git"].includes(part)), "PATH", "Traversal and Git control paths are protected");
		const normalized = relative(this.#root, resolve(this.#root, path));
		check(normalized && normalized !== ".." && !normalized.startsWith(`..${sep}`) && !isAbsolute(normalized), "PATH", "Path is outside the workspace");
		const protectedIdentity = value => process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
		const identity = protectedIdentity(normalized);
		check(!this.#protected.some(part => identity === protectedIdentity(part) || identity.startsWith(`${protectedIdentity(part)}/`)), "PATH", "Protected path");
		check(allowSubmodules || !this.#submodules.some(part => identity === protectedIdentity(part) || identity.startsWith(`${protectedIdentity(part)}/`)),
			"PATH", "Submodule mutations require a separate workspace");
		let current = this.#root;
		const components = normalized.split(sep);
		checkComponentAliases(components);
		for (let i = 0; i < components.length; i++) {
			current = join(current, components[i]);
			const stat = statOrMissing(current);
			if (!stat) break;
			check(!stat.isSymbolicLink(), "PATH", "Workspace file aliases are unsupported");
			checkFilesystemSpelling(current);
			check(i === components.length - 1 ? stat.isFile() && stat.nlink === 1 : stat.isDirectory(), "PATH", "Expected ordinary file and directory parents");
			check(allowSubmodules || !stat.isDirectory() || !statOrMissing(join(current, ".git")),
				"PATH", "Nested repository mutations require a separate workspace");
		}
		return normalized.split(sep).join("/");
	}
	identity(path, options) {
		const canonical = this.path(path, options);
		// Conservatively serialize case aliases on Windows, without changing IO spelling.
		return process.platform === "win32" ? canonical.toLowerCase() : canonical;
	}
	fingerprint(path, options) {
		const normalized = this.path(path, options);
		return hash(JSON.stringify(capture(join(this.#root, normalized))));
	}
	/** Validate a gitlink before running Git there; never follow directory aliases. */
	submoduleRoot(path) {
		this.#checkRoot();
		const stat = scopedStat(this.#root, path, true);
		if (!stat) return null;
		check(stat.isDirectory() && !stat.isSymbolicLink(), "PATH", "Submodule checkout must be an ordinary directory");
		const root = join(this.#root, path);
		const control = statOrMissing(join(root, ".git"));
		if (!control) {
			const directory = opendirSync(root);
			try { check(directory.readSync() === null, "PATH", "Uninitialized submodule must be empty"); }
			finally { directory.closeSync(); }
			return null;
		}
		check(!control.isSymbolicLink() && (control.isFile() || control.isDirectory()), "PATH", "Submodule Git metadata must not be aliased");
		return root;
	}
	snapshot(options = {}) {
		const fingerprint = this.#captureSnapshot(options);
		check(this.#captureSnapshot(options) === fingerprint, "STALE", "Workspace changed during snapshot");
		return fingerprint;
	}
	#captureSnapshot({ includeGit = true, paths, submodules = [] } = {}) {
		this.#checkRoot();
		if (paths !== undefined) {
			check(Array.isArray(paths), "INPUT", "Invalid snapshot file scope");
			for (const path of paths) {
				const parts = path.replaceAll("\\", "/").split("/");
				check(path && !isAbsolute(path) && !parts.some(part => ["..", ".git", "", "."].includes(process.platform === "win32" ? part.toLowerCase() : part)), "PATH", "Invalid snapshot path");
				checkComponentAliases(parts);
			}
		}
		const gitlinks = new Map(submodules.map(module => [module.path, module]));
		const contents = paths === undefined ? capture(this.#root, true)
			: paths.map(path => [path, gitlinks.has(path) ? this.#captureSubmodule(gitlinks.get(path)) : captureScoped(this.#root, path)]);
		const fingerprint = hash(JSON.stringify([contents, includeGit ? gitState(this.#root) : null]));
		this.#checkRoot();
		return fingerprint;
	}
	#captureSubmodule(module) {
		const root = this.submoduleRoot(module.path);
		check(Boolean(root) === (module.checkout !== null), "STALE", "Submodule initialization changed during inspection");
		// The public snapshot makes two full-tree passes; nested repositories make
		// one pass each so verification grows linearly rather than doubling per level.
		const fingerprint = root ? new WorkspaceFiles(root).#captureSnapshot({ paths: module.checkout.paths, submodules: module.checkout.submodules })
			: scopedStat(this.#root, module.path, true)?.mode ?? null;
		return ["submodule", module.entries, module.head, fingerprint];
	}
	#checkRoot() {
		const stat = lstatSync(this.#root);
		check(stat.isDirectory() && !stat.isSymbolicLink() && [stat.dev, stat.ino, stat.birthtimeMs].join(":") === this.#identity,
			"PATH", "Workspace root identity changed");
	}
}

function statOrMissing(path) {
	try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function capture(path, excludeGit = false) {
	const stat = statOrMissing(path);
	if (!stat) return null;
	if (stat.isSymbolicLink()) return ["link", readlinkSync(path)];
	if (stat.isFile()) return ["file", stat.mode, hash(readFileSync(path))];
	check(stat.isDirectory(), "PATH", "Unsupported workspace file type");
	return ["directory", stat.mode, readdirSync(path).sort().filter(name => !excludeGit || name !== ".git")
		.map(name => [name, capture(join(path, name), excludeGit)])];
}
function gitState(root) {
	const control = join(root, ".git");
	const stat = statOrMissing(control);
	if (!stat) return null;
	check(!stat.isSymbolicLink(), "PATH", "Git metadata must not be aliased");
	const pointer = stat.isFile() ? readFileSync(control, "utf8") : null;
	const match = pointer === null ? null : /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointer);
	check(pointer === null || match, "PATH", "Invalid Git directory pointer");
	const git = pointer === null ? control : resolve(root, match[1]);
	const commonFile = join(git, "commondir");
	const common = statOrMissing(commonFile) ? resolve(git, readFileSync(commonFile, "utf8").trim()) : git;
	return [pointer, capture(join(git, "HEAD")), capture(join(git, "index")), capture(join(git, "refs")),
		capture(join(common, "packed-refs")), capture(join(common, "refs"))];
}

function captureScoped(root, path) {
	if (!scopedStat(root, path)) return null;
	return capture(join(root, path));
}

function scopedStat(root, path, allowDirectory = false) {
	const parts = path.replaceAll("\\", "/").split("/");
	check(path && !isAbsolute(path) && !parts.some(part => ["..", ".git", "", "."].includes(process.platform === "win32" ? part.toLowerCase() : part)), "PATH", "Invalid snapshot path");
	checkComponentAliases(parts);
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		current = join(current, parts[i]);
		const stat = statOrMissing(current);
		if (!stat) return null;
		check(i === parts.length - 1 || stat.isDirectory() && !stat.isSymbolicLink(), "PATH", "Snapshot directory aliases are unsupported");
		if (!stat.isSymbolicLink()) checkFilesystemSpelling(current);
		// Only Git-identified submodule entries may name directories in a file scope.
		check(i !== parts.length - 1 || allowDirectory || !stat.isDirectory(), "PATH", "Unexpected directory in snapshot file scope");
		if (i === parts.length - 1) return stat;
	}
}

function checkComponentAliases(parts) {
	if (process.platform !== "win32") return;
	check(!parts.some(part => /[. ]$|:/.test(part)), "PATH", "Windows path component aliases are unsupported");
}

function checkFilesystemSpelling(path) {
	if (process.platform !== "win32") return;
	// GetFinalPathName expands existing DOS short names; case-only aliases remain valid.
	check(realpathSync.native(path).toLowerCase() === resolve(path).toLowerCase(), "PATH", "Filesystem path aliases are unsupported");
}
