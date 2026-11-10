import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { execFile } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { WorkspaceFiles, hash } from "./workspace-files.mjs";
import { SwarmError, inPhase, requireCondition as check } from "./errors.mjs";

const runGit = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/** Bounded inspection never runs Git or content scans on the host event loop. */
export async function inspectCheckout(workspace, { signal, timeoutMs = 120000, additionalPaths = [], maxOutputBytes = MAX_GIT_OUTPUT } = {}) {
	return inPhase("inspection", async () => {
		check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "INPUT", "Invalid inspection timeout");
		check(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= MAX_GIT_OUTPUT, "INPUT", "Invalid Git output limit");
		const deadline = AbortSignal.timeout(timeoutMs);
		const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
		const assertActive = () => {
			check(!deadline.aborted, "INSPECTION_TIMEOUT", "Workspace inspection deadline exceeded");
			check(!combined.aborted, "CANCELLED", "Workspace inspection was cancelled");
		};
		const git = async (cwd, ...args) => {
			assertActive();
			try {
				const { stdout } = await runGit("git", ["--no-optional-locks", "-C", cwd, ...args], {
					signal: combined, encoding: "utf8", maxBuffer: maxOutputBytes,
				});
				assertActive();
				return stdout;
			} catch (error) {
				assertActive();
				if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new SwarmError("INSPECTION_LIMIT", "Git inspection output exceeded its limit");
				throw error;
			}
		};
		assertActive();
		const root = await realpath(workspace);
		assertActive();
		let repository = false;
		try {
			repository = await realpath((await git(root, "rev-parse", "--show-toplevel")).trim()) === root;
		} catch (error) {
			assertActive();
			// Git may be absent or the directory may not be a repository. Other
			// failures must not silently authorize a different inspection scope.
			if (error.code !== "ENOENT" && !(error.code === 128 && /not a git repository/i.test(error.stderr ?? ""))) throw error;
		}
		const inspectSubmodule = (workspace, submodulePath) => fingerprintWorker({ workspace, submodulePath }, combined, assertActive);
		const listed = repository ? await repositoryScope(root, git, inspectSubmodule) : { status: "", paths: undefined, submodules: [] };
		const submodules = flattenSubmodules(listed.submodules);
		const pathIdentity = path => process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
		for (const path of additionalPaths) {
			const identity = pathIdentity(path);
			check(!submodules.some(module => identity === pathIdentity(module.path) || identity.startsWith(`${pathIdentity(module.path)}/`)),
				"PATH", "Submodule mutations require a separate workspace");
		}
		const paths = listed.paths && [...new Set([...listed.paths, ...additionalPaths])].sort();
		assertActive();
		const result = await fingerprintWorker({ workspace: root, repository, records: listed.status.split("\0").filter(Boolean), paths, submodules: listed.submodules }, combined, assertActive);
		// Revalidate every repository's file list, including newly added nested files.
		if (repository) {
			const current = await repositoryScope(root, git, inspectSubmodule);
			check(JSON.stringify(current) === JSON.stringify(listed), "STALE", "Workspace file scope changed during inspection");
		}
		assertActive();
		return result;
	});
}

/** Read-only worker implementation; symlink ancestors are never followed. */
export function inspectCheckoutSync(workspace, { repository = false, records = [], paths, submodules = [] } = {}) {
	const root = realpathSync(workspace);
	const changes = repository ? [] : readdirSync(root, { withFileTypes: true }).map(entry => ({ status: "??", path: entry.name + (entry.isDirectory() ? "/" : "") }));
	for (let i = 0; i < records.length; i++) {
		const status = records[i].slice(0, 2);
		const entry = { status, path: records[i].slice(3) };
		if (/[RC]/.test(status)) entry.previousPath = records[++i];
		changes.push(entry);
	}
	return {
		root, repository, changes, submodules: flattenSubmodules(submodules),
		fingerprintScope: repository ? "Git tracked and non-ignored files plus Git control state, including initialized submodules recursively; missing and empty uninitialized submodules are recorded without fetching. Submodule mutations require a separate workspace; ignored files are checked per operation for explicit edit/write targets, not globally snapshotted. Indirect shell changes to ignored files are outside receipt/drift coverage" : "Complete directory tree plus Git control state",
		fingerprint: new WorkspaceFiles(root).snapshot({ paths, submodules })
	};
}

async function repositoryScope(root, git, inspectSubmodule, depth = 0) {
	check(depth <= 32, "INSPECTION_LIMIT", "Submodule nesting exceeded its limit");
	// Validate gitlink directories before Git status can descend into them.
	const index = await git(root, "ls-files", "--stage", "-z");
	const gitlinks = new Map();
	for (const record of index.split("\0").filter(Boolean)) {
		const match = /^160000 ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
		if (!match) continue;
		const [, commit, stage, path] = match;
		if (!gitlinks.has(path)) gitlinks.set(path, []);
		gitlinks.get(path).push({ commit, stage: Number(stage) });
	}
	const submodules = [];
	for (const [path, entries] of gitlinks) {
		const checkoutRoot = await inspectSubmodule(root, path);
		let checkout = null;
		let head = null;
		if (checkoutRoot) {
			const top = await git(checkoutRoot, "rev-parse", "--show-toplevel");
			check(await realpath(top.trim()) === checkoutRoot, "PATH", "Submodule checkout must be its own repository");
			head = (await git(checkoutRoot, "rev-parse", "--verify", "HEAD")).trim();
			checkout = await repositoryScope(checkoutRoot, git, inspectSubmodule, depth + 1);
		}
		submodules.push({ path, entries, head, checkout });
	}
	const status = await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none");
	const listed = await git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z");
	return { status, paths: [...new Set(listed.split("\0").filter(Boolean))].sort(), submodules };
}

function flattenSubmodules(submodules, prefix = "") {
	const result = [];
	for (const module of submodules) {
		const path = prefix + module.path;
		result.push({ path, initialized: module.checkout !== null, head: module.head, indexedCommits: module.entries });
		if (module.checkout) result.push(...flattenSubmodules(module.checkout.submodules, `${path}/`));
	}
	return result;
}

function fingerprintWorker(data, signal, assertActive) {
	return new Promise((resolve, reject) => {
		assertActive();
		const worker = new Worker(new URL("./checkout-worker.mjs", import.meta.url), { execArgv: [], workerData: data });
		let settled = false;
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			// Termination settles before stop/close can report the inspection drained.
			worker.terminate().then(() => error ? reject(error) : resolve(result), reject);
		};
		const abort = () => { try { assertActive(); } catch (error) { finish(error); } };
		worker.once("message", message => {
			try {
				assertActive();
				if (message.error) finish(new SwarmError(message.error.code ?? "INSPECTION", message.error.message));
				else finish(null, message.result);
			} catch (error) { finish(error); }
		});
		worker.once("error", error => finish(error));
		worker.once("exit", () => {
			if (!settled) finish(new SwarmError("INSPECTION", "Workspace inspection worker exited without a result"));
		});
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
}
export function specificationFingerprint(value) { return hash(JSON.stringify(canonical(value))); }

export { validateApproval } from "./approval-state.mjs";
