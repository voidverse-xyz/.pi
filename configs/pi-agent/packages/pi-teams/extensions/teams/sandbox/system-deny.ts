/**
 * sandbox/system-deny.ts — the ONE non-overridable path guard (D20b). PURE.
 *
 * v2 has no per-type territory sandbox; pi-safety gates risk. But two dirs must
 * NEVER be writable by any agent, regardless of type or human confirmation:
 *   - the teams state tree (mailboxes, sessions, registry) — else an agent
 *     could forge a teammate's mail or rewrite its own memory;
 *   - the type-definition dirs — else an agent could rewrite its own
 *     constitution (privilege escalation).
 *
 * This is a hard deny (no confirmation offered). Paths are realpath-anchored
 * (symlink defense) and containment is BIDIRECTIONAL: a target that IS a
 * protected prefix, is BELOW one, or is an ANCESTOR of one (mutating an ancestor
 * can delete the protected child — v1 finding #4) is denied.
 */

import { sep } from "node:path";

export type RealpathFn = (path: string) => string;

/**
 * Normalize a path for containment comparison. Unicode NF-C always (an NFD spelling
 * of the same file must not slip past); case-fold on case-insensitive platforms
 * (macOS/Windows) so `.../Teams/x` can't evade `.../teams/x`.
 */
function canonical(path: string): string {
	const nfc = path.normalize("NFC");
	return process.platform === "darwin" || process.platform === "win32" ? nfc.toLowerCase() : nfc;
}

/** Resolve the deepest existing ancestor via realpath, re-appending the missing tail. */
export function realpathDeep(path: string, realpath: RealpathFn): string {
	let normalized = path;
	const tail: string[] = [];
	for (;;) {
		try {
			return tail.length === 0 ? realpath(normalized) : `${realpath(normalized)}${sep}${tail.join(sep)}`;
		} catch {
			const idx = normalized.lastIndexOf(sep);
			if (idx <= 0) return path; // reached root without resolving — fail safe: raw path
			tail.unshift(normalized.slice(idx + 1));
			normalized = normalized.slice(0, idx);
		}
	}
}

/** True iff `path` is `prefix` or below it (platform-aware, NF-C + case). */
function isWithin(prefix: string, path: string): boolean {
	const p = canonical(prefix);
	const t = canonical(path);
	if (t === p) return true;
	const withSep = p.endsWith(sep) ? p : p + sep;
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
export function makeSystemDenyCheck(protectedDirs: string[], realpath: RealpathFn): (target: string) => SystemDenyResult {
	const prefixes = protectedDirs.map((dir) => realpathDeep(dir, realpath));
	return (target: string): SystemDenyResult => {
		const real = realpathDeep(target, realpath);
		for (const prefix of prefixes) {
			// target is/inside a protected dir, OR target is an ancestor of one
			if (isWithin(prefix, real) || isWithin(real, prefix)) {
				return { denied: true, reason: `writes to the protected path ${prefix} are never allowed` };
			}
		}
		return { denied: false };
	};
}

/**
 * A best-effort hard-deny for BASH commands that reference a protected path (H1).
 * edit/write resolve a single target and are checked precisely; bash is opaque, so
 * we scan the command TEXT for any protected root — the resolved realpath, the raw
 * configured dir, and (when the dir is under $HOME) its `~`-relative spelling. This
 * closes the trivial `echo x > ~/.pi/agent/subagents/self.md` self-modification and
 * mailbox-forgery paths. It is NOT a complete bash sandbox (env vars, `cd`, symlinks
 * planted at runtime can still evade a text scan) — a bash-capable type remains an
 * explicit trust decision — but it removes the silent, one-line bypass.
 */
export function makeCommandDenyCheck(protectedDirs: string[], realpath: RealpathFn, home?: string): (command: string) => SystemDenyResult {
	const needles = new Set<string>();
	const addNeedle = (needle: string): void => {
		needles.add(needle);
		if (sep === "\\") needles.add(needle.replaceAll("\\", "/"));
	};
	for (const dir of protectedDirs) {
		addNeedle(dir);
		addNeedle(realpathDeep(dir, realpath));
		if (home && dir.startsWith(home + sep)) {
			addNeedle(`~${dir.slice(home.length)}`);
			addNeedle(`$HOME${dir.slice(home.length)}`);
		}
	}
	const pairs = [...needles].map((needle) => ({ needle, canon: canonical(needle) }));
	return (command: string): SystemDenyResult => {
		const c = canonical(command);
		for (const { needle, canon } of pairs) {
			if (c.includes(canon)) {
				return { denied: true, reason: `the command references the protected path ${needle} — writes there are never allowed` };
			}
		}
		return { denied: false };
	};
}
