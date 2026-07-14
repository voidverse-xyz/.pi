/**
 * sandbox/bash-guard.ts — mutation heuristics for bash under a
 * path-restricted or readOnly type (D20 "bash hole"), PURE: a command string
 * plus an injected path checker in, a verdict out.
 *
 * Posture (D20): FAIL SAFE. A false positive becomes a human decision
 * (escalation); a false negative would be a silent write — so anything not
 * PROVABLY harmless or provably in-scope escalates:
 *
 *   allow    — every chained part is a known read-only command, or a known
 *              mutator whose inferable targets ALL pass checkWrite
 *   deny     — readOnly type + clearly-mutating command, or a mutator whose
 *              target the path policy hard-denies (system state)
 *   escalate — mutating with unprovable targets, mutation outside scope,
 *              unknown commands, command/process substitution, readOnly +
 *              unclear
 *
 * Heuristics implemented: known read-only command table (incl. read-only git
 * subcommands) with write-capable-argument escape hatches (find -delete/-exec,
 * fd -x, sort -o, uniq/xxd output files, tree/less -o), known mutators with
 * target extraction (rm/mv/cp/mkdir/touch/tee/sed -i/... incl. -t/-tDIR/
 * --target-directory[=DIR] forms), known unprovable mutators (git add/commit/
 * push, npm install, ...), redirect detection (`>`, `>>`, `&>`, fd variants —
 * spaced or glued to a word; /dev/null and fd-dups exempt, quoted `>` is not a
 * redirect), chain analysis (`&&`, `||`, `;`, `|`, `&`, newlines — every part
 * judged, worst verdict wins), env-assignment/benign-wrapper/`env`-runner
 * prefix stripping, and unresolvable tokens ($VAR, globs, ~) → escalate.
 */

import type { WriteCheck } from "./paths.ts";

export type BashVerdict =
	| { verdict: "allow" }
	| { verdict: "deny"; reason: string }
	| { verdict: "escalate"; reason: string };

export interface BashGuardOptions {
	/** readOnly type: clearly-mutating → deny outright; unclear → escalate. */
	readOnly: boolean;
	/** The path policy (sandbox/paths.ts closure) judging one mutation target. */
	checkWrite: (path: string) => WriteCheck;
}

// ---------------------------------------------------------------------------
// Command tables
// ---------------------------------------------------------------------------

/**
 * Commands that read/print only — PROVIDED they carry none of the
 * write-capable arguments in `readOnlyEscapeHatch` below (C2/M2: find -delete/
 * -exec, fd -x, sort -o, uniq/xxd second-file output, tree/less -o).
 * `env` is deliberately NOT here: it executes its trailing command (C3) and is
 * stripped as a wrapper in analyzeSegment instead.
 */
const READ_ONLY_COMMANDS = new Set([
	"ls", "cat", "grep", "egrep", "fgrep", "rg", "find", "fd", "head", "tail", "wc",
	"pwd", "which", "whereis", "file", "stat", "du", "df", "echo", "printf", "true",
	"false", "test", "[", "sort", "uniq", "cut", "tr", "diff", "cmp", "comm", "less",
	"more", "readlink", "basename", "dirname", "realpath", "date", "whoami", "hostname",
	"uname", "ps", "printenv", "type", "sleep", "md5sum", "sha1sum", "sha256sum",
	"jq", "column", "nl", "strings", "tree", "od", "xxd", "hexdump", "seq", "expr",
	"id", "groups", "uptime", "free", "top", "man", "help", "history",
]);

/** find action predicates that mutate or execute arbitrary commands (C2). */
const FIND_ACTIONS = new Set([
	"-delete", "-exec", "-execdir", "-ok", "-okdir",
	"-fprintf", "-fprint", "-fprint0", "-fls",
]);

/**
 * A read-only-listed command whose ARGUMENTS give it write or exec ability
 * (C2/M2). Returns the reason, or null when the invocation is genuinely
 * read-only. False positives here cost an escalation (a human decision),
 * false negatives a silent write — so ambiguity leans toward a reason.
 */
function readOnlyEscapeHatch(cmd: string, args: Token[]): string | null {
	switch (cmd) {
		case "find": {
			const action = args.find((a) => FIND_ACTIONS.has(a.text));
			if (action) return `find ${action.text} mutates or executes commands`;
			const expansion = args.find((a) => a.hasExpansion);
			if (expansion) return `find argument "${expansion.text}" is not statically resolvable — could be an action predicate`;
			return null;
		}
		case "fd": {
			// -x/--exec, -X/--exec-batch run a command per result.
			const exec = args.find((a) => /^--exec(?:-batch)?(?:=|$)/.test(a.text) || /^-[A-Za-z]*[xX]/.test(a.text));
			return exec ? `fd ${exec.text} executes a command per result` : null;
		}
		case "sort": {
			// -o FILE / -oFILE / bundled -ro FILE / --output[=]FILE (o is sort's
			// only short flag spelled o, so a cluster containing o means output).
			const out = args.find((a) => /^(?:--o|-[a-zA-Z]*o)/.test(a.text));
			return out ? `sort ${out.text} writes its output to a file` : null;
		}
		case "tree":
		case "less": {
			// tree -o FILE and less -o/-O FILE write output/log files.
			const out = args.find((a) => /^-[a-zA-Z]*[oO]/.test(a.text));
			return out ? `${cmd} ${out.text} writes to a file` : null;
		}
		case "uniq":
		case "xxd": {
			// A second positional file argument is an OUTPUT file. Pure-numeric
			// positionals are flag values (`uniq -f 1`, `xxd -c 16`), not files.
			const positional = args.filter((a) => !a.text.startsWith("-") && !/^\d+$/.test(a.text));
			if (positional.length >= 2) {
				return `${cmd} with a second file argument writes to "${positional[1]!.text}"`;
			}
			return null;
		}
		default:
			return null;
	}
}

/**
 * git subcommands that only read (worktree and .git untouched) REGARDLESS of
 * their action arguments. Subcommands whose read-only-ness depends on a nested
 * action (`remote`, `reflog`, `stash`, `worktree`, `notes`, `config`, `tag`,
 * `gc`, …) are deliberately NOT here — they are classified by action in the
 * `git` branch of analyzeSegment (a bare `git remote` LISTS but `git remote
 * add` MUTATES). Anything not proven read-only there escalates (fail-safe).
 */
const GIT_READ_ONLY = new Set([
	"status", "log", "diff", "show", "rev-parse", "ls-files", "ls-remote", "ls-tree",
	"blame", "describe", "shortlog", "grep", "cat-file", "var", "version", "help",
	"count-objects",
]);

/**
 * Actions of `git remote` that only READ (list/inspect). Every other action —
 * add/remove/rm/set-url/set-head/set-branches/prune/rename/update — mutates the
 * repo's remote configuration and must escalate (deny under readOnly).
 * `undefined` = bare `git remote` (lists remote names) is read-only.
 */
const GIT_REMOTE_READ_ONLY_ACTIONS = new Set(["show", "get-url"]);

/**
 * Actions of `git reflog` that only READ. `expire`/`delete` rewrite the reflog
 * (and can drop unreachable objects) → mutating. `undefined`/`show` are reads.
 */
const GIT_REFLOG_READ_ONLY_ACTIONS = new Set(["show"]);

/**
 * Environment variables that are DANGEROUS as a leading `VAR=val` assignment on
 * ANY command: they install execution hooks, alter which binary/loader runs, or
 * change field splitting — turning an apparently read-only command into
 * arbitrary execution. Their presence always escalates (never silently
 * stripped). This is not exhaustive; unknown variables ALSO escalate (only the
 * small SAFE_ENV_ASSIGNMENTS allowlist below is stripped as benign).
 */
const DANGEROUS_ENV_ASSIGNMENTS = new Set([
	"GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
	"GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_ASKPASS",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE",
	"LESSOPEN", "LESSCLOSE", "LESS", "PAGER", "MANPAGER", "EDITOR", "VISUAL",
	"LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH", "IFS", "PATH", "BASH_ENV", "ENV", "SHELLOPTS",
	"BASH_FUNC", "PROMPT_COMMAND", "PS1", "PS4", "CDPATH", "GLOBIGNORE",
	"PERL5OPT", "PERL5LIB", "PYTHONSTARTUP", "PYTHONPATH", "NODE_OPTIONS",
	"RUBYOPT", "FPATH",
]);

/**
 * Environment variables provably HARMLESS as a leading `VAR=val` prefix for the
 * commands this guard classifies: locale/display knobs that only affect
 * formatting/collation and cannot select a binary, inject code, or change
 * resolution. A leading assignment whose name is NOT here escalates (fail-safe:
 * proving a variable harmless is hard, so unknown escalates). `LC_*` is matched
 * by prefix in isDangerousOrUnknownEnv.
 */
const SAFE_ENV_ASSIGNMENTS = new Set([
	"LANG", "LANGUAGE", "TZ", "COLUMNS", "LINES",
]);

/**
 * Classify a leading (or `env`-consumed) `NAME=value` assignment. Returns null
 * when the name is provably benign (may be stripped); otherwise a reason to
 * escalate. Anything dangerous OR unknown escalates — only SAFE_ENV_ASSIGNMENTS
 * (and `LC_*`) are treated as harmless.
 */
function envAssignmentIssue(name: string): string | null {
	if (DANGEROUS_ENV_ASSIGNMENTS.has(name)) {
		return `environment assignment ${name}= can install an execution hook or alter command/loader resolution`;
	}
	if (SAFE_ENV_ASSIGNMENTS.has(name) || /^LC_[A-Z]+$/.test(name)) return null;
	return `environment assignment ${name}= is not on the harmless allowlist — its effect on the command is not provable`;
}

/**
 * Mutators whose targets are their path arguments — provable when every
 * extracted target passes checkWrite. Value = how to pick targets from the
 * non-flag arguments.
 */
const TARGET_MUTATORS: Record<string, "all" | "dest-last" | "skip-first"> = {
	rm: "all",
	rmdir: "all",
	mkdir: "all",
	touch: "all",
	truncate: "all",
	chmod: "skip-first", // first non-flag arg is the mode
	chown: "skip-first", // first non-flag arg is the owner
	tee: "all",
	mv: "all", // source is removed AND dest written — both are mutations
	cp: "dest-last",
	ln: "dest-last",
	install: "dest-last",
};

/** Clearly-mutating commands whose actual targets cannot be inferred. */
const UNPROVABLE_MUTATORS = new Set([
	"dd", "rsync", "unzip", "tar", "zip", "gzip", "gunzip", "patch",
	"npm", "npx", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "cargo", "go", "make",
	"cmake", "apt", "apt-get", "dnf", "yum", "brew", "pacman", "snap",
	"docker", "podman", "kubectl", "terraform", "gh", "aws", "gcloud",
	"curl", "wget", "ssh", "scp", "sftp", "ftp", "nc", "systemctl", "service",
	"crontab", "kill", "pkill", "killall", "reboot", "shutdown",
]);

/** Wrappers that just run their tail as the real command. */
const TRANSPARENT_WRAPPERS = new Set(["command", "nice", "nohup", "time", "stdbuf", "timeout"]);

/** Wrappers that change privileges or hide the real execution — never provable. */
const OPAQUE_WRAPPERS = new Set(["sudo", "doas", "su", "xargs", "eval", "exec", "sh", "bash", "zsh", "dash", "ksh", "script", "watch"]);

// ---------------------------------------------------------------------------
// Tokenizer (quote-aware; no expansion)
// ---------------------------------------------------------------------------

interface Token {
	/** Token text with quotes stripped. */
	text: string;
	/** Any part came from a single-quoted span (no expansion inside). */
	hadSingleQuote: boolean;
	/** Unquoted or double-quoted `$` present — value unknowable statically. */
	hasExpansion: boolean;
	/** Unquoted glob characters present — expands to unknown paths. */
	hasGlob: boolean;
	/**
	 * Token STARTS with an unquoted redirect operator (`>`, `>>`, `&>`, `N>`,
	 * `N>>`) — set by the tokenizer, which splits a glued word off first
	 * (`echo x>f` → [echo][x][>f]), so a quoted `>` (`echo ">"`) is never one.
	 */
	isRedirect: boolean;
}

/** Split one simple command into tokens, respecting quotes and backslashes. */
function tokenize(segment: string): Token[] {
	const tokens: Token[] = [];
	let current: Token | null = null;
	const push = (): void => {
		if (current !== null) tokens.push(current);
		current = null;
	};
	const ensure = (): Token => {
		current ??= { text: "", hadSingleQuote: false, hasExpansion: false, hasGlob: false, isRedirect: false };
		return current;
	};
	let i = 0;
	while (i < segment.length) {
		const ch = segment[i]!;
		if (ch === "'") {
			const end = segment.indexOf("'", i + 1);
			const inner = end === -1 ? segment.slice(i + 1) : segment.slice(i + 1, end);
			const token = ensure();
			token.text += inner;
			token.hadSingleQuote = true;
			i = end === -1 ? segment.length : end + 1;
		} else if (ch === '"') {
			let j = i + 1;
			let inner = "";
			while (j < segment.length && segment[j] !== '"') {
				if (segment[j] === "\\" && j + 1 < segment.length) {
					inner += segment[j + 1];
					j += 2;
				} else {
					if (segment[j] === "$") ensure().hasExpansion = true;
					inner += segment[j];
					j += 1;
				}
			}
			ensure().text += inner;
			i = j === segment.length ? j : j + 1;
		} else if (ch === "\\") {
			ensure().text += segment[i + 1] ?? "";
			i += 2;
		} else if (ch === " " || ch === "\t") {
			push();
			i += 1;
		} else if (ch === ">" || (ch === "&" && segment[i + 1] === ">")) {
			// Unquoted redirect operator — even glued to a word (C1: `echo x>f`,
			// `cat a>>b`): split the word off so the redirect always starts its
			// own token. A pure-digit prefix is the fd number (`2>f`) and stays
			// with the operator; `2>&1`-style fd-dup targets are exempted later.
			// (cast via a local: `current` is only assigned inside the push/
			// ensure closures, so TS wrongly narrows it to its initial null)
			const cur = current as Token | null;
			if (cur !== null && !cur.isRedirect && !/^\d+$/.test(cur.text)) {
				push();
			}
			const token = ensure();
			token.isRedirect = true;
			token.text += ch;
			i += 1;
		} else {
			const token = ensure();
			if (ch === "$") token.hasExpansion = true;
			if (ch === "*" || ch === "?" || ch === "[" || ch === "{" || ch === "~") token.hasGlob = true;
			token.text += ch;
			i += 1;
		}
	}
	push();
	return tokens;
}

/** Split a command line into simple-command segments on unquoted separators. */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let i = 0;
	while (i < command.length) {
		const ch = command[i]!;
		if (quote !== null) {
			current += ch;
			if (ch === quote && command[i - 1] !== "\\") quote = null;
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			current += command.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			segments.push(current);
			current = "";
			i += 2;
		} else if (ch === "|" && command[i + 1] === "|") {
			segments.push(current);
			current = "";
			i += 2;
		} else if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
			// `&>` is a redirect and `>&` an fd-dup (`2>&1`), not separators —
			// leave them for the tokenizer.
			if (ch === "&" && (command[i + 1] === ">" || command[i - 1] === ">")) {
				current += ch;
				i += 1;
			} else {
				segments.push(current);
				current = "";
				i += 1;
			}
		} else {
			current += ch;
			i += 1;
		}
	}
	segments.push(current);
	return segments.map((s) => s.trim()).filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// Per-segment analysis
// ---------------------------------------------------------------------------

/** A redirect token: optional fd digits or `&`, the operator, optional attached target. */
const REDIRECT_TOKEN_RE = /^(?:&|\d*)(?:>>|>\|?)([\s\S]*)$/;

interface SegmentAnalysis {
	verdict: BashVerdict;
}

function allow(): BashVerdict {
	return { verdict: "allow" };
}
function deny(reason: string): BashVerdict {
	return { verdict: "deny", reason };
}
function escalate(reason: string): BashVerdict {
	return { verdict: "escalate", reason };
}

/** Judge one mutation target through the path policy, folding readOnly. */
function judgeTarget(target: Token, options: BashGuardOptions, what: string): BashVerdict {
	if (target.hasExpansion || target.hasGlob) {
		return escalate(`${what} target "${target.text}" is not statically resolvable ($/glob expansion)`);
	}
	const check = options.checkWrite(target.text);
	if (check.verdict === "allowed") return allow();
	if (check.verdict === "denied") return deny(`${what} target "${target.text}": ${check.reason}`);
	return escalate(`${what} target "${target.text}": ${check.reason}`);
}

/** Last path segment of a token's text (its basename), trailing slashes trimmed. */
function tokenBasename(text: string): string {
	const trimmed = text.replace(/\/+$/, "");
	const slash = trimmed.lastIndexOf("/");
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * cp/mv/ln/install may treat the destination as a DIRECTORY, in which case the
 * effective write is `dest/basename(source)` — NOT `dest` itself. The guard
 * can't know statically whether dest is a dir or a rename target, so it also
 * judges every effective `dest/basename(src)` (fail-safe: a protected/denyPaths
 * CHILD reachable through an allowed parent must not slip through). In-scope
 * copies stay allowed because the effective path is still under the allowed
 * dest; only effective paths that land on a protected/out-of-scope location
 * add a deny/escalate.
 */
function judgeEffectiveDests(dest: Token, sources: Token[], options: BashGuardOptions, what: string): BashVerdict[] {
	if (dest.hasExpansion || dest.hasGlob) return []; // dest already escalated by judgeTarget
	const out: BashVerdict[] = [];
	for (const src of sources) {
		if (src.hasExpansion || src.hasGlob) {
			out.push(escalate(`${what} source "${src.text}" is not statically resolvable — effective destination unknown`));
			continue;
		}
		const base = tokenBasename(src.text);
		if (base === "" || base === "." || base === "..") {
			out.push(escalate(`${what} source "${src.text}" has no inferable basename — effective destination unknown`));
			continue;
		}
		const effective: Token = { ...dest, text: `${dest.text.replace(/\/+$/, "")}/${base}`, isRedirect: false };
		out.push(judgeTarget(effective, options, `${what} effective destination`));
	}
	return out;
}

/** Worst-verdict-wins fold: deny > escalate > allow. */
function worst(verdicts: BashVerdict[]): BashVerdict {
	let result: BashVerdict = allow();
	for (const v of verdicts) {
		if (v.verdict === "deny") return v;
		if (v.verdict === "escalate" && result.verdict === "allow") result = v;
	}
	return result;
}

function analyzeSegment(segment: string, options: BashGuardOptions): SegmentAnalysis {
	const verdicts: BashVerdict[] = [];
	const tokens = tokenize(segment);

	// Redirects first: they mutate regardless of the command. The tokenizer
	// marks every unquoted operator (spaced OR glued, C1) with isRedirect;
	// quoted `>` (`echo ">"`) never gets the flag and stays an ordinary word.
	const words: Token[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.isRedirect) {
			const parsed = REDIRECT_TOKEN_RE.exec(token.text);
			if (!parsed) {
				// Operator mangled by quoting inside the token (e.g. `>'>'`).
				verdicts.push(escalate(`unparseable redirect "${token.text}"`));
				continue;
			}
			let target: Token | undefined;
			if (parsed[1] === "") {
				target = tokens[i + 1]; // spaced form: `> file`
				i += 1;
			} else {
				target = { ...token, text: parsed[1]!, isRedirect: false }; // attached: `>file`
			}
			if (!target) {
				verdicts.push(escalate("dangling redirect"));
			} else if (target.text !== "/dev/null" && !/^&\d+$/.test(target.text)) {
				verdicts.push(
					options.readOnly
						? deny(`readOnly type: output redirect to "${target.text}" is a write`)
						: judgeTarget(target, options, "redirect"),
				);
			}
			continue;
		}
		words.push(token);
	}

	// Command/process substitution anywhere → unprovable.
	if (/\$\(|`|<\(|>\(/.test(segment)) {
		verdicts.push(escalate("command/process substitution — effects not statically analyzable"));
		return { verdict: worst(verdicts) };
	}

	// Strip leading VAR=value assignments, transparent wrappers, and `env`
	// (C3: env is a command RUNNER — the read-only case is bare `env`; with a
	// trailing command the REAL command must be classified instead).
	let index = 0;
	stripping: for (;;) {
		const word = words[index];
		if (!word) break;
		const assign = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word.text);
		if (assign) {
			// Do NOT blanket-strip: a leading VAR=val can install an execution
			// hook (GIT_EXTERNAL_DIFF, LESSOPEN, …) or repoint the loader/PATH,
			// turning a "read-only" command into arbitrary execution. Escalate
			// unless the name is provably benign; keep classifying so a deny
			// (system-state target) can still win.
			const issue = envAssignmentIssue(assign[1]!);
			if (issue !== null) verdicts.push(escalate(issue));
			index += 1;
			continue;
		}
		if (word.text.includes("/")) {
			// Never grant trust by basename to a path-selected executable. A project
			// can contain an attacker-controlled `ls`/`git`/`env` whose behavior has
			// nothing to do with the system utility. Keep classifying the basename
			// and arguments so a protected mutation target can still upgrade this to
			// a hard denial, but path selection itself always requires human review.
			verdicts.push(escalate(`path-qualified command "${word.text}" is not a trusted bare executable name`));
		}
		if (TRANSPARENT_WRAPPERS.has(word.text)) {
			index += 1;
			// skip a wrapper's own numeric arg (e.g. `timeout 5`)
			if (index < words.length && /^\d+[smhd]?$/.test(words[index]!.text)) index += 1;
			continue;
		}
		const wordBase = word.text.includes("/") ? word.text.slice(word.text.lastIndexOf("/") + 1) : word.text;
		if (wordBase === "env" && !word.hasExpansion && !word.hasGlob) {
			index += 1;
			// Consume env's own VAR=val assignments and provably-benign flags;
			// anything else (-C chdir, -S split-string, unknown flags) makes the
			// tail's meaning — or its relative paths — untrustworthy: escalate.
			while (index < words.length) {
				const t = words[index]!.text;
				const envAssign = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t);
				if (envAssign) {
					// Same danger as a bare leading assignment — `env LESSOPEN=…
					// less` is the exact bypass, so vet the name here too.
					const issue = envAssignmentIssue(envAssign[1]!);
					if (issue !== null) verdicts.push(escalate(issue));
					index += 1;
				} else if (t === "-i" || t === "--ignore-environment" || t === "-0" || t === "--null") {
					index += 1;
				} else if (t === "-u" || t === "--unset") {
					index += 2; // flag + the NAME it consumes
				} else if (t.startsWith("--unset=")) {
					index += 1;
				} else if (t.startsWith("-")) {
					verdicts.push(escalate(`env ${t}: wrapper form too ambiguous to analyze — cannot classify the real command`));
					return { verdict: worst(verdicts) };
				} else {
					continue stripping; // the real command starts here
				}
			}
			continue;
		}
		break;
	}
	const cmdToken = words[index];
	if (!cmdToken) {
		// Pure assignment / redirect-only segment.
		return { verdict: worst(verdicts) };
	}
	if (cmdToken.hasExpansion || cmdToken.hasGlob) {
		verdicts.push(escalate(`command name "${cmdToken.text}" is not statically resolvable`));
		return { verdict: worst(verdicts) };
	}
	const cmd = cmdToken.text.includes("/") ? cmdToken.text.slice(cmdToken.text.lastIndexOf("/") + 1) : cmdToken.text;
	const args = words.slice(index + 1);

	if (OPAQUE_WRAPPERS.has(cmd)) {
		verdicts.push(escalate(`"${cmd}" hides the real command — not statically analyzable`));
		return { verdict: worst(verdicts) };
	}

	if (READ_ONLY_COMMANDS.has(cmd)) {
		const hatch = readOnlyEscapeHatch(cmd, args);
		if (hatch !== null) {
			verdicts.push(options.readOnly ? deny(`readOnly type: ${hatch}`) : escalate(hatch));
		}
		return { verdict: worst(verdicts) };
	}

	if (cmd === "git") {
		// `-C DIR` reroots git at an arbitrary path (escaping the scope check);
		// treat any git invocation carrying it as unprovable.
		const hasC = args.some((a) => a.text === "-C");
		const nonFlags = args.filter((a) => !a.text.startsWith("-"));
		const sub = nonFlags[0]?.text;
		const action = nonFlags[1]?.text; // the subcommand's first positional (its action)
		let readOnlyGit = false;
		if (sub !== undefined && !hasC) {
			if (sub === "remote") {
				// Read-only ONLY for bare `git remote`, `-v`/`--verbose`, `show`,
				// `get-url`. add/remove/rm/set-url/set-head/prune/rename/update
				// mutate the remote config → escalate.
				readOnlyGit = action === undefined || GIT_REMOTE_READ_ONLY_ACTIONS.has(action);
			} else if (sub === "reflog") {
				// Read-only for bare `git reflog` / `git reflog show`. expire/delete
				// rewrite the reflog and can drop objects → escalate.
				readOnlyGit = action === undefined || GIT_REFLOG_READ_ONLY_ACTIONS.has(action);
			} else if (GIT_READ_ONLY.has(sub)) {
				readOnlyGit = true;
			}
		}
		if (readOnlyGit) return { verdict: worst(verdicts) };
		const label = action !== undefined ? `git ${sub} ${action}` : `git ${sub ?? "(unknown)"}`;
		verdicts.push(
			options.readOnly
				? deny(`readOnly type: ${label} mutates the repository`)
				: escalate(`${label} mutates repository state — targets not provable`),
		);
		return { verdict: worst(verdicts) };
	}

	if (cmd === "sed" || cmd === "perl") {
		const inPlace = args.some((a) => {
			if (cmd === "sed") return /^-i(?:.*)?$/.test(a.text) || /^--in-place(?:=.*)?$/.test(a.text);
			// Perl bundles short switches (`-pi.bak`, `-spi`) and accepts the
			// optional backup suffix in the same token. Conservatively treat any
			// bundled short option containing i as in-place.
			return /^-[pnswal0]*i/.test(a.text) || /^--in-?place(?:=.*)?$/.test(a.text);
		});
		if (!inPlace) return { verdict: worst(verdicts) }; // stream edit → stdout only
		if (options.readOnly) {
			verdicts.push(deny(`readOnly type: ${cmd} -i edits files in place`));
			return { verdict: worst(verdicts) };
		}
		// -i: every non-flag arg after the script is a target; the script is
		// the first non-flag arg. Conservative: judge all non-flag args but
		// the first.
		const nonFlags = args.filter((a) => !a.text.startsWith("-"));
		const targets = nonFlags.slice(1);
		if (targets.length === 0) verdicts.push(escalate(`${cmd} -i with no inferable file targets`));
		for (const t of targets) verdicts.push(judgeTarget(t, options, `${cmd} -i`));
		return { verdict: worst(verdicts) };
	}

	const mode = TARGET_MUTATORS[cmd];
	if (mode !== undefined) {
		if (options.readOnly) {
			verdicts.push(deny(`readOnly type: "${cmd}" is a mutating command`));
			return { verdict: worst(verdicts) };
		}
		// M1: cp/mv/ln/install accept -t DIR, -tDIR, --target-directory[=DIR] —
		// the DIR is the write target (the trailing args become sources).
		const takesTargetDir = cmd === "cp" || cmd === "mv" || cmd === "ln" || cmd === "install";
		let targetDir: Token | null = null;
		const positional: Token[] = [];
		let optionsEnded = false;
		for (let i = 0; i < args.length; i++) {
			const a = args[i]!;
			if (!optionsEnded && a.text === "--") {
				optionsEnded = true;
				continue;
			}
			if (!optionsEnded && takesTargetDir) {
				if (a.text === "-t" || a.text === "--target-directory") {
					const next = args[i + 1];
					if (!next) {
						verdicts.push(escalate(`${cmd} ${a.text}: dangling target-directory flag`));
						return { verdict: worst(verdicts) };
					}
					targetDir = next;
					i += 1;
					continue;
				}
				if (a.text.startsWith("--target-directory=")) {
					targetDir = { ...a, text: a.text.slice("--target-directory=".length), isRedirect: false };
					continue;
				}
				if (/^-t./.test(a.text)) {
					targetDir = { ...a, text: a.text.slice(2), isRedirect: false };
					continue;
				}
				if (/^-[a-zA-Z]/.test(a.text) && !a.text.startsWith("--") && a.text.includes("t")) {
					// bundled short flags containing t (`-vt DIR`, `-rtDIR`) —
					// where the dir starts is not worth guessing: escalate.
					verdicts.push(escalate(`${cmd} ${a.text}: bundled -t target-directory form — targets not inferred`));
					return { verdict: worst(verdicts) };
				}
			}
			// After `--`, leading '-' is ordinary path data, not an option. Dropping
			// it lets `cp -- src -dest` hide the real destination from checkWrite.
			if (optionsEnded || !a.text.startsWith("-")) positional.push(a);
		}
		if (targetDir !== null) {
			// The dir is written; "all"-mode commands (mv) also mutate their
			// sources (removal) — judge those too.
			const targets = mode === "all" ? [targetDir, ...positional] : [targetDir];
			for (const t of targets) verdicts.push(judgeTarget(t, options, `${cmd} -t`));
			// -t forces dir semantics: the real writes are targetDir/basename(src).
			verdicts.push(...judgeEffectiveDests(targetDir, positional, options, `${cmd} -t`));
			return { verdict: worst(verdicts) };
		}
		let targets = positional;
		if (mode === "skip-first") targets = targets.slice(1);
		if (mode === "dest-last") targets = targets.slice(-1);
		if (targets.length === 0) {
			verdicts.push(escalate(`mutating command "${cmd}" with no inferable targets`));
		}
		for (const t of targets) verdicts.push(judgeTarget(t, options, cmd));
		// For cp/mv/ln/install the last positional MAY be a directory — then the
		// effective writes are dest/basename(src) for the preceding sources. Judge
		// those too so a protected/deny child reached through an allowed parent
		// cannot slip through (finding 4).
		if (takesTargetDir && positional.length >= 2) {
			const dest = positional[positional.length - 1]!;
			const sources = positional.slice(0, -1);
			verdicts.push(...judgeEffectiveDests(dest, sources, options, cmd));
		}
		return { verdict: worst(verdicts) };
	}

	if (UNPROVABLE_MUTATORS.has(cmd)) {
		verdicts.push(
			options.readOnly
				? deny(`readOnly type: "${cmd}" has side effects`)
				: escalate(`"${cmd}" mutates state that cannot be scoped to writePaths`),
		);
		return { verdict: worst(verdicts) };
	}

	// Unknown command — cannot prove it is non-mutating (both modes escalate:
	// even readOnly cannot call it "clearly mutating").
	verdicts.push(escalate(`unknown command "${cmd}" — cannot prove it is non-mutating`));
	return { verdict: worst(verdicts) };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Classify one bash command line under the type's sandbox. Chained commands
 * (`&&`, `||`, `;`, `|`, `&`, newlines) are all analyzed; the worst part's
 * verdict wins (deny > escalate > allow).
 */
export function classifyBashCommand(command: string, options: BashGuardOptions): BashVerdict {
	const trimmed = command.trim();
	if (trimmed === "") return allow();
	// Heredocs feed stdin — the receiving command still gets judged, but the
	// body must not be parsed as commands. Conservative: escalate.
	if (/<<-?\s*['"]?\w+/.test(trimmed)) {
		return escalate("heredoc — body not statically analyzable");
	}
	const verdicts = splitSegments(trimmed).map((segment) => analyzeSegment(segment, options).verdict);
	return worst(verdicts);
}
