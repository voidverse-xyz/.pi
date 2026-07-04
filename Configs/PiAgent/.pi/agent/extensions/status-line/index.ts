/**
 * Status line footer for Pi — a single line: token/cost usage on the left, a
 * context-usage gauge + other extensions' setStatus() text on the right.
 *
 * The project dir, git segment, and model + thinking all live on their own row
 * above the input editor (the separate dir-git extension), not in this footer.
 *
 * Left: token/cost usage (session + trailing 1h). Right: a context-usage gauge
 * (hard-drive icon + NN%, colored dim -> success -> warning -> error as usage
 * climbs, never a progress bar) followed by any other extension's setStatus()
 * text (codex-usage, command-safety). This extension owns the " | " separators
 * between those segments, so individual extensions emit bare content.
 * Right-aligned segments survive narrow terminals; the left side truncates first.
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

// Renders `left ...gap... right` across the full width, ANSI-aware. Truncates `left`
// first when both sides don't fit, so right-side live stats never silently drop off.
// An empty `left` still right-aligns `right` (leading spaces), rather than leaving it
// flush against the left margin.
function renderSplitLine(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);

	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width);

	if (!left) return `${" ".repeat(width - rightWidth)}${right}`;

	const gap = width - visibleWidth(left) - rightWidth;
	if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;

	const truncatedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
	return `${truncatedLeft} ${right}`;
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

					const usageLine = joinSegments([tokens, costStr, hourlyStr].filter(Boolean), theme.fg("dim", " | "));

					// Context gauge + other extensions' setStatus() text (codex-usage, safety)
					// share the right side. This extension owns the separators: every segment is
					// joined with a single dim " | ", so individual extensions emit bare content
					// (no ad-hoc separators or padding of their own).
					const otherStatuses = Array.from(extensionStatuses.values());
					const rightSide = joinSegments([context, ...otherStatuses], theme.fg("dim", " | "));

					const lines = [
						renderSplitLine(usageLine, rightSide, width),
					];

					return lines;
				},
			};
		});
	});
}
