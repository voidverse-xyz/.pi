/**
 * codex-pi — Codex CLI look & features for pi.
 *
 * v0.1: the look — codex themes (codex-dark/codex-light), session header card,
 * footer hints, and the shimmering "Working" indicator.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderHeaderCard } from "./header.ts";
import { renderFooterLine } from "./footer.ts";
import { shimmerFrames, shimmerIntervalMs } from "./working.ts";
import { registerCodexRendering } from "./render.ts";
import { registerCodexCommands, type CodexState } from "./commands.ts";
import { registerCodexApprovals } from "./approvals.ts";
import { registerCodexSubagents } from "./subagents.ts";
import { registerCodexPlan, registerCodexReview } from "./plan.ts";
import { registerCodexComposer } from "./composer.ts";

const VERSION = "0.1.0";

export default function (pi: ExtensionAPI) {
	const state: CodexState = {
		approvalMode: "on-request",
		sandboxMode: "workspace-write",
		mode: "default",
	};

	registerCodexRendering(pi);
	registerCodexCommands(pi, state);
	registerCodexApprovals(pi, state);
	registerCodexSubagents(pi);
	registerCodexPlan(pi, state);
	registerCodexReview(pi);
	registerCodexComposer(pi);

	// Latest context, refreshed by events, so components render current data.
	let latestCtx: ExtensionContext | undefined;

	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
	});
	pi.on("turn_start", async (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (ctx.mode !== "tui") return;

		// Map the built-in themes to their codex equivalents; leave any
		// user-picked custom theme alone.
		const currentTheme = ctx.ui.theme?.name;
		if (currentTheme === "dark") ctx.ui.setTheme("codex-dark");
		else if (currentTheme === "light") ctx.ui.setTheme("codex-light");

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const model = latestCtx?.model;
				return renderHeaderCard(theme, width, {
					version: VERSION,
					model: model?.id ?? "no model",
					reasoning: pi.getThinkingLevel(),
					directory: ctx.cwd,
				});
			},
			invalidate() {},
		}));

		ctx.ui.setFooter((_tui, theme, footerData) => ({
			render(width: number): string[] {
				const usage = latestCtx?.getContextUsage();
				return renderFooterLine(theme, width, {
					model: latestCtx?.model?.id ?? ctx.model?.id ?? "no model",
					mode: state.mode,
					directory: ctx.cwd,
					contextPercentUsed: usage?.percent ?? null,
					gitBranch: footerData.getGitBranch() ?? undefined,
				});
			},
			invalidate() {},
		}));

		ctx.ui.setWorkingIndicator({
			frames: shimmerFrames(),
			intervalMs: shimmerIntervalMs(),
		});
		// The shimmer frames ARE the "Working" text; blank out the default label.
		ctx.ui.setWorkingMessage(" ");
	});
}
