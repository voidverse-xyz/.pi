/**
 * Minimal glob → RegExp matching for commit config patterns.
 *
 * Supported syntax (matched against forward-slash relative paths, whole-path,
 * case-insensitive to mirror the old classifier's lowercasing):
 *
 *   **   any number of path segments, including none, when it sits on segment
 *        boundaries ("**\/x", "a/**\/b"); a trailing "/**" or a bare "**"
 *        matches the rest of the path; anywhere else it matches any characters
 *   *    any run of characters within one segment (never "/")
 *   ?    exactly one character within one segment (never "/")
 *
 * Everything else is literal. Pure module — no deps — so it can be harness-run
 * with `node --experimental-strip-types`.
 */

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

const cache = new Map<string, RegExp>();

/** Compile one glob to an anchored, case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
	const cached = cache.get(glob);
	if (cached) return cached;

	let source = "";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i]!;
		if (ch === "*" && glob[i + 1] === "*") {
			let j = i + 2;
			while (glob[j] === "*") j++; // collapse runs of 3+ stars into **
			const onLeftBoundary = i === 0 || glob[i - 1] === "/";
			if (onLeftBoundary && glob[j] === "/") {
				// "**/" — zero or more whole segments
				source += "(?:[^/]*/)*";
				i = j + 1;
			} else {
				// trailing "/**", bare "**", or mid-token "a**b" — any characters
				source += ".*";
				i = j;
			}
		} else if (ch === "*") {
			source += "[^/]*";
			i++;
		} else if (ch === "?") {
			source += "[^/]";
			i++;
		} else {
			source += ch.replace(REGEXP_SPECIALS, "\\$&");
			i++;
		}
	}

	const re = new RegExp(`^${source}$`, "i");
	cache.set(glob, re);
	return re;
}

/** True when `path` (forward-slash, repo-relative) matches any of the globs. */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
	return globs.some((g) => globToRegExp(g).test(path));
}
