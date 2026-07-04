/**
 * Command categories for the command-safety extension.
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

export interface CategoryRule {
	category: Category;
	patterns: RegExp[];
}

export interface CategoryMeta {
	/** Human label shown in the confirmation dialog and notifications. */
	label: string;
	/** Theme color for the label / status accent. */
	color: "error" | "warning";
	/** How many confirmations must pass before the command runs. */
	confirmations: number;
	/** Button-enable delay (ms) applied to every confirmation prompt. */
	delayMs: number;
	/** One-line description of what the category covers. */
	blurb: string;
}

const THREE_SECONDS = 3000;

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
		color: "warning",
		confirmations: 1,
		delayMs: THREE_SECONDS,
		blurb: "Downloads or uploads data (curl, wget, scp, rsync, git clone/push, installs).",
	},
	exec: {
		label: "Exec",
		color: "warning",
		confirmations: 1,
		delayMs: THREE_SECONDS,
		blurb: "Starts, inspects, or manipulates processes (interpreters, sudo, kill, docker, cron).",
	},
	other: {
		label: "Command",
		color: "warning",
		confirmations: 1,
		delayMs: THREE_SECONDS,
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
			// rm with a recursive or force flag (rm -rf, rm -r, rm -f, rm --recursive/--force)
			new RegExp(String.raw`\brm\s+(?:-\S*[rRf]|--recursive|--force)`),
			// git history/tree destruction
			new RegExp(String.raw`\bgit\s+reset\b${SEG}--hard`),
			new RegExp(String.raw`\bgit\s+clean\b${SEG}-\S*f`),
			new RegExp(String.raw`\bgit\s+push\b${SEG}(?:--force\b|--force-with-lease|-f\b)`),
			new RegExp(String.raw`\bgit\s+branch\b${SEG}-D\b`),
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
			// fork bomb
			new RegExp(String.raw`:\(\)\s*\{\s*:\s*\|\s*:`),
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
	"cat", "bat", "tac", "nl", "head", "tail", "wc",
	"grep", "egrep", "fgrep", "rg", "ack", "ag",
	"stat", "file", "du", "df", "tree", "realpath", "readlink", "basename", "dirname",
	"date", "cal", "whoami", "id", "hostname", "uname", "uptime", "printenv", "locale",
	"diff", "cmp", "comm", "sort", "uniq", "cut", "column", "rev", "fold", "paste", "join",
	"jq", "yq", "which", "command", "type", "whereis", "true", "false", "test", "[",
	"less", "more", "fd", "man", "tldr", "help",
]);

// git subcommands that only read repository state (mutating ones like commit,
// checkout, branch -d, config <set> stay gated).
const GIT_READONLY = new Set([
	"status", "log", "diff", "show", "blame", "shortlog", "describe", "rev-parse",
	"ls-files", "ls-tree", "reflog", "whatchanged", "cat-file", "name-rev",
	"for-each-ref", "symbolic-ref", "count-objects", "var", "grep",
]);

// Strip a leading path and surrounding quotes from a command head: /usr/bin/ls -> ls.
function commandHead(token: string): string {
	const noQuotes = token.replace(/^['"]|['"]$/g, "");
	return noQuotes.split("/").pop() || noQuotes;
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
	const segments = command.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
	if (segments.length === 0) return false;
	for (const seg of segments) {
		const tokens = seg.split(/\s+/).filter(Boolean);
		// Skip leading `VAR=val` environment assignments.
		let idx = 0;
		while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
		if (idx >= tokens.length) return false;
		const head = commandHead(tokens[idx]);
		if (head === "git") {
			const sub = tokens[idx + 1] ? commandHead(tokens[idx + 1]) : "";
			if (!GIT_READONLY.has(sub)) return false;
			continue;
		}
		if (!SAFE_COMMANDS.has(head)) return false;
	}
	return true;
}

/**
 * Classify a bash command. Returns the highest-severity matching category, or
 * "other" for anything that isn't a provably read-only builtin (so max mode
 * confirms it), or null for read-only inspection commands (never gated).
 */
export function classifyCommand(command: string): Category | null {
	for (const rule of CATEGORY_ORDER) {
		if (rule.patterns.some((pattern) => pattern.test(command))) {
			return rule.category;
		}
	}
	return isReadOnlySafe(command) ? null : "other";
}
