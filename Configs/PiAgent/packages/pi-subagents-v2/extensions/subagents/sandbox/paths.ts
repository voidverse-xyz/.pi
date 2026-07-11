/**
 * sandbox/paths.ts — the D20 mutation-path policy, PURE (06-architecture
 * structural rule 3: unit-testable without a live agent or a filesystem).
 *
 * Precedence chain (D20 / 04-type-schema "Sandbox semantics"):
 *
 *   implicit system denials  →  DENIED, non-overridable (never escalated)
 *   readOnly                 →  DENIED (belt-and-braces: readOnly types get
 *                                no edit/write tools at all — tools-filter.ts)
 *   denyPaths                →  ESCALATE (human may still approve-once, D22)
 *   writePaths               →  inside: ALLOWED · outside: ESCALATE
 *   default-cwd              →  inside cwd: ALLOWED · outside: ESCALATE
 *
 * Everything outside declared policy escalates to the HUMAN (D10); only the
 * implicit system denials are hard denials — an agent that could rewrite its
 * own type .md (self-granted privilege escalation) or a teammate's mailbox
 * (forged mail) must not even be able to ASK, because a plausible-looking
 * approval prompt is itself the attack (D20 rationale).
 *
 * Real-path resolution before every check (symlink defense): the caller
 * injects a `realpath` fn (node's realpathSync in production, a fake in unit
 * tests) and `realpathDeep` walks up to the deepest EXISTING ancestor so
 * not-yet-created targets resolve through any symlinked parent.
 *
 * Glob support is a minimal hand-rolled subset — `**`, `*`, `?` — no deps.
 */

import { basename, dirname, normalize, resolve, sep } from "node:path";

import { settingsFileSiblingOf } from "../store/layout.ts";

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type WriteCheck =
	| { verdict: "allowed" }
	| { verdict: "denied"; reason: string }
	| { verdict: "escalate"; reason: string };

/** Resolve symlinks in an EXISTING path; must throw for missing paths. */
export type RealpathFn = (path: string) => string;

/** The type's mutation policy plus the injected realpath (kept pure). */
export interface PathPolicy {
	/** Project cwd — the default mutation scope and the glob anchor. */
	cwd: string;
	/** D20 hard shorthand: every mutation is denied. */
	readOnly: boolean;
	/** Mutation glob scope; undefined = default-cwd (04-type-schema). */
	writePaths?: string[] | undefined;
	/** Mutation-forbidden globs; beats writePaths on overlap. */
	denyPaths: string[];
	/**
	 * Implicit system denials (D20): absolute dir prefixes that are NEVER
	 * writable for any agent — the subagents/ state tree (registry, teams,
	 * mailboxes, sessions, .archive) and both type-definition dirs. The
	 * runtime realpath-resolves these once at session build. checkWrite also
	 * denies each prefix's `<prefix>.json` sibling — the D21 settings files
	 * (rails config) that sit beside the type-def dirs (layout invariant).
	 */
	systemDenyPrefixes: string[];
	realpath: RealpathFn;
}

// ---------------------------------------------------------------------------
// Real-path resolution
// ---------------------------------------------------------------------------

/**
 * Realpath a possibly-not-yet-existing path: resolve the deepest existing
 * ancestor through `realpath`, then re-append the missing tail verbatim.
 * A write to `link/new-file.txt` where `link → /elsewhere` therefore checks
 * against `/elsewhere/new-file.txt` (symlink defense for creations).
 */
export function realpathDeep(path: string, realpath: RealpathFn): string {
	let current = normalize(path);
	const tail: string[] = [];
	for (;;) {
		try {
			const real = realpath(current);
			return tail.length === 0 ? real : resolve(real, ...tail);
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				// Filesystem root itself failed to resolve — fall back to the
				// normalized input (still checked; fail-safe posture).
				return tail.length === 0 ? current : resolve(current, ...tail);
			}
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

/** True if `path` equals `prefix` or lives anywhere below it. */
export function isWithin(prefix: string, path: string): boolean {
	return path === prefix || path.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}

// ---------------------------------------------------------------------------
// Minimal glob (`**`, `*`, `?`) — no deps
// ---------------------------------------------------------------------------

const REGEX_SPECIALS = new Set(["\\", "^", "$", ".", "|", "+", "(", ")", "[", "]", "{", "}"]);

/**
 * Compile one glob to an anchored RegExp. Semantics:
 *   `**`  matches any number of path segments (including none when written
 *         as `a/**` — the pattern also matches `a` itself, so a directory
 *         scope covers the directory)
 *   `*`   matches within one segment
 *   `?`   matches one non-separator character
 */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	let i = 0;
	// `a/**` also matches `a` itself: peel the suffix and make it optional.
	let body = glob;
	let dirSuffix = false;
	if (body.endsWith("/**")) {
		body = body.slice(0, -3);
		dirSuffix = true;
	}
	while (i < body.length) {
		const ch = body[i]!;
		if (ch === "*") {
			if (body[i + 1] === "*") {
				// `**/` mid-pattern: zero or more whole segments.
				if (body[i + 2] === "/") {
					out += "(?:[^/]+/)*";
					i += 3;
				} else {
					out += ".*";
					i += 2;
				}
			} else {
				out += "[^/]*";
				i += 1;
			}
		} else if (ch === "?") {
			out += "[^/]";
			i += 1;
		} else {
			out += REGEX_SPECIALS.has(ch) ? `\\${ch}` : ch;
			i += 1;
		}
	}
	if (dirSuffix) out += "(?:/.*)?";
	return new RegExp(`^${out}$`);
}

/**
 * Match an absolute real path against one glob: absolute globs match the
 * absolute path; relative globs match the cwd-relative path (targets outside
 * cwd can never match a relative glob).
 */
export function matchesGlob(glob: string, absolutePath: string, cwd: string): boolean {
	const normalizedTarget = absolutePath.split(sep).join("/");
	if (glob.startsWith("/")) return globToRegExp(glob).test(normalizedTarget);
	if (!isWithin(cwd, absolutePath)) return false;
	const rel = absolutePath === cwd ? "." : absolutePath.slice(cwd.length + 1).split(sep).join("/");
	return globToRegExp(glob).test(rel);
}

function firstMatch(globs: string[], absolutePath: string, cwd: string): string | null {
	for (const glob of globs) {
		if (matchesGlob(glob, absolutePath, cwd)) return glob;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Judge one mutation target against the policy. `target` may be relative
 * (resolved against cwd) or absolute; it is realpath-resolved first.
 */
export function checkWrite(target: string, policy: PathPolicy): WriteCheck {
	const real = realpathDeep(resolve(policy.cwd, target), policy.realpath);
	const realCwd = realpathDeep(policy.cwd, policy.realpath);

	// 1. Implicit system denials — hard, non-overridable, never escalated (D20).
	// Each prefix also protects its D21 settings-file sibling (`<prefix>.json`,
	// the layout invariant): <cwd>/.pi/subagents.json / ~/.pi/agent/
	// subagents.json carry the rails config — an in-scope write there could
	// disable the rails live, so it gets the same never-even-ask treatment as
	// the type-definition dirs.
	for (const prefix of policy.systemDenyPrefixes) {
		const settingsSibling = settingsFileSiblingOf(prefix.endsWith(sep) ? prefix.slice(0, -1) : prefix);
		// Deny in BOTH directions: the target is protected if it is EQUAL TO or
		// BELOW a protected location (a direct write), OR an ANCESTOR of one (a
		// mutation on `.pi` or the cwd itself would delete/move the protected
		// `.pi/subagents` tree and the settings file from above). `isWithin(real,
		// prefix)` catches ancestors; `isWithin(prefix, real)` catches equal/below.
		if (
			isWithin(prefix, real) ||
			isWithin(real, prefix) ||
			real === settingsSibling ||
			isWithin(real, settingsSibling)
		) {
			return {
				verdict: "denied",
				reason:
					`system state (${real} is on the path to the protected subagent state / ` +
					"type-definition / settings tree — never writable for any agent, not even with approval)",
			};
		}
	}

	// 2. readOnly shorthand — hard override.
	if (policy.readOnly) {
		return { verdict: "denied", reason: "readOnly (this agent type may not mutate anything)" };
	}

	// 3. denyPaths — forbidden even inside writePaths; human may still approve-once.
	const denied = firstMatch(policy.denyPaths, real, realCwd);
	if (denied !== null) {
		return { verdict: "escalate", reason: `denyPaths (mutation inside ${denied})` };
	}

	// 4. writePaths — the declared territory.
	if (policy.writePaths !== undefined) {
		if (firstMatch(policy.writePaths, real, realCwd) !== null) return { verdict: "allowed" };
		return {
			verdict: "escalate",
			reason: `writePaths (mutation outside ${policy.writePaths.join(", ")})`,
		};
	}

	// 5. Default scope: the project cwd.
	if (isWithin(realCwd, real)) return { verdict: "allowed" };
	return { verdict: "escalate", reason: `outside the project cwd (${realCwd})` };
}

/** True only when neither glob list nor readOnly restricts beyond default-cwd. */
export function isUnrestricted(policy: Pick<PathPolicy, "readOnly" | "writePaths" | "denyPaths">): boolean {
	return !policy.readOnly && policy.writePaths === undefined && policy.denyPaths.length === 0;
}
