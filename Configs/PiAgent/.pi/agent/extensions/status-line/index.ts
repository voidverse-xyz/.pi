/**
 * Status line footer for Pi — two stacked lines:
 *   line 1: tool-monitor's setStatus() text on the left; a context-usage gauge +
 *           every other extension's setStatus() text on the right
 *   line 2: token/cost usage, directly under it, right-aligned
 *
 * The project dir, git segment, and model + thinking all live on their own row
 * above the input editor (the separate dir-git extension), not in this footer.
 *
 * Line 1: tool-monitor is singled out to sit on the left (its own request); the
 * context gauge (hard-drive icon + NN%, colored dim -> success -> warning -> error
 * as usage climbs, never a progress bar) plus every other extension's setStatus()
 * text (codex-usage, command-safety) sit on the right.
 * This extension owns the " | " separators on the right side, so individual
 * extensions emit bare content. When line 1 is too narrow for both sides, the
 * left (tool-monitor) side truncates first so the right side stays visible.
 * Line 2 (bottom): token/cost usage (session + trailing 1h), right-aligned; when
 * narrow it truncates on the right, so the earliest segments stay visible.
 *
 * Install: ~/.pi/agent/extensions/status-line/index.ts
 * Reload: /reload
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Nerd Font hard-drive glyph for the context-usage gauge (JetBrainsMono NF).
const ICON_HDD = ""; // nf-fa-hdd_o (U+F0A0)

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

const HOUR_MS = 60 * 60 * 1000;

function collectUsage(ctx: ExtensionContext) {
	let input = 0;
	let output = 0;
	let cost = 0;
	let lastHour = 0;
	const hourAgo = Date.now() - HOUR_MS;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			input += message.usage.input;
			output += message.usage.output;
			cost += message.usage.cost.total;
			if (message.timestamp >= hourAgo) {
				lastHour += message.usage.input + message.usage.output;
			}
		}
	}

	return { input, output, cost, lastHour };
}

function contextColor(percent: number): "dim" | "success" | "warning" | "error" {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	if (percent > 50) return "success";
	return "dim";
}

function formatContext(ctx: ExtensionContext, theme: ExtensionContext["ui"]["theme"]): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) {
		return theme.fg("dim", `${ICON_HDD} ?`);
	}

	const color = contextColor(usage.percent);
	return theme.fg(color, `${ICON_HDD} ${usage.percent.toFixed(0)}%`);
}

function joinSegments(segments: string[], separator: string): string {
	return segments.filter((segment) => segment.length > 0).join(separator);
}

// Right-aligns `text` within `width` (ANSI-aware), padding with leading spaces.
// When it does not fit, truncates the end so the leftmost segments stay visible.
function alignRight(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width);
	return `${" ".repeat(width - w)}${text}`;
}

// tool-monitor's setStatus() text renders left-aligned on line 1, with everything
// else (context gauge + other extensions) right-aligned on the same line.
const TOOL_MONITOR_STATUS_KEY = "tool-monitor";

// `left ...gap... right` across the full width, ANSI-aware. When both don't fit,
// truncates the left side first so the right side (context/safety/codex) survives.
function splitLine(left: string, right: string, width: number): string {
	if (!left) return alignRight(right, width);
	if (!right) return truncateToWidth(left, width);

	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const gap = width - leftWidth - rightWidth;
	if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;

	const trimmedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
	return trimmedLeft ? `${trimmedLeft} ${right}` : truncateToWidth(right, width);
}

export default function (pi: ExtensionAPI) {
	let activeTui: TUI | undefined;

	const requestRender = () => {
		activeTui?.requestRender();
	};

	const refreshEvents = ["turn_end", "message_end"] as const;
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

			return {
				dispose() {
					if (activeTui === tui) {
						activeTui = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const { input, output, cost, lastHour } = collectUsage(ctx);

					const tokens =
						input > 0 || output > 0
							? theme.fg("dim", `↑${formatTokens(input)} ↓${formatTokens(output)}`)
							: "";
					const costStr = theme.fg("dim", `$${cost.toFixed(3)}`);
					const hourlyStr = lastHour > 0 ? theme.fg("dim", `↑/↓ last 1h: ${formatTokens(lastHour)}`) : "";
					const context = formatContext(ctx, theme);
					const extensionStatuses = footerData.getExtensionStatuses();

					// Line 1 (top): tool-monitor's setStatus() text on the left, context gauge +
					// every other extension's setStatus() text on the right. This extension owns
					// the separators on the right side: joined with a single dim " | ", so
					// individual extensions emit bare content (no ad-hoc separators of their own).
					const toolMonitorStatus = extensionStatuses.get(TOOL_MONITOR_STATUS_KEY) ?? "";
					const otherStatuses = Array.from(extensionStatuses.entries())
						.filter(([key]) => key !== TOOL_MONITOR_STATUS_KEY)
						.map(([, value]) => value);
					const rightSide = joinSegments([context, ...otherStatuses], theme.fg("dim", " | "));
					// Line 2 (bottom): token/cost usage, stacked directly under the status line.
					const usageLine = joinSegments([tokens, costStr, hourlyStr].filter(Boolean), theme.fg("dim", " | "));

					const lines: string[] = [];
					if (toolMonitorStatus || rightSide) lines.push(splitLine(toolMonitorStatus, rightSide, width));
					if (usageLine) lines.push(alignRight(usageLine, width));

					return lines;
				},
			};
		});
	});
}
