/**
 * /browse-edits — a native TUI to browse, diff, question, and undo the agent's own
 * file changes this session (git-free).
 *
 * The extension has two halves: a background tracker (registerTracker) that records
 * pre-image baselines as the agent edits, and the /browse-edits command — a command loop
 * that collects the changeset, shows the full-screen panel, and services the actions
 * the panel resolves (ask main agent / ask subagent / undo), reopening the panel
 * after each.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AnswerState, buildMainAgentMessage, spawnSubagentAnswer } from "./ask.ts";
import { type ChangesPanelOptions, createChangesPanel, type PanelResult } from "./panel.ts";
import { collectChangeset, type FileChange, registerTracker } from "./tracker.ts";
import { undoFile } from "./undo.ts";

export default function changesExtension(pi: ExtensionAPI): void {
	registerTracker(pi);

	pi.registerCommand("browse-edits", {
		description: "Browse, diff, question, and undo the agent's file changes this session",
		handler: async (_args, ctx) => runChanges(pi, ctx),
	});
}

function showPanel(
	ctx: ExtensionCommandContext,
	changes: FileChange[],
	initialSelectedAbs: string | undefined,
	initialView: "list" | "answer",
	answer: AnswerState | undefined,
): Promise<PanelResult> {
	return ctx.ui.custom<PanelResult>(
		(tui, theme, keybindings, done) => {
			const options: ChangesPanelOptions = {
				changes,
				tui,
				theme,
				keybindings,
				onDone: done,
				initialSelectedAbs,
				initialView,
				answer,
			};
			return createChangesPanel(options);
		},
		{
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
}

async function runChanges(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/browse-edits requires interactive TUI mode", "error");
		return;
	}

	let changes = collectChangeset(ctx);
	if (changes.length === 0) {
		ctx.ui.notify("No agent file changes this session", "info");
		return;
	}

	let selectedAbs: string | undefined = changes[0]!.abs;
	let nextView: "list" | "answer" = "list";
	let currentAnswer: AnswerState | undefined;

	const refresh = () => {
		changes = collectChangeset(ctx);
		if (changes.length > 0 && !changes.some((c) => c.abs === selectedAbs)) {
			selectedAbs = changes[0]!.abs;
		}
	};

	try {
		while (true) {
			const result = await showPanel(ctx, changes, selectedAbs, nextView, currentAnswer);
			nextView = "list";

			if (!result || result.type === "close") break;
			if ("abs" in result && result.abs) selectedAbs = result.abs;

			if (result.type === "answerClose") {
				currentAnswer?.kill();
				currentAnswer = undefined;
				continue;
			}

			if (result.type === "undo") {
				const fc = changes.find((c) => c.abs === result.abs);
				if (fc) {
					const outcome = await undoFile(pi, ctx, fc);
					ctx.ui.notify(outcome.message, outcome.level);
				}
				refresh();
				if (changes.length === 0) {
					ctx.ui.notify("No agent file changes remain", "info");
					break;
				}
				continue;
			}

			if (result.type === "askMain") {
				const fc = changes.find((c) => c.abs === result.abs);
				if (fc) {
					const q = await ctx.ui.input(`Ask about: ${fc.rel}`, "Your question…");
					if (q?.trim()) {
						pi.sendUserMessage(buildMainAgentMessage(fc, q), { deliverAs: "followUp" });
						await ctx.waitForIdle();
						ctx.ui.notify("Agent answered — check chat, then continue", "info");
					}
				}
				refresh();
				if (changes.length === 0) break;
				continue;
			}

			if (result.type === "askSub") {
				const fc = changes.find((c) => c.abs === result.abs);
				if (fc) {
					const q = await ctx.ui.input(`Ask subagent about: ${fc.rel}`, "Your question…");
					if (q?.trim()) {
						currentAnswer?.kill();
						currentAnswer = spawnSubagentAnswer(ctx.cwd, fc, q.trim());
						nextView = "answer";
					}
				}
				continue;
			}
		}
	} finally {
		currentAnswer?.kill();
	}
}
