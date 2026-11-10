/**
 * sandbox/system-deny.ts — the ONE non-overridable path guard. PURE.
 *
 * There is no per-type territory sandbox; pi-safety gates risk. But two dirs
 * must NEVER be writable by any agent, regardless of type or human confirmation:
 *   - the subagents state tree (mailboxes, sessions, registry) — else an agent
 *     could forge mail or rewrite its own memory;
 *   - the type-definition dirs — else an agent could rewrite its own
 *     constitution (privilege escalation).
 *
 * This is a hard deny (no confirmation offered). Paths are realpath-anchored
 * (symlink defense) and containment is BIDIRECTIONAL: a target that IS a
 * protected prefix, is BELOW one, or is an ANCESTOR of one (mutating an ancestor
 * can delete the protected child) is denied.
 */

import { sep } from "node:path";

export type RealpathFn = (path: string) => string;

/** Normalize slash and standard Windows namespace aliases for comparison. */
function normalizeSeparators(path: string, pathSeparator: string): string {
	const native = pathSeparator === "\\" ? path.replaceAll("/", "\\") : path;
	if (pathSeparator !== "\\") return native;
	return native
		.replace(/\\\\\?\\unc\\/gi, "\\\\")
		.replace(/\\\\\?\\(?=[a-z]:\\)/gi, "");
}

/** Device and non-file namespace paths cannot be compared safely; fail closed. */
function hasUnsupportedWindowsNamespace(path: string, pathSeparator: string): boolean {
	if (pathSeparator !== "\\") return false;
	const native = path.replaceAll("/", "\\").toLowerCase();
	if (native.startsWith("\\\\.\\") || native.startsWith("\\??\\")) return true;
	if (!native.startsWith("\\\\?\\")) return false;
	const namespaceTarget = native.slice(4);
	return !namespaceTarget.startsWith("unc\\") && !/^[a-z]:\\/.test(namespaceTarget);
}

/** Commands are opaque, so reject unsupported namespaces wherever they occur. */
function containsUnsupportedWindowsNamespace(value: string, pathSeparator: string): boolean {
	if (pathSeparator !== "\\") return false;
	const native = value.replaceAll("/", "\\").toLowerCase();
	if (native.includes("\\\\.\\") || native.includes("\\??\\")) return true;
	return normalizeSeparators(value, pathSeparator).toLowerCase().includes("\\\\?\\");
}

/**
 * Normalize a path for containment comparison. Unicode NF-C always (an NFD spelling
 * of the same file must not slip past); case-fold on case-insensitive platforms
 * (macOS/Windows) so `.../Subagents/x` can't evade `.../subagents/x`.
 */
function canonical(path: string, pathSeparator = sep): string {
	const nfc = normalizeSeparators(path, pathSeparator).normalize("NFC");
	return process.platform === "darwin" || pathSeparator === "\\" ? nfc.toLowerCase() : nfc;
}

/** Resolve the deepest existing ancestor via realpath, re-appending the missing tail. */
export function realpathDeep(path: string, realpath: RealpathFn, pathSeparator = sep): string {
	let normalized = normalizeSeparators(path, pathSeparator);
	const tail: string[] = [];
	for (;;) {
		try {
			const resolved = normalizeSeparators(realpath(normalized), pathSeparator);
			return tail.length === 0 ? resolved : `${resolved}${pathSeparator}${tail.join(pathSeparator)}`;
		} catch {
			const idx = normalized.lastIndexOf(pathSeparator);
			if (idx <= 0) return normalized; // reached root without resolving — fail safe: normalized raw path
			tail.unshift(normalized.slice(idx + 1));
			normalized = normalized.slice(0, idx);
		}
	}
}

/** True iff `path` is `prefix` or below it (platform-aware, NF-C + case). */
function isWithin(prefix: string, path: string, pathSeparator = sep): boolean {
	const p = canonical(prefix, pathSeparator);
	const t = canonical(path, pathSeparator);
	if (t === p) return true;
	const withSep = p.endsWith(pathSeparator) ? p : p + pathSeparator;
	return t.startsWith(withSep);
}

export interface SystemDenyResult {
	denied: boolean;
	reason?: string;
}

/**
 * Build a hard-deny check over a set of protected dirs. `realpath` resolves
 * symlinks; prefixes are realpath'd once at construction.
 */
export function makeSystemDenyCheck(
	protectedDirs: string[],
	realpath: RealpathFn,
	pathSeparator = sep,
): (target: string) => SystemDenyResult {
	const prefixes = protectedDirs.map((dir) => realpathDeep(dir, realpath, pathSeparator));
	const unsafePrefix = prefixes.some((prefix) => hasUnsupportedWindowsNamespace(prefix, pathSeparator));
	return (target: string): SystemDenyResult => {
		if (unsafePrefix || hasUnsupportedWindowsNamespace(target, pathSeparator)) {
			return { denied: true, reason: "Windows device namespace paths are never allowed" };
		}
		const real = realpathDeep(target, realpath, pathSeparator);
		if (hasUnsupportedWindowsNamespace(real, pathSeparator)) {
			return { denied: true, reason: "Windows device namespace paths are never allowed" };
		}
		for (const prefix of prefixes) {
			// target is/inside a protected dir, OR target is an ancestor of one
			if (isWithin(prefix, real, pathSeparator) || isWithin(real, prefix, pathSeparator)) {
				return { denied: true, reason: `writes to the protected path ${prefix} are never allowed` };
			}
		}
		return { denied: false };
	};
}

/**
 * A best-effort hard-deny for BASH commands that reference a protected path.
 * edit/write resolve a single target and are checked precisely; bash is opaque, so
 * we scan the command TEXT for any protected root — the resolved realpath, the raw
 * configured dir, and (when the dir is under $HOME) its `~`-relative spelling. This
 * closes the trivial `echo x > ~/.pi/agent/subagents/self.md` self-modification and
 * mailbox-forgery paths. It is NOT a complete bash sandbox (env vars, `cd`, symlinks
 * planted at runtime can still evade a text scan) — a bash-capable type remains an
 * explicit trust decision — but it removes the silent, one-line bypass.
 */
export function makeCommandDenyCheck(
	protectedDirs: string[],
	realpath: RealpathFn,
	home?: string,
	pathSeparator = sep,
): (command: string) => SystemDenyResult {
	const needles = new Set<string>();
	const addNeedle = (needle: string): void => {
		const normalized = normalizeSeparators(needle, pathSeparator);
		needles.add(normalized);
		if (pathSeparator === "\\") needles.add(normalized.replaceAll("\\", "/"));
	};
	const normalizedHome = home ? normalizeSeparators(home, pathSeparator) : undefined;
	const canonicalHomePrefix = normalizedHome ? `${canonical(normalizedHome, pathSeparator)}${pathSeparator}` : undefined;
	for (const configuredDir of protectedDirs) {
		const dir = normalizeSeparators(configuredDir, pathSeparator);
		addNeedle(dir);
		addNeedle(realpathDeep(dir, realpath, pathSeparator));
		if (normalizedHome && canonicalHomePrefix && canonical(dir, pathSeparator).startsWith(canonicalHomePrefix)) {
			addNeedle(`~${dir.slice(normalizedHome.length)}`);
			addNeedle(`$HOME${dir.slice(normalizedHome.length)}`);
		}
	}
	const pairs = [...needles].map((needle) => ({ needle, canon: canonical(needle, pathSeparator) }));
	return (command: string): SystemDenyResult => {
		if (containsUnsupportedWindowsNamespace(command, pathSeparator)) {
			return { denied: true, reason: "commands using Windows device namespace paths are never allowed" };
		}
		const c = canonical(command, pathSeparator);
		for (const { needle, canon } of pairs) {
			if (c.includes(canon)) {
				return { denied: true, reason: `the command references the protected path ${needle} — writes there are never allowed` };
			}
		}
		return { denied: false };
	};
}
