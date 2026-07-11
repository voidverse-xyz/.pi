/**
 * codex-approvals — Codex approval modes + sandbox policy for pi.
 *
 * Modes from codex-rs/protocol/src/protocol.rs:
 *   AskForApproval: untrusted | on-request (default) | never
 *   SandboxPolicy:  read-only | workspace-write | danger-full-access
 *
 * pi has no OS-level sandbox, so policy is enforced by gating tool calls
 * (`tool_call` event): safe commands auto-run, everything else prompts with
 * codex's approval-overlay options (approval_overlay.rs labels, verbatim).
 * Safe-command classification ported from
 * codex-rs/shell-command/src/command_safety/is_safe_command.rs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { CodexState } from "./commands.ts";

// Ported subset of codex's is_known_safe_command allowlist.
const SAFE_COMMANDS = new Set([
	"cat", "cd", "cut", "echo", "expr", "false", "grep", "head", "id", "ls",
	"nl", "numfmt", "paste", "pwd", "rev", "rg", "sed", "seq", "stat", "tac",
	"tail", "tr", "true", "uname", "uniq", "wc", "which", "whoami", "date",
	"basename", "dirname", "env", "printf", "readlink", "realpath", "sort",
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "remote",
]);
// find is safe unless it can execute/write (codex checks these flags).
const UNSAFE_FIND_FLAGS = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprintf"];

/** Is a single command (no shell operators) on the safe list? */
function isSafeSimpleCommand(tokens: string[]): boolean {
	const [cmd, ...rest] = tokens;
	if (!cmd) return false;
	if (cmd === "git") return rest.length > 0 && SAFE_GIT_SUBCOMMANDS.has(rest[0]);
	if (cmd === "find") return !rest.some((t) => UNSAFE_FIND_FLAGS.includes(t));
	return SAFE_COMMANDS.has(cmd);
}

/**
 * Conservative shell-command safety check: every segment of a
 * `&&`/`||`/`;`/`|` chain must be safe; any redirection/substitution is unsafe.
 */
export function isKnownSafeCommand(command: string): boolean {
	if (/[><$`]/.test(command)) return false;
	const segments = command.split(/&&|\|\||;|\|/);
	return segments.every((seg) => {
		const tokens = seg.trim().split(/\s+/).filter(Boolean);
		return tokens.length > 0 && isSafeSimpleCommand(tokens);
	});
}

/** First word (two for git/npm/cargo/docker) — codex's "commands that start with" prefix. */
export function commandPrefix(command: string): string {
	const tokens = command.trim().split(/\s+/);
	const twoWord = new Set(["git", "npm", "cargo", "docker", "npx", "pnpm", "yarn", "dnf", "apt"]);
	return twoWord.has(tokens[0]) && tokens[1] ? `${tokens[0]} ${tokens[1]}` : tokens[0] ?? "";
}

function isInside(target: string, root: string): boolean {
	const rel = path.relative(root, path.resolve(root, target));
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

const DENY_REASON = "The user rejected this action and will tell you what to do differently.";

export function registerCodexApprovals(pi: ExtensionAPI, state: CodexState) {
	// Session-scoped grants
	const approvedPrefixes = new Set<string>();
	const approvedFiles = new Set<string>();

	// --- /permissions — codex's permission presets ------------------------
	pi.registerCommand("permissions", {
		description: "choose what Codex is allowed to do",
		handler: async (_args, ctx) => {
			const options = [
				"Read Only — approval required for edits and commands",
				"Auto — work in the workspace, ask to go outside (default)",
				"Full Access — never ask (dangerous)",
			];
			const choice = await ctx.ui.select("Permissions", options);
			if (choice === undefined) return;
			if (choice.startsWith("Read Only")) {
				state.approvalMode = "untrusted";
				state.sandboxMode = "read-only";
			} else if (choice.startsWith("Auto")) {
				state.approvalMode = "on-request";
				state.sandboxMode = "workspace-write";
			} else {
				state.approvalMode = "never";
				state.sandboxMode = "danger-full-access";
			}
			ctx.ui.setStatus("codex-permissions", state.sandboxMode === "workspace-write" ? undefined : state.sandboxMode);
			ctx.ui.notify(`approval: ${state.approvalMode} · sandbox: ${state.sandboxMode}`, "info");
		},
	});

	// --- The gate ----------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (state.approvalMode === "never") return undefined;

		const askExec = async (command: string) => {
			if (!ctx.hasUI) return { block: true as const, reason: "Approval required but no UI available." };
			const prefix = commandPrefix(command);
			const display = command.length > 200 ? `${command.slice(0, 200)}…` : command;
			const choice = await ctx.ui.select(`Run command?\n\n  ${display}`, [
				"Yes, proceed",
				`Yes, and don't ask again for commands that start with \`${prefix}\``,
				"No, and tell Codex what to do differently",
			]);
			if (choice === undefined || choice.startsWith("No")) return { block: true as const, reason: DENY_REASON };
			if (choice.includes("don't ask again")) approvedPrefixes.add(prefix);
			return undefined;
		};

		const askPatch = async (verb: string, file: string) => {
			if (!ctx.hasUI) return { block: true as const, reason: "Approval required but no UI available." };
			const choice = await ctx.ui.select(`${verb} ${file}?`, [
				"Yes, proceed",
				"Yes, and don't ask again for these files",
				"No, and tell Codex what to do differently",
			]);
			if (choice === undefined || choice.startsWith("No")) return { block: true as const, reason: DENY_REASON };
			if (choice.includes("don't ask again")) approvedFiles.add(file);
			return undefined;
		};

		// --- writes (edit/write) ------------------------------------------
		if (event.toolName === "edit" || event.toolName === "write") {
			const file = String(event.input.path ?? "");
			if (approvedFiles.has(file)) return undefined;
			const inWorkspace = isInside(file, ctx.cwd);
			if (state.sandboxMode === "read-only") {
				return askPatch(event.toolName === "write" ? "Add" : "Edit", file);
			}
			// workspace-write: in-workspace edits are free, outside asks
			if (!inWorkspace) return askPatch(event.toolName === "write" ? "Add" : "Edit", file);
			return undefined;
		}

		// --- bash ------------------------------------------------------------
		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			if (approvedPrefixes.has(commandPrefix(command))) return undefined;
			if (isKnownSafeCommand(command)) return undefined;
			if (state.sandboxMode === "read-only") return askExec(command);
			// on-request/workspace-write: ask for anything not known-safe
			return askExec(command);
		}

		return undefined;
	});
}
