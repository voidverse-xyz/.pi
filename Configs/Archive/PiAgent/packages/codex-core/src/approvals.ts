/**
 * codex-core approvals — Codex approval modes + sandbox policy (behavior only).
 * The approval dialog uses ctx.ui.select, which pi styles with the active
 * theme, so it needs no look-specific rendering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { EVT, type CodexState } from "./contract.ts";

const SAFE_COMMANDS = new Set([
	"cat", "cd", "cut", "echo", "expr", "false", "grep", "head", "id", "ls",
	"nl", "numfmt", "paste", "pwd", "rev", "rg", "sed", "seq", "stat", "tac",
	"tail", "tr", "true", "uname", "uniq", "wc", "which", "whoami", "date",
	"basename", "dirname", "env", "printf", "readlink", "realpath", "sort",
]);
const SAFE_GIT = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "remote"]);
const UNSAFE_FIND_FLAGS = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprintf"];

function isSafeSimple(tokens: string[]): boolean {
	const [cmd, ...rest] = tokens;
	if (!cmd) return false;
	if (cmd === "git") return rest.length > 0 && SAFE_GIT.has(rest[0]);
	if (cmd === "find") return !rest.some((t) => UNSAFE_FIND_FLAGS.includes(t));
	return SAFE_COMMANDS.has(cmd);
}

export function isKnownSafeCommand(command: string): boolean {
	if (/[><$`]/.test(command)) return false;
	return command.split(/&&|\|\||;|\|/).every((seg) => {
		const tokens = seg.trim().split(/\s+/).filter(Boolean);
		return tokens.length > 0 && isSafeSimple(tokens);
	});
}

export function commandPrefix(command: string): string {
	const tokens = command.trim().split(/\s+/);
	const twoWord = new Set(["git", "npm", "cargo", "docker", "npx", "pnpm", "yarn", "dnf", "apt"]);
	return twoWord.has(tokens[0]) && tokens[1] ? `${tokens[0]} ${tokens[1]}` : tokens[0] ?? "";
}

function isInside(target: string, root: string): boolean {
	const rel = path.relative(root, path.resolve(root, target));
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

const DENY = "The user rejected this action and will tell you what to do differently.";

export function registerApprovals(pi: ExtensionAPI, state: CodexState) {
	const approvedPrefixes = new Set<string>();
	const approvedFiles = new Set<string>();

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
			pi.events.emit(EVT.policy, { approval: state.approvalMode, sandbox: state.sandboxMode });
			ctx.ui.notify(`approval: ${state.approvalMode} · sandbox: ${state.sandboxMode}`, "info");
		},
	});

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
			if (choice === undefined || choice.startsWith("No")) return { block: true as const, reason: DENY };
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
			if (choice === undefined || choice.startsWith("No")) return { block: true as const, reason: DENY };
			if (choice.includes("don't ask again")) approvedFiles.add(file);
			return undefined;
		};

		if (event.toolName === "edit" || event.toolName === "write") {
			const file = String(event.input.path ?? "");
			if (approvedFiles.has(file)) return undefined;
			const inWorkspace = isInside(file, ctx.cwd);
			if (state.sandboxMode === "read-only") return askPatch(event.toolName === "write" ? "Add" : "Edit", file);
			if (!inWorkspace) return askPatch(event.toolName === "write" ? "Add" : "Edit", file);
			return undefined;
		}

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			if (approvedPrefixes.has(commandPrefix(command))) return undefined;
			if (isKnownSafeCommand(command)) return undefined;
			return askExec(command);
		}
		return undefined;
	});
}
