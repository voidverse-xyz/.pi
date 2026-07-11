/**
 * claude-look — the *Claude Code* appearance as a standalone, exportable pi
 * plugin. Drop it in place of codex-look (same core↔look contract) and pi looks
 * like Claude Code while keeping codex-core's Codex functionality unchanged.
 *
 * Owns: claude-dark/light themes (orange accent), the "✻ Welcome to Claude
 * Code" header, the rounded `>` composer, `⏺`/`⎿` tool rendering, the rotating
 * orange sparkle + gerund working indicator, the footer, and the renderers for
 * codex-core's semantic cards.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHeaderCard } from "./header.ts";
import { renderFooterLine } from "./footer.ts";
import { spinnerFrames, spinnerIntervalMs, pickWord } from "./working.ts";
import { registerClaudeRendering } from "./render.ts";
import { registerCards } from "./cards.ts";
import { registerClaudeComposer } from "./composer.ts";
import { registerWidgets } from "./widgets.ts";
import { installThemes } from "./install-themes.ts";
import { EVT } from "./contract.ts";

const VERSION = "0.1.0";

export default function (pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let mode = "default";
	let sessionSeed = 7;

	pi.events.on(EVT.mode, (data) => { mode = (data as string) ?? "default"; });

	// Make the Claude themes available. Installing them into pi's user themes
	// dir (~/.pi/agent/themes) is the one mechanism that (a) resolves a
	// persisted theme at boot with no error and (b) doesn't collide with a
	// second registration source. pi's file-watch loads them; the setTheme
	// retry below applies once they land.
	const themesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../themes");
	installThemes([path.join(themesDir, "claude-dark.json"), path.join(themesDir, "claude-light.json")]);

	registerCards(pi);
	registerClaudeRendering(pi);
	registerClaudeComposer(pi);
	registerWidgets(pi, () => latestCtx);

	pi.on("model_select", async (_e, ctx) => { latestCtx = ctx; });
	pi.on("turn_start", async (_e, ctx) => {
		latestCtx = ctx;
		// New whimsical gerund each turn, like Claude Code.
		sessionSeed = (sessionSeed * 31 + 7) & 0xffff;
		if (ctx.mode === "tui") ctx.ui.setWorkingIndicator({ frames: spinnerFrames(pickWord(sessionSeed)), intervalMs: spinnerIntervalMs() });
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (ctx.mode !== "tui") return;

		// Always apply the Claude palette; pick light/dark from the active theme.
		// resources_discover themes load asynchronously, so the theme may not be
		// registered yet at session_start — retry until setTheme succeeds.
		const target = /light/i.test(ctx.ui.theme?.name ?? "") ? "claude-light" : "claude-dark";
		let tries = 0;
		const applyTheme = () => {
			if (ctx.ui.theme?.name === target) return;
			const res = ctx.ui.setTheme(target);
			if (!res?.success && tries++ < 40) setTimeout(applyTheme, 50);
		};
		applyTheme();

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return renderHeaderCard(theme, width, { version: VERSION, model: latestCtx?.model?.id ?? "no model", directory: ctx.cwd });
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

		ctx.ui.setWorkingIndicator({ frames: spinnerFrames(pickWord(sessionSeed)), intervalMs: spinnerIntervalMs() });
		ctx.ui.setWorkingMessage(" ");
	});
}
