/**
 * Segment rendering: turns the plain status values that producer extensions
 * publish (plus session usage/context data) into styled footer segments, and
 * composes the active segments into the four footer sides.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { FooterMode, SegmentId } from "./config.ts";

type Theme = ExtensionContext["ui"]["theme"];

// Nerd Font hard-drive glyph for the context-usage gauge (JetBrainsMono NF).
const ICON_HDD = ""; // nf-fa-hdd_o (U+F0A0)
const ICON_INPUT = ""; // nf-fa-long_arrow_up
const ICON_OUTPUT = ""; // nf-fa-long_arrow_down
const ICON_ACTIVITY = ""; // nf-oct-cpu — aggregate token activity

// Reserved plain-text producer keys; buildSegmentTexts styles them and
// composeSides chooses their footer rows.
export const TOOL_MONITOR_STATUS_KEY = "tool-monitor";
export const PLAN_MODE_STATUS_KEY = "plan-mode";
// Subagent status takes line 1-left whenever it is visible.
export const SUBAGENT_STATUS_KEY = "subagents";

export const GIT_STATUS_KEY = "git-status";
export const MODEL_THINKING_STATUS_KEY = "model-thinking";
export const HEADER_STATUS_KEYS = new Set([GIT_STATUS_KEY, MODEL_THINKING_STATUS_KEY]);

type Slot = "1L" | "1R" | "2L" | "2R";
const SEGMENT_SLOTS: Record<SegmentId, Slot> = {
	"plan-mode": "1L",
	subagents: "1L",
	context: "1R",
	"extension-statuses": "1R",
	"tool-monitor": "2L", // composeSides overrides dynamically
	tokens: "2R",
	cost: "2R",
	hourly: "2R",
};

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
			// usage can be absent on an aborted/errored assistant entry — guard so a
			// single such entry doesn't throw inside render() and blank the footer.
			const usage = message.usage;
			if (!usage) continue;
			input += usage.input;
			output += usage.output;
			cost += usage.cost?.total ?? 0;
			if (message.timestamp >= hourAgo) {
				lastHour += usage.input + usage.output;
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

// Theme exposes the resolved error foreground but has no corresponding dark-red
// background slot. Derive a muted burgundy so tool activity remains readable.
function renderToolMonitorStatus(value: string, theme: Theme): string {
	const content = theme.fg("text", ` ${value} `);
	const foreground = theme.getFgAnsi("error");
	const match = foreground.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (!match) return theme.bg("toolErrorBg", content);

	const DARKEN_FACTOR = 0.38;
	const darken = (channel: string) => Math.round(Number(channel) * DARKEN_FACTOR);
	const background = `\x1b[48;2;${darken(match[1]!)};${darken(match[2]!)};${darken(match[3]!)}m`;
	return `${background}${content}\x1b[49m`;
}

function formatContext(ctx: ExtensionContext, theme: Theme, mode: FooterMode): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) {
		return theme.fg("dim", mode === "compact" ? "?%" : `${ICON_HDD} ?`);
	}

	const color = contextColor(usage.percent);
	const value = `${usage.percent.toFixed(0)}%`;
	// compact: the value alone; verbose: hard-drive icon "label" + value.
	return theme.fg(color, mode === "compact" ? value : `${ICON_HDD} ${value}`);
}

function joinSegments(segments: string[], separator: string): string {
	return segments.filter((segment) => segment.length > 0).join(separator);
}

function renderPlanModeStatus(value: string, theme: Theme): string {
	if (!value) return "";
	const color = value.endsWith(" quick mode")
		? "thinkingMinimal"
		: value.endsWith(" discuss mode")
			? "warning"
			: "success";
	return theme.fg(color, value);
}

// Every segment's styled text for one render pass. Producer extensions publish
// plain values; this presenter applies their theme treatment.
export function buildSegmentTexts(
	ctx: ExtensionContext,
	theme: Theme,
	extensionStatuses: ReadonlyMap<string, string>,
	mode: FooterMode,
	separator: string,
): Record<SegmentId, string> {
	const { input, output, cost, lastHour } = collectUsage(ctx);
	const otherStatuses = Array.from(extensionStatuses.entries())
		.filter(([key]) =>
			key !== TOOL_MONITOR_STATUS_KEY
			&& key !== PLAN_MODE_STATUS_KEY
			&& key !== SUBAGENT_STATUS_KEY
			&& !HEADER_STATUS_KEYS.has(key)
		)
		.map(([, value]) => value);

	const planMode = extensionStatuses.get(PLAN_MODE_STATUS_KEY) ?? "";
	const subagents = extensionStatuses.get(SUBAGENT_STATUS_KEY) ?? "";
	const toolMonitor = extensionStatuses.get(TOOL_MONITOR_STATUS_KEY) ?? "";

	return {
		"plan-mode": renderPlanModeStatus(planMode, theme),
		subagents: subagents ? theme.fg("dim", subagents) : "",
		context: formatContext(ctx, theme, mode),
		"extension-statuses": joinSegments(otherStatuses, separator),
		"tool-monitor": toolMonitor ? renderToolMonitorStatus(toolMonitor, theme) : "",
		tokens:
			input > 0 || output > 0
				? theme.fg("dim", `${ICON_INPUT} ${formatTokens(input)} ${ICON_OUTPUT} ${formatTokens(output)}`)
				: "",
		cost: theme.fg("dim", `$${cost.toFixed(mode === "compact" ? 2 : 3)}`),
		hourly:
			lastHour > 0
				? theme.fg("dim", mode === "compact" ? `${ICON_ACTIVITY} 1h ${formatTokens(lastHour)}` : `${ICON_ACTIVITY} last 1h: ${formatTokens(lastHour)}`)
				: "",
	};
}

export interface FooterSides {
	l1: string;
	r1: string;
	l2: string;
	r2: string;
}

export function composeSides(active: SegmentId[], texts: Record<SegmentId, string>, separator: string): FooterSides {
	const subagentsVisible = active.includes("subagents");
	const segmentSlot = (id: SegmentId): Slot =>
		id === "tool-monitor" ? (subagentsVisible ? "2L" : "1L") : SEGMENT_SLOTS[id];
	const slot = (which: Slot) =>
		joinSegments(
			active.filter((id) => segmentSlot(id) === which).map((id) => texts[id]),
			separator,
		);
	return { l1: slot("1L"), r1: slot("1R"), l2: slot("2L"), r2: slot("2R") };
}

function sideFits(left: string, right: string, width: number): boolean {
	const l = left ? visibleWidth(left) : 0;
	const r = right ? visibleWidth(right) : 0;
	const gap = left && right ? 1 : 0;
	return l + r + gap <= width;
}

export function footerFits(sides: FooterSides, width: number): boolean {
	return sideFits(sides.l1, sides.r1, width) && sideFits(sides.l2, sides.r2, width);
}
