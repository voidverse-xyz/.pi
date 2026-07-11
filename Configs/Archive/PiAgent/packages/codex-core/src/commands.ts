/**
 * codex-core commands — behavior only. Cards are emitted as custom messages
 * (rendered by the active look plugin); state is broadcast on pi.events.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CARD, EVT, type CodexState, type DiffData, type StatusData } from "./contract.ts";

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");

export function registerCommands(pi: ExtensionAPI, state: CodexState) {
	// /status — session config + token usage (data only; look renders the card)
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
			pi.sendMessage<StatusData>({ customType: CARD.status, content: "", display: true, details: data }, { triggerTurn: false });
		},
	});

	// /diff — git diff incl. untracked
	pi.registerCommand("diff", {
		description: "show git diff (including untracked files)",
		handler: async (_args, ctx) => {
			const inRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
			if (inRepo.code !== 0) {
				ctx.ui.notify("`/diff` — not inside a git repository", "warning");
				return;
			}
			let diff = (await pi.exec("git", ["diff", "HEAD"])).stdout;
			const files = (await pi.exec("git", ["ls-files", "--others", "--exclude-standard"])).stdout.split("\n").filter(Boolean);
			for (const file of files.slice(0, 25)) {
				diff += (await pi.exec("git", ["diff", "--no-index", "/dev/null", file])).stdout;
			}
			if (!diff.trim()) {
				ctx.ui.notify("`/diff` — no changes", "info");
				return;
			}
			pi.sendMessage<DiffData>(
				{ customType: CARD.diff, content: "", display: true, details: { diff: diff.trimEnd(), untrackedCount: files.length } },
				{ triggerTurn: false },
			);
		},
	});

	// /init — codex's verbatim AGENTS.md prompt
	pi.registerCommand("init", {
		description: "create an AGENTS.md file with instructions for Codex",
		handler: async () => pi.sendUserMessage(fs.readFileSync(path.join(ASSETS, "init-prompt.md"), "utf-8")),
	});

	// /mention — insert @ to trigger pi's file autocomplete
	pi.registerCommand("mention", {
		description: "mention a file",
		handler: async (_args, ctx) => {
			const t = ctx.ui.getEditorText();
			ctx.ui.setEditorText(t + (t && !t.endsWith(" ") ? " @" : "@"));
		},
	});

	// /goal — set/view/clear the long-running task goal (broadcast for the look widget)
	pi.registerCommand("goal", {
		description: "set or view the goal for a long-running task",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "clear") {
				state.goal = undefined;
				pi.events.emit(EVT.goal, null);
				ctx.ui.notify("Goal cleared", "info");
				return;
			}
			if (!arg) {
				ctx.ui.notify(state.goal ? `Goal: ${state.goal}` : "No goal set. `/goal <text>` to set one.", "info");
				return;
			}
			state.goal = arg;
			pi.events.emit(EVT.goal, arg);
		},
	});

	// /personality — codex's verbatim personality templates
	pi.registerCommand("personality", {
		description: "choose a communication style for Codex",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select("Personality", ["default", "friendly", "pragmatic"]);
			if (choice === undefined) return;
			state.personality = choice === "default" ? undefined : (choice as CodexState["personality"]);
			ctx.ui.notify(`Personality: ${choice}`, "info");
		},
	});

	// Per-turn system-prompt injection for goal + personality.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.personality && !state.goal) return;
		let prompt = ctx.getSystemPrompt();
		if (state.personality) {
			prompt += `\n\n${fs.readFileSync(path.join(ASSETS, "personalities", `${state.personality}.md`), "utf-8")}`;
		}
		if (state.goal) prompt += `\n\n# Current goal\nThe user set this goal for the ongoing task: ${state.goal}`;
		return { systemPrompt: prompt };
	});
}
