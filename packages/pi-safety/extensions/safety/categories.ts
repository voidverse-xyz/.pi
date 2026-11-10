/**
 * Command categories for pi-safety.
 *
 * Each command an agent tries to run through the `bash` tool is classified into
 * exactly one category (or none). Categories are ordered by severity: the first
 * category whose patterns match wins, so a command that is both "network" and
 * "exec" (e.g. `curl ... | sh`) is treated as the more severe "network".
 *
 * To add a category later: add an entry to CATEGORY_ORDER with its patterns and
 * a CategoryMeta entry describing how it is confirmed. Everything else (mode
 * gating, status line, confirmation flow) reads from these two tables.
 */

export type Category = "destructive" | "network" | "exec" | "other";

/**
 * Semantic theme color key for a category's header/divider. These resolve
 * through the active theme (theme.fg), so destructive reads red and network
 * reads blue/cyan in colored themes, and both follow a theme swap. In a
 * monochrome theme, they resolve to its grays.
 */
export type CategoryColor = "error" | "warning" | "accent" | "success";

export interface CategoryRule {
	category: Category;
	patterns: RegExp[];
}

export interface CategoryMeta {
	/** Human label shown in the confirmation dialog and notifications. */
	label: string;
	/** Theme color for the label / status accent. */
	color: CategoryColor;
	/** How many confirmations must pass before the command runs. */
	confirmations: number;
	/** Button-enable delay (ms) applied to every confirmation prompt. 0 = confirm immediately, no countdown. */
	delayMs: number;
	/** One-line description of what the category covers. */
	blurb: string;
}

const THREE_SECONDS = 3000;

// Commands longer than this are never run through the regex classifier —
// classifyCommand fails closed to "destructive" instead, so a pathological
// input can neither evade classification nor stall the regex engine.
const MAX_CLASSIFIED_COMMAND_LENGTH = 256 * 1024;

/**
 * Splits a command line on every command separator, including a bare `&`
 * (background/async) — omitting it let `ls & ./evil.sh` collapse into one
 * "safe" segment and run ungated. The lookbehind/lookahead keep this from
 * splitting the `&` inside `&&`, `&>`/`&>>` (redirect), `>&`/`2>&1` (fd dup),
 * or `|&` (pipe stderr).
 *
 * SECURITY: shared by the classifier (categories.ts) and the audit summarizer
 * (audit.ts) so the two can never diverge on what counts as a segment.
 */
export const SEGMENT_SPLIT_RE = /&&|\|\||;|(?<![>&|\d])&(?![&>])|\||\n/;

export const CATEGORY_META: Record<Category, CategoryMeta> = {
	destructive: {
		label: "Destructive",
		color: "error",
		confirmations: 2,
		delayMs: THREE_SECONDS,
		blurb: "Data loss or system-altering (rm -rf, git reset --hard, dd, mkfs, shutdown).",
	},
	network: {
		label: "Network",
		color: "accent",
		confirmations: 1,
		delayMs: THREE_SECONDS,
		blurb: "Downloads or uploads data (curl, wget, scp, rsync, git clone/push, installs).",
	},
	exec: {
		label: "Exec",
		color: "warning",
		confirmations: 1,
		delayMs: 0,
		blurb: "Starts, inspects, or manipulates processes (interpreters, sudo, kill, docker, cron).",
	},
	other: {
		label: "General",
		color: "warning",
		confirmations: 1,
		delayMs: 0,
		blurb: "Any command that isn't a known read-only builtin (gated in max mode only).",
	},
};

// Segment-boundary helper: [^|;&]* matches within a single sub-command so flags
// on one command don't leak onto another in a `a && b` / `a | b` chain.
const SEG = "[^|;&]*";

export const CATEGORY_ORDER: CategoryRule[] = [
	{
		category: "destructive",
		patterns: [
			// rm behind common wrappers remains destructive (`sudo rm`, `xargs rm`,
			// `command rm`, etc.), including bare rm without -r/-f.
			new RegExp(String.raw`\b(?:sudo|doas|command|env|xargs|time|nice|nohup)\b${SEG}\brm\b`, "i"),
			// any rm invocation at the start of a command segment: `rm file`, `rm -rf dir`,
			// `/bin/rm x`, `foo && rm y`, a newline-separated `cd x\nrm y`, or a quoted
			// `'rm' -rf /`. Bare `rm <file>` counts too — it still deletes. The `m` flag
			// makes `^` match each line start; `\n` in the class covers `;`+newline forms.
			new RegExp(String.raw`(?:^|[;|&\n])\s*['"]?(?:\S+/)?rm\b`, "m"),
			// rm with a destructive flag anywhere in a segment, to catch prefixed forms
			// the segment-start rule misses: `sudo rm -rf`, `xargs rm -f`, `time rm -r`.
			new RegExp(String.raw`\brm\s+(?:-\S*[rRf]|--recursive|--force)`),
			// git history/tree destruction
			new RegExp(String.raw`\bgit\s+reset\b${SEG}--hard`),
			new RegExp(String.raw`\bgit\s+clean\b${SEG}-\S*f`),
			new RegExp(String.raw`\bgit\s+push\b${SEG}(?:--force\b|--force-with-lease|-f\b)`),
			new RegExp(String.raw`\bgit\s+branch\b${SEG}-D\b`),
			new RegExp(String.raw`\bgit\s+(?:restore\b|checkout\b${SEG}--|reflog\s+(?:delete|expire)\b)`, "i"),
			new RegExp(String.raw`\b(?:unlink|rmdir)\b`, "i"),
			new RegExp(String.raw`\b(?:cp|mv)\b${SEG}(?:-\S*f|--force)\b`, "i"),
			new RegExp(String.raw`\brsync\b${SEG}--delete\b`, "i"),
			new RegExp(String.raw`\b(?:sed|perl)\b${SEG}(?:\s-i\b|\s--in-place\b)`, "i"),
			new RegExp(String.raw`\bkubectl\s+delete\b`, "i"),
			new RegExp(String.raw`\bterraform\s+destroy\b`, "i"),
			new RegExp(String.raw`\b(?:docker|podman)\b${SEG}(?:system\s+prune|volume\s+rm)\b`, "i"),
			new RegExp(String.raw`\b(?:npm|pnpm|yarn|pip3?|apt|apt-get|dnf|yum|brew)\s+(?:uninstall|remove|purge)\b`, "i"),
			// disk / filesystem / device writes
			new RegExp(String.raw`\bdd\s+${SEG}\bof=`),
			new RegExp(String.raw`\bof=/dev/`, "i"),
			new RegExp(String.raw`>\s*/dev/(?:sd|nvme|hd|mmcblk|vd|disk)`, "i"),
			new RegExp(String.raw`\bmkfs(?:\.\w+)?\b`, "i"),
			new RegExp(String.raw`\b(?:fdisk|sfdisk|parted|wipefs|mke2fs|mkswap)\b`, "i"),
			new RegExp(String.raw`\bshred\b`, "i"),
			new RegExp(String.raw`\btruncate\b${SEG}-s`),
			// permission bombs
			new RegExp(String.raw`\bch(?:mod|own)\b${SEG}-\S*R`),
			new RegExp(String.raw`\bchmod\b${SEG}\b777\b`),
			// mass-delete via find
			new RegExp(String.raw`\bfind\b${SEG}-delete\b`),
			new RegExp(String.raw`\bfind\b${SEG}-exec\s+rm\b`),
			// SQL data destruction
			new RegExp(String.raw`\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b`, "i"),
			new RegExp(String.raw`\bTRUNCATE\s+TABLE\b`, "i"),
			// power / crontab wipe
			new RegExp(String.raw`\b(?:shutdown|reboot|halt|poweroff)\b`, "i"),
			new RegExp(String.raw`\binit\s+[06]\b`),
			new RegExp(String.raw`\bcrontab\b${SEG}-r\b`),
			// fork bomb — allow whitespace after the `:` name, e.g. `: () { :|:& };:`
			new RegExp(String.raw`:\s*\(\)\s*\{\s*:\s*\|\s*:`),
		],
	},
	{
		category: "network",
		patterns: [
			new RegExp(String.raw`\b(?:curl|wget|aria2c|httpie|http)\b`, "i"),
			new RegExp(String.raw`\b(?:scp|sftp|rsync|ftp|tftp|lftp)\b`, "i"),
			new RegExp(String.raw`\b(?:nc|ncat|netcat|telnet|socat)\b`, "i"),
			new RegExp(String.raw`\bssh\b`, "i"),
			new RegExp(String.raw`\bgit\s+(?:clone|fetch|pull|push|remote|ls-remote|submodule)\b`, "i"),
			new RegExp(String.raw`\bhttp\.server\b`, "i"),
			// package managers that reach the network (download / publish / install / upgrade)
			new RegExp(
				String.raw`\b(?:pip3?|npm|pnpm|yarn|bun|gem|cargo|go|apt|apt-get|dnf|yum|brew|pacman|nix|pipx|poetry)\s+(?:install|add|get|download|publish|update|upgrade|ci)\b`,
				"i",
			),
		],
	},
	{
		category: "exec",
		patterns: [
			// privilege escalation (starts a privileged process)
			new RegExp(String.raw`\b(?:sudo|doas)\b`, "i"),
			new RegExp(String.raw`\bsu\s`, "i"),
			// shells running code
			new RegExp(String.raw`\b(?:bash|sh|zsh|ksh|dash|fish)\s+(?:-c\b|\S+\.\w+)`, "i"),
			// language interpreters / script runners
			new RegExp(
				String.raw`\b(?:python3?|node|deno|bun|ruby|perl|php|Rscript|lua|osascript|powershell|pwsh)\b`,
				"i",
			),
			// eval / exec / source
			new RegExp(String.raw`\b(?:eval|exec)\b`, "i"),
			new RegExp(String.raw`(?:^|;|&&|\|\|)\s*(?:source\s+\S|\.\s+\S)`),
			// background / detach / persist
			new RegExp(String.raw`\b(?:nohup|setsid|disown)\b`, "i"),
			new RegExp(String.raw`&\s*$`),
			// process viewing
			new RegExp(String.raw`\b(?:ps|top|htop|pgrep|pidof|pstree|lsof)\b`, "i"),
			// signals / injection / debuggers
			new RegExp(String.raw`\b(?:kill|pkill|killall)\b`, "i"),
			new RegExp(String.raw`\b(?:gdb|strace|ltrace)\b`, "i"),
			new RegExp(String.raw`\bLD_(?:PRELOAD|LIBRARY_PATH)=`),
			// scheduling / service managers
			new RegExp(String.raw`\b(?:systemctl|service|launchctl|initctl|rc-service)\b`, "i"),
			new RegExp(String.raw`\bcrontab\b`, "i"),
			new RegExp(String.raw`\b(?:at|batch)\s`, "i"),
			// spawners / runners / containers / orchestration
			new RegExp(String.raw`\bxargs\b`, "i"),
			new RegExp(String.raw`\bparallel\b`, "i"),
			new RegExp(String.raw`\benv\s+\w+=`, "i"),
			new RegExp(String.raw`\b(?:npx|make|cmake|ninja|gradle|mvn)\b`, "i"),
			new RegExp(String.raw`\bpnpm\s+dlx\b`, "i"),
			new RegExp(String.raw`\b(?:npm|pnpm|yarn)\s+run\b`, "i"),
			new RegExp(String.raw`\b(?:cargo|go)\s+run\b`, "i"),
			new RegExp(String.raw`\b(?:docker|podman|nerdctl)\b`, "i"),
			new RegExp(String.raw`\bkubectl\s+(?:exec|run|apply|delete)\b`, "i"),
			new RegExp(String.raw`\b(?:tmux|screen)\b`, "i"),
		],
	},
];

// Commands considered read-only / side-effect-free. Anything a command isn't
// built purely from (see classifyCommand's catch-all) is gated in max mode. Kept
// deliberately tight — err toward gating — but covers the common inspection
// commands an agent runs constantly so they don't each need a confirmation.
const SAFE_COMMANDS = new Set([
	"ls", "ll", "la", "l", "dir", "pwd", "cd", "echo", "printf",
	"cat", "tac", "nl", "head", "tail", "wc",
	"grep", "egrep", "fgrep", "rg", "ack", "ag",
	"stat", "file", "du", "df", "tree", "realpath", "readlink", "basename", "dirname",
	"date", "cal", "whoami", "id", "hostname", "uname", "uptime", "printenv", "locale",
	"diff", "cmp", "comm", "sort", "uniq", "cut", "column", "rev", "fold", "paste", "join",
	"jq", "yq", "which", "type", "whereis", "true", "false", "test", "[",
	"fd",
]);

// git subcommands that only read repository state (mutating ones like commit,
// checkout, branch -d, config <set> stay gated).
const GIT_READONLY = new Set([
	"status", "log", "diff", "show", "blame", "shortlog", "describe", "rev-parse",
	"ls-files", "ls-tree", "whatchanged", "cat-file", "name-rev",
	"for-each-ref", "count-objects", "var",
]);

// Strip a leading path and surrounding quotes from a command head: /usr/bin/ls -> ls.
function commandHead(token: string): string {
	const noQuotes = token.replace(/^['"]|['"]$/g, "");
	return noQuotes.split("/").pop() || noQuotes;
}

// uniq's grammar is `uniq [OPTS] [INPUT [OUTPUT]]` — a second non-option operand is
// an output file it overwrites. Count operands, skipping options and the value that
// a value-taking option consumes, so `uniq -w 3 in` (1 operand, read-only) is not
// mistaken for a write while `uniq in out` (2 operands) is.
function uniqHasOutputOperand(rest: string[]): boolean {
	const valueOpts = new Set(["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"]);
	let operands = 0;
	for (let i = 0; i < rest.length; i++) {
		const t = rest[i];
		if (t === "--") {
			operands += rest.length - 1 - i;
			break;
		}
		// An option (`-x`, `--foo`, `--foo=bar`) is not an operand; a bare `-` (stdin) is.
		if (t.length > 1 && t.startsWith("-")) {
			if (valueOpts.has(t)) i++; // space-separated value: `-w 3`
			continue;
		}
		operands++;
	}
	return operands >= 2;
}

// A few commands in SAFE_COMMANDS stay read-only only until given a specific flag or
// operand that writes a file or runs another command. isReadOnlySafe trusts the command
// head, so these side-effect forms must be rejected explicitly — otherwise `fd -x rm`,
// `sort -o f`, `tree -o f`, `uniq in out`, `yq -i` slip through UNGATED even in max mode.
function safeCommandUsedUnsafely(head: string, rest: string[]): boolean {
	switch (head) {
		case "fd":
		case "fdfind":
			// -x/--exec and -X/--exec-batch run an arbitrary command per match.
			return rest.some((t) => t === "-x" || t === "--exec" || t === "-X" || t === "--exec-batch");
		case "sort":
			// Output flags write; --compress-program launches an arbitrary process.
			return rest.some((t) =>
				t === "-o" || /^-o./.test(t) || t === "--output" || /^--output=/.test(t) ||
				t === "--compress-program" || t.startsWith("--compress-program="));
		case "tree":
			// -o/--output FILE writes the listing to a file.
			return rest.some((t) => t === "-o" || t === "--output" || /^--output=/.test(t));
		case "yq":
			// -i/--inplace edits the input file in place (mikefarah yq).
			return rest.some((t) => t === "-i" || t === "--inplace");
		case "rg":
			// ripgrep's preprocessor options execute an arbitrary program.
			return rest.some((t) => t === "--pre" || t.startsWith("--pre="));
		case "date":
			return rest.some((t) => t === "-s" || t === "--set" || t.startsWith("--set="));
		case "hostname":
			return rest.some((t) => t === "-F" || t === "--file" || t.startsWith("--file=") || !t.startsWith("-"));
		case "uniq":
			return uniqHasOutputOperand(rest);
		default:
			return false;
	}
}

// True only when the whole command line is provably read-only: no command/process
// substitution, no writes to a real file, and every pipeline/list segment starts
// with a known read-only command (or a read-only `git` subcommand). Conservative —
// anything it can't confidently prove safe returns false, so it gets gated.
function isReadOnlySafe(command: string): boolean {
	// Command or process substitution can run anything — never safe.
	if (/\$\(|`|<\(/.test(command)) return false;
	// Output redirection to a real file is a write. Allow /dev/null and fd dups.
	for (const m of command.matchAll(/(?:^|[^0-9&>])\d?>>?\s*([^\s|&;<>]+)/g)) {
		if (m[1] !== "/dev/null") return false;
	}
	for (const m of command.matchAll(/&>>?\s*([^\s|&;<>]+)/g)) {
		if (m[1] !== "/dev/null") return false;
	}
	const segments = command
		.split(SEGMENT_SPLIT_RE)
		.map((s) => s.trim())
		.filter(Boolean);
	if (segments.length === 0) return false;
	for (const seg of segments) {
		const [first, ...args] = seg.split(/\s+/).filter(Boolean);
		if (!first) return false;
		// Environment assignments can retune otherwise-safe programs (PAGER,
		// LESSOPEN, GIT_EXTERNAL_DIFF, library injection, etc.). Gate them.
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return false;
		const head = commandHead(first);
		if (head === "git") {
			const sub = args[0] ? commandHead(args[0]) : "";
			const rest = args.slice(1);
			if (!GIT_READONLY.has(sub)) return false;
			if (rest.some((token) =>
				token === "--output" || token.startsWith("--output=") ||
				token === "--ext-diff" || token === "--textconv" || token === "--filters" ||
				token === "--open-files-in-pager")) return false;
			continue;
		}
		if (!SAFE_COMMANDS.has(head)) return false;
		// A known-safe head can still write/exec via a side-effect flag or operand.
		if (safeCommandUsedUnsafely(head, args)) return false;
	}
	return true;
}

/**
 * Classify a bash command. Returns the highest-severity matching category, or
 * "other" for anything that isn't a provably read-only builtin (so max mode
 * confirms it), or null for read-only inspection commands (never gated).
 */
export function classifyCommand(command: string): Category | null {
	// Fail closed on pathological input before touching any regex (see
	// MAX_CLASSIFIED_COMMAND_LENGTH above).
	if (command.length > MAX_CLASSIFIED_COMMAND_LENGTH) return "destructive";
	// A single `>` truncates or creates a file. Treat it as destructive unless
	// it targets a standard sink/descriptor. (`>>` is still a mutation and falls
	// through to "other" in max mode, but it does not erase existing contents.)
	for (const match of command.matchAll(/(?:^|[^>])>(?![>&])\|?\s*([^\s|&;<>]+)/g)) {
		const target = match[1]?.replace(/^['"]|['"]$/g, "");
		if (target && !["/dev/null", "/dev/stdout", "/dev/stderr"].includes(target) && !/^&?\d+$/.test(target)) {
			return "destructive";
		}
	}
	for (const rule of CATEGORY_ORDER) {
		if (rule.patterns.some((pattern) => pattern.test(command))) {
			return rule.category;
		}
	}
	return isReadOnlySafe(command) ? null : "other";
}
