/**
 * sandbox/system-deny.ts — the ONE non-overridable path guard (D20b). PURE.
 *
 * v2 has no per-type territory sandbox; pi-safety gates risk. But two dirs must
 * NEVER be writable by any agent, regardless of type or human confirmation:
 *   - the subagents state tree (mailboxes, sessions, registry) — else an agent
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

/** True iff `path` is `prefix` or below it. */
function isWithin(prefix: string, path: string): boolean {
	if (path === prefix) return true;
	const withSep = prefix.endsWith(sep) ? prefix : prefix + sep;
	return path.startsWith(withSep);
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
