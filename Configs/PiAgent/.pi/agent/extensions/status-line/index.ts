/**
 * Full status line for Pi — tokens, cost, model, thinking, context %, git branch, cwd.
 *
 * Install: ~/.pi/agent/extensions/status-line/index.ts
 * Reload: /reload
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function collectUsage(ctx: ExtensionContext) {
	let input = 0;
	let output = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			input += message.usage.input;
			output += message.usage.output;
			cost += message.usage.cost.total;
		}
	}

	return { input, output, cost };
}

function formatContext(ctx: ExtensionContext, theme: ExtensionContext["ui"]["theme"]): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) {
		return theme.fg("dim", "ctx ?");
	}

	const label = `ctx ${usage.percent.toFixed(0)}%`;
	if (usage.percent > 90) return theme.fg("error", label);
	if (usage.percent > 70) return theme.fg("warning", label);
	return theme.fg("dim", label);
}

function joinSegments(segments: string[], separator: string): string {
	return segments.filter((segment) => segment.length > 0).join(separator);
}

export default function (pi: ExtensionAPI) {
	let activeTui: TUI | undefined;

	const requestRender = () => {
		activeTui?.requestRender();
	};

	const refreshEvents = ["turn_end", "message_end", "model_select", "thinking_level_select"] as const;
	for (const event of refreshEvents) {
		pi.on(event, () => {
			requestRender();
		});
	}

	pi.on("session_shutdown", () => {
		activeTui = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubBranch();
					if (activeTui === tui) {
						activeTui = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const { input, output, cost } = collectUsage(ctx);
					const thinking = pi.getThinkingLevel();
					const modelId = ctx.model?.id ?? "no-model";
					const branch = footerData.getGitBranch();
					const cwd = formatCwd(ctx.sessionManager.getCwd());

					const tokens =
						input > 0 || output > 0
							? theme.fg("dim", `↑${formatTokens(input)} ↓${formatTokens(output)}`)
							: "";
					const costStr = theme.fg("dim", `$${cost.toFixed(3)}`);
					const modelThinking =
						thinking === "off"
							? theme.fg("dim", `${modelId}`)
							: theme.fg("dim", `${modelId} · ${thinking}`);
					const context = formatContext(ctx, theme);
					const branchStr = branch ? theme.fg("dim", branch) : "";

					const statsLine = joinSegments(
						[joinSegments([tokens, costStr].filter(Boolean), " "), modelThinking, context, branchStr],
						theme.fg("dim", " │ "),
					);

					const cwdLine = theme.fg("dim", cwd);
					const lines = [truncateToWidth(cwdLine, width), truncateToWidth(statsLine, width)];

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.values()).join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
