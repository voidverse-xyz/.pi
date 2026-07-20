import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AnswerState, buildMainAgentMessage, spawnSubagentAnswer } from "./ask.ts";
import { exportPatch } from "./export.ts";
import { escapeTerminalControls } from "./display.ts";
import { collectGitChanges } from "./git.ts";
import { type ChangesPanelOptions, createChangesPanel, type PanelResult } from "./panel.ts";
import { collectChangeset, type FileChange, registerTracker } from "./tracker.ts";
import { undoAllFiles, undoFile } from "./undo.ts";

type BrowserSource = "session" | "git";

interface BrowserOptions {
	source: BrowserSource;
	command: string;
	emptyMessage: string;
	allowUndo: boolean;
	allowExport: boolean;
	collect(): Promise<FileChange[]>;
}

/** What the browser loop does after handling a panel result. */
type Flow = "again" | "exit";

type ResultHandlers = {
	[K in PanelResult["type"]]: (result: Extract<PanelResult, { type: K }>) => Promise<Flow>;
};

export default function changesExtension(pi: ExtensionAPI): void {
	registerTracker(pi);

	const sessionCommand = {
		description: "Browse, question, undo, and export the main agent's file changes this session",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /changes", "error");
				return;
			}
			await runBrowser(pi, ctx, {
				source: "session",
				command: "/changes",
				emptyMessage: "No agent file changes this session",
				allowUndo: true,
				allowExport: true,
				collect: async () => collectChangeset(ctx),
			});
		},
	};
	pi.registerCommand("changes", sessionCommand);
	pi.registerCommand("browse-edits", sessionCommand);

	pi.registerCommand("git-changes", {
		description: "Browse staged, unstaged, untracked, and deleted Git changes",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /git-changes", "error");
				return;
			}
			const shownWarnings = new Set<string>();
			await runBrowser(pi, ctx, {
				source: "git",
				command: "/git-changes",
				emptyMessage: "No uncommitted Git changes",
				allowUndo: false,
				allowExport: false,
				collect: async () => {
					const result = await collectGitChanges(pi, ctx.cwd);
					for (const warning of result.warnings) {
						if (!shownWarnings.has(warning)) {
							shownWarnings.add(warning);
							ctx.ui.notify(warning, "warning");
						}
					}
					return result.changes;
				},
			});
		},
	});
}

function showPanel(
	ctx: ExtensionCommandContext,
	changes: FileChange[],
	initialSelectedAbs: string | undefined,
	initialView: "list" | "answer",
	answer: AnswerState | undefined,
	source: BrowserSource,
	allowUndo: boolean,
	allowExport: boolean,
): Promise<PanelResult> {
	return ctx.ui.custom<PanelResult>(
		(tui, theme, keybindings, done) => {
			const options: ChangesPanelOptions = {
				changes,
				tui,
				theme,
				keybindings,
				onDone: done,
				...(initialSelectedAbs !== undefined ? { initialSelectedAbs } : {}),
				initialView,
				...(answer !== undefined ? { answer } : {}),
				source,
				allowUndo,
				allowExport,
			};
			return createChangesPanel(options);
		},
		{
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
}

async function runBrowser(pi: ExtensionAPI, ctx: ExtensionCommandContext, options: BrowserOptions): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${options.command} requires interactive TUI mode`, "error");
		return;
	}

	let changes: FileChange[];
	try {
		changes = await options.collect();
	} catch (error) {
		ctx.ui.notify(`${options.command} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	if (changes.length === 0) {
		ctx.ui.notify(options.emptyMessage, "info");
		return;
	}

	let selectedAbs: string | undefined = changes[0]!.abs;
	let nextView: "list" | "answer" = "list";
	let currentAnswer: AnswerState | undefined;

	const refresh = async (): Promise<boolean> => {
		try {
			changes = await options.collect();
		} catch (error) {
			ctx.ui.notify(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		if (changes.length > 0 && !changes.some((change) => change.abs === selectedAbs)) selectedAbs = changes[0]!.abs;
		return true;
	};

	// Re-collect after a mutating action; exit the browser when the refresh
	// failed or nothing is left to show.
	const refreshOrExit = async (): Promise<Flow> => {
		if (!(await refresh())) return "exit";
		if (changes.length === 0) {
			ctx.ui.notify(options.emptyMessage, "info");
			return "exit";
		}
		return "again";
	};

	const findChange = (abs: string): FileChange | undefined => changes.find((candidate) => candidate.abs === abs);

	// One handler per panel result type; each says whether the browser loop
	// should show the panel again or exit.
	const resultHandlers: ResultHandlers = {
		close: async () => "exit",
		answerClose: async () => {
			currentAnswer?.kill();
			currentAnswer = undefined;
			return "again";
		},
		undo: async (result) => {
			if (!options.allowUndo) return "again";
			const change = findChange(result.abs);
			if (change) {
				const outcome = await undoFile(pi, ctx, change);
				ctx.ui.notify(outcome.message, outcome.level);
			}
			return refreshOrExit();
		},
		undoAll: async () => {
			if (!options.allowUndo) return "again";
			const outcome = await undoAllFiles(pi, ctx, changes);
			ctx.ui.notify(outcome.message, outcome.level);
			return refreshOrExit();
		},
		exportPatch: async (result) => {
			if (!options.allowExport) return "again";
			const change = findChange(result.abs);
			const exportRoot = options.source === "git" ? (change?.reviewCwd ?? changes[0]?.reviewCwd ?? ctx.cwd) : ctx.cwd;
			const outcome = await exportPatch(exportRoot, changes, change, result.all);
			ctx.ui.notify(outcome.message, outcome.level);
			return "again";
		},
		askMain: async (result) => {
			const change = findChange(result.abs);
			if (change) {
				const question = await ctx.ui.input(`Ask about: ${escapeTerminalControls(change.rel)}`, "Your question…");
				if (question?.trim()) {
					pi.sendUserMessage(buildMainAgentMessage(change, question), { deliverAs: "followUp" });
					await ctx.waitForIdle();
					ctx.ui.notify("Agent answered — check chat, then continue", "info");
				}
			}
			return (await refresh()) && changes.length > 0 ? "again" : "exit";
		},
		askSub: async (result) => {
			const change = findChange(result.abs);
			if (change) {
				const question = await ctx.ui.input(`Ask subagent about: ${escapeTerminalControls(change.rel)}`, "Your question…");
				if (question?.trim()) {
					currentAnswer?.kill();
					currentAnswer = spawnSubagentAnswer(change.reviewCwd ?? ctx.cwd, change, question.trim());
					nextView = "answer";
				}
			}
			return "again";
		},
	};

	try {
		while (true) {
			const result = await showPanel(
				ctx,
				changes,
				selectedAbs,
				nextView,
				currentAnswer,
				options.source,
				options.allowUndo,
				options.allowExport,
			);
			nextView = "list";

			if (!result) break;
			if ("abs" in result && result.abs) selectedAbs = result.abs;

			// Dispatch is type-safe per key; TS can't correlate the runtime key
			// with the payload here, hence the cast.
			const flow = await resultHandlers[result.type](result as never);
			if (flow === "exit") break;
		}
	} finally {
		currentAnswer?.kill();
	}
}
