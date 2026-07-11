/**
 * codex-look — the Codex CLI *appearance* as a standalone, exportable pi plugin.
 *
 * Pairs with codex-core (the functionality plugin). This plugin owns every
 * pixel: the codex-dark/light themes, the ">_ OpenAI Codex" header card, the
 * "<model> <mode> · <cwd>" footer, the shimmering Working indicator, the shaded
 * "›" composer, Codex-styled built-in tool rendering, and the renderers for
 * codex-core's semantic cards (see contract.ts).
 *
 * Swap this out for claude-look to change the look — codex-core stays put.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHeaderCard } from "./header.ts";
import { renderFooterLine } from "./footer.ts";
import { shimmerFrames, shimmerIntervalMs } from "./working.ts";
import { registerCodexRendering } from "./render.ts";
import { registerCards } from "./cards.ts";
import { registerCodexComposer } from "./composer.ts";
import { registerWidgets } from "./widgets.ts";
import { installThemes } from "./install-themes.ts";
import { EVT } from "./contract.ts";

const VERSION = "0.1.0";

export default function (pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let mode = "default"; // synced from codex-core via the event bus

	pi.events.on(EVT.mode, (data) => {
		mode = (data as string) ?? "default";
	});

	// Install the Codex themes into pi's user themes dir (~/.pi/agent/themes) so
	// a persisted codex theme resolves at boot with no error and without a
	// dual-source collision. File-watch loads them; the retry below applies.
	const themesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../themes");
	installThemes([path.join(themesDir, "codex-dark.json"), path.join(themesDir, "codex-light.json")]);

	registerCards(pi);
	registerCodexRendering(pi);
	registerCodexComposer(pi);
	registerWidgets(pi, () => latestCtx);

	pi.on("model_select", async (_e, ctx) => { latestCtx = ctx; });
	pi.on("turn_start", async (_e, ctx) => { latestCtx = ctx; });

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (ctx.mode !== "tui") return;

		// Always apply the Codex palette; pick light/dark from the active theme.
		// resources_discover themes load asynchronously — retry until it takes.
		const target = /light/i.test(ctx.ui.theme?.name ?? "") ? "codex-light" : "codex-dark";
		let tries = 0;
		const applyTheme = () => {
			if (ctx.ui.theme?.name === target) return;
			const res = ctx.ui.setTheme(target);
			if (!res?.success && tries++ < 40) setTimeout(applyTheme, 50);
		};
		applyTheme();

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return renderHeaderCard(theme, width, {
					version: VERSION,
					model: latestCtx?.model?.id ?? "no model",
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
					mode,
					directory: ctx.cwd,
					contextPercentUsed: usage?.percent ?? null,
					gitBranch: footerData.getGitBranch() ?? undefined,
				});
			},
			invalidate() {},
		}));

		ctx.ui.setWorkingIndicator({ frames: shimmerFrames(), intervalMs: shimmerIntervalMs() });
		ctx.ui.setWorkingMessage(" ");
	});
}
