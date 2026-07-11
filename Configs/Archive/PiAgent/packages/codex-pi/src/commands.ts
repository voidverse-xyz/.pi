/**
 * codex-commands — Codex CLI slash commands mapped onto pi
 * (from codex-rs/tui/src/slash_command.rs + chatwidget/slash_dispatch.rs).
 *
 * This module: /status, /diff, /init, /mention, /goal, /personality.
 * (/permissions ships with codex-approvals; /plan, /review with their modules.
 * /model, /compact, /resume, /fork, /new, /quit already exist in pi.)
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bold, borderedCard, dim, visibleWidth } from "./ansi.ts";

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");

export interface CodexState {
	personality?: "friendly" | "pragmatic";
	goal?: string;
	/** Wired up by codex-approvals; shown in /status. */
	approvalMode: string;
	sandboxMode: string;
	/** Collaboration mode shown in the footer: "default", "plan", … (set by codex-plan). */
	mode: string;
}

interface StatusData {
	model: string;
	provider: string;
	reasoning: string;
	directory: string;
	approval: string;
	sandbox: string;
	tokensUsed: number | null;
	contextWindow: number;
	percentLeft: number | null;
	sessionName?: string;
}

interface DiffData {
	diff: string;
	untrackedCount: number;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

export function registerCodexCommands(pi: ExtensionAPI, state: CodexState) {
	// ------------------------------------------------------------------
	// /status — session configuration + token usage card (status/card.rs)
	// ------------------------------------------------------------------
	pi.registerMessageRenderer<StatusData>("codex-status", (message, _opts, theme: Theme) => {
		const d = message.details as StatusData;
		return {
			render(width: number): string[] {
				const label = (s: string) => dim(s.padEnd(11));
				const rows: string[] = [
					dim(">_ ") + bold("OpenAI Codex"),
					"",
					label("model:") + d.model + (d.reasoning ? ` ${d.reasoning}` : ""),
					label("provider:") + d.provider,
					label("directory:") + d.directory,
					label("approval:") + d.approval,
					label("sandbox:") + d.sandbox,
				];
				if (d.sessionName) rows.push(label("session:") + d.sessionName);
				rows.push("");
				if (d.tokensUsed !== null && d.percentLeft !== null) {
					rows.push(
						label("tokens:") +
							`${fmt(d.tokensUsed)} used ` +
							dim(`/ ${fmt(d.contextWindow)} `) +
							`(${d.percentLeft}% left)`,
					);
				} else {
					rows.push(label("tokens:") + dim("no usage yet"));
				}
				return [theme.fg("customMessageLabel", "/status"), ...borderedCard(rows, width, 72)];
			},
			invalidate() {},
		};
	});

	pi.registerCommand("status", {
		description: "show current session configuration and token usage",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const data: StatusData = {
				model: ctx.model?.id ?? "unknown",
				provider: ctx.model?.provider ?? "unknown",
				reasoning: pi.getThinkingLevel(),
				directory: ctx.cwd,
				approval: state.approvalMode,
				sandbox: state.sandboxMode,
				tokensUsed: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
				percentLeft: usage?.percent != null ? Math.max(0, Math.round(100 - usage.percent)) : null,
				sessionName: pi.getSessionName(),
			};
			pi.sendMessage<StatusData>(
				{ customType: "codex-status", content: "", display: true, details: data },
				{ triggerTurn: false },
			);
		},
	});

	// ------------------------------------------------------------------
	// /diff — git diff incl. untracked files (get_git_diff.rs)
	// ------------------------------------------------------------------
	pi.registerMessageRenderer<DiffData>("codex-diff", (message, { expanded }, theme: Theme) => {
		const d = message.details as DiffData;
		return {
			render(width: number): string[] {
				const lines = d.diff.split("\n");
				const max = expanded ? lines.length : 80;
				const out: string[] = [theme.fg("customMessageLabel", "/diff")];
				for (const line of lines.slice(0, max)) {
					const clipped = visibleWidth(line) > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line;
					if (line.startsWith("+") && !line.startsWith("+++")) out.push(theme.fg("toolDiffAdded", clipped));
					else if (line.startsWith("-") && !line.startsWith("---")) out.push(theme.fg("toolDiffRemoved", clipped));
					else if (line.startsWith("@@")) out.push(theme.fg("accent", clipped));
					else if (line.startsWith("diff --git")) out.push(bold(clipped));
					else out.push(theme.fg("toolDiffContext", clipped));
				}
				if (lines.length > max) out.push(dim(`… +${lines.length - max} lines (ctrl+e to expand)`));
				return out;
			},
			invalidate() {},
		};
	});

	pi.registerCommand("diff", {
		description: "show git diff (including untracked files)",
		handler: async (_args, ctx) => {
			const inRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
			if (inRepo.code !== 0) {
				ctx.ui.notify("`/diff` — _not inside a git repository_", "warning");
				return;
			}
			const tracked = await pi.exec("git", ["diff", "HEAD"]);
			let diff = tracked.stdout;
			const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"]);
			const files = untracked.stdout.split("\n").filter(Boolean);
			for (const file of files.slice(0, 25)) {
				const fileDiff = await pi.exec("git", ["diff", "--no-index", "/dev/null", file]);
				diff += fileDiff.stdout; // --no-index exits 1 when files differ; output is still the diff
			}
			if (!diff.trim()) {
				ctx.ui.notify("`/diff` — no changes", "info");
				return;
			}
			pi.sendMessage<DiffData>(
				{ customType: "codex-diff", content: "", display: true, details: { diff: diff.trimEnd(), untrackedCount: files.length } },
				{ triggerTurn: false },
			);
		},
	});

	// ------------------------------------------------------------------
	// /init — codex's verbatim AGENTS.md prompt (prompt_for_init_command.md)
	// ------------------------------------------------------------------
	pi.registerCommand("init", {
		description: "create an AGENTS.md file with instructions for Codex",
		handler: async () => {
			const prompt = fs.readFileSync(path.join(ASSETS, "init-prompt.md"), "utf-8");
			pi.sendUserMessage(prompt);
		},
	});

	// ------------------------------------------------------------------
	// /mention — mention a file (inserts @ to trigger pi's file autocomplete)
	// ------------------------------------------------------------------
	pi.registerCommand("mention", {
		description: "mention a file",
		handler: async (_args, ctx) => {
			const current = ctx.ui.getEditorText();
			ctx.ui.setEditorText(current + (current && !current.endsWith(" ") ? " @" : "@"));
		},
	});

	// ------------------------------------------------------------------
	// /goal — set or view the goal for a long-running task (goal_display.rs)
	// ------------------------------------------------------------------
	pi.registerCommand("goal", {
		description: "set or view the goal for a long-running task",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "clear") {
				state.goal = undefined;
				ctx.ui.setWidget("codex-goal", undefined);
				ctx.ui.notify("Goal cleared", "info");
				return;
			}
			if (!arg) {
				ctx.ui.notify(state.goal ? `Goal: ${state.goal}` : "No goal set. `/goal <text>` to set one.", "info");
				return;
			}
			state.goal = arg;
			ctx.ui.setWidget("codex-goal", [dim("  goal: ") + arg], { placement: "aboveEditor" });
		},
	});

	// ------------------------------------------------------------------
	// /personality — codex's verbatim personality templates
	// ------------------------------------------------------------------
	pi.registerCommand("personality", {
		description: "choose a communication style for Codex",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select("Personality", ["default", "friendly", "pragmatic"]);
			if (choice === undefined) return;
			state.personality = choice === "default" ? undefined : (choice as CodexState["personality"]);
			ctx.ui.notify(`Personality: ${choice}`, "info");
		},
	});

	// ------------------------------------------------------------------
	// System-prompt injection for goal + personality (per turn)
	// ------------------------------------------------------------------
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.personality && !state.goal) return;
		let prompt = ctx.getSystemPrompt();
		if (state.personality) {
			const template = fs.readFileSync(path.join(ASSETS, "personalities", `${state.personality}.md`), "utf-8");
			prompt += `\n\n${template}`;
		}
		if (state.goal) {
			prompt += `\n\n# Current goal\nThe user set this goal for the ongoing task: ${state.goal}`;
		}
		return { systemPrompt: prompt };
	});
}
