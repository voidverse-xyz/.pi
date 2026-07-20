/**
 * Shared status layout for Pi:
 *   above editor: project/Git status on the left; model + thinking on the right
 *   footer line 1: Plan mode + subagent status on the left; otherwise tool activity;
 *                  context + extension statuses on the right
 *   footer line 2: tool activity on the left when subagents occupy line 1;
 *                  token/cost usage on the right
 *
 * pi-git-status, pi-model-thinking, pi-agents, and pi-tool-monitor publish plain
 * status values. This extension owns their positioning and theme presentation.
 *
 * The context gauge and generic extension statuses stay on line 1-right; token/cost
 * usage stays on line 2-right. Subagents claim line 1-left only while visible, so
 * tool-monitor can move up from line 2-left when that space is vacant. This extension
 * owns separators and truncation; left sides yield first so right data stays visible.
 *
 * Configurable via ~/.pi/agent/status-line.json:
 *   { "order": [segment ids], "hidden": [segment ids], "mode": "verbose" | "compact" }
 * Segment ids: plan-mode, subagents, context, extension-statuses, tool-monitor, tokens, cost, hourly.
 * A missing/invalid file (or unknown ids in it) degrades to the defaults — never
 * crashes. Segments not listed in `order` append in default order. `compact` mode
 * drops labels and shrinks separators; below NARROW_WIDTH columns the footer
 * auto-degrades to compact, then drops whole segments from the END of the effective
 * order until both lines fit (never truncates mid-segment into garbage).
 * The /status-line command inspects and persists all of this live.
 *
 * Config persistence lives in ./config.ts; segment styling/composition in
 * ./segments.ts. This file is the wiring: the /status-line command plus the
 * header widget and footer mounting.
 *
 * Enable the pi-status-line package in settings.json.
 * Reload: /reload
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	CONFIG_PATH,
	defaultConfig,
	effectiveOrder,
	type FooterMode,
	isFooterMode,
	isSegmentId,
	loadConfig,
	NARROW_WIDTH,
	saveConfig,
	SEGMENT_IDS,
	type StatusLineConfig,
} from "./config.ts";
import {
	buildSegmentTexts,
	composeSides,
	footerFits,
	GIT_STATUS_KEY,
	MODEL_THINKING_STATUS_KEY,
} from "./segments.ts";

const HEADER_WIDGET_KEY = "status-line-header";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Right-aligns `text` within `width` (ANSI-aware), padding with leading spaces.
// When it does not fit, truncates the end so the leftmost segments stay visible.
function alignRight(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width);
	return `${" ".repeat(width - w)}${text}`;
}

// `left ...gap... right` across the full width, ANSI-aware. When both don't fit,
// truncates the left side first so the right side (context/safety/codex) survives.
// With the segment-dropping fallback in render() this is a last-resort safety net;
// in practice lines arrive here already fitting.
function splitLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!left) return alignRight(right, width);
	if (!right) return truncateToWidth(left, width);

	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const gap = width - leftWidth - rightWidth;
	if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;

	const trimmedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
	return trimmedLeft ? `${trimmedLeft} ${right}` : truncateToWidth(right, width);
}

// Header-specific split preserves the previous row behavior: keep the complete
// right side whenever possible, truncate Git first, and use an ellipsis.
function splitHeaderLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "…");
	const availableLeft = Math.max(0, width - rightWidth - 1);
	const fittedLeft = truncateToWidth(left, availableLeft, "…");
	const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
	return `${fittedLeft}${" ".repeat(gap)}${right}`;
}

function renderModelThinkingStatus(
	value: string,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const match = value.match(/^(.*) · (off|minimal|low|medium|high|xhigh|max)$/);
	if (!match) return theme.fg("dim", value);

	const model = theme.fg("dim", match[1] ?? "no-model");
	const thinking = match[2] as ThinkingLevel;
	if (thinking === "off") return model;

	const color = (() => {
		switch (thinking) {
			case "minimal": return "thinkingMinimal" as const;
			case "low": return "thinkingLow" as const;
			case "medium": return "thinkingMedium" as const;
			case "high": return "thinkingHigh" as const;
			case "xhigh": return "thinkingXhigh" as const;
			case "max": return "thinkingMax" as const;
		}
	})();
	return `${model}${theme.fg("dim", " · ")}${theme.fg(color, thinking)}`;
}

function renderHeader(
	extensionStatuses: ReadonlyMap<string, string>,
	theme: ExtensionContext["ui"]["theme"],
	width: number,
): string[] {
	const leftValue = extensionStatuses.get(GIT_STATUS_KEY) ?? "";
	const rightValue = extensionStatuses.get(MODEL_THINKING_STATUS_KEY) ?? "";
	if (!leftValue && !rightValue) return [];

	const left = leftValue ? theme.fg("dim", leftValue) : "";
	const right = rightValue ? renderModelThinkingStatus(rightValue, theme) : "";
	return [splitHeaderLine(left, right, width)];
}

let currentConfig: StatusLineConfig = loadConfig();

export default function (pi: ExtensionAPI) {
	let activeTui: TUI | undefined;
	let getExtensionStatuses: (() => ReadonlyMap<string, string>) | undefined;
	let pinHeader: (() => void) | undefined;
	let headerPinTimer: ReturnType<typeof setInterval> | undefined;

	pi.events.on("status-line:pin-header", () => pinHeader?.());

	const requestRender = () => {
		activeTui?.requestRender();
	};

	pi.on("turn_end", () => {
		requestRender();
	});
	pi.on("message_end", () => {
		requestRender();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		activeTui = undefined;
		getExtensionStatuses = undefined;
		pinHeader = undefined;
		if (headerPinTimer) {
			clearInterval(headerPinTimer);
			headerPinTimer = undefined;
		}
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(HEADER_WIDGET_KEY, undefined, { placement: "aboveEditor" });
			ctx.ui.setFooter(undefined);
		}
	});

	pi.registerCommand("status-line", {
		description: "Footer config: mode <verbose|compact> | hide <id> | show <id> | reset (persisted)",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.replace(/^\s+/, "");
			const spaceAt = trimmed.search(/\s/);
			if (spaceAt === -1) {
				// Completing the subcommand itself.
				const items = ["mode", "hide", "show", "reset"]
					.filter((sub) => sub.startsWith(trimmed))
					.map((sub) => ({ value: sub, label: sub }));
				return items.length > 0 ? items : null;
			}
			const sub = trimmed.slice(0, spaceAt);
			const arg = trimmed.slice(spaceAt).trim();
			if (sub === "mode") {
				const items = (["verbose", "compact"] as const)
					.filter((m) => m.startsWith(arg))
					.map((m) => ({ value: `mode ${m}`, label: `${m}${m === currentConfig.mode ? " (current)" : ""}` }));
				return items.length > 0 ? items : null;
			}
			if (sub === "hide" || sub === "show") {
				const hidden = new Set(currentConfig.hidden);
				const items = SEGMENT_IDS.filter((id) => id.startsWith(arg))
					.filter((id) => (sub === "hide" ? !hidden.has(id) : hidden.has(id)))
					.map((id) => ({ value: `${sub} ${id}`, label: id }));
				return items.length > 0 ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
			const [sub, arg] = parts;

			if (!sub) {
				const hidden = new Set(currentConfig.hidden);
				const orderLine = effectiveOrder(currentConfig)
					.map((id) => (hidden.has(id) ? `${id} (hidden)` : id))
					.join(", ");
				const lines = [
					`Status line: mode ${currentConfig.mode} (auto-compact below ${NARROW_WIDTH} cols)`,
					`  order:  ${orderLine}`,
					`  hidden: ${currentConfig.hidden.length > 0 ? currentConfig.hidden.join(", ") : "(none)"}`,
					`  config: ${CONFIG_PATH}`,
					`Usage: /status-line mode <verbose|compact> | hide <id> | show <id> | reset`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "mode") {
				if (!isFooterMode(arg)) {
					ctx.ui.notify(`Usage: /status-line mode <verbose|compact>`, "error");
					return;
				}
				currentConfig = { ...currentConfig, mode: arg };
				saveConfig(currentConfig);
				requestRender();
				ctx.ui.notify(`Status line mode: ${arg}`, "info");
				return;
			}

			if (sub === "hide" || sub === "show") {
				if (!isSegmentId(arg)) {
					ctx.ui.notify(`Unknown segment "${arg ?? ""}". Segments: ${SEGMENT_IDS.join(", ")}`, "error");
					return;
				}
				const hidden = currentConfig.hidden.filter((id) => id !== arg);
				if (sub === "hide") hidden.push(arg);
				currentConfig = { ...currentConfig, hidden };
				saveConfig(currentConfig);
				requestRender();
				ctx.ui.notify(`Status line: ${sub === "hide" ? "hid" : "showing"} ${arg}`, "info");
				return;
			}

			if (sub === "reset") {
				currentConfig = defaultConfig();
				saveConfig(currentConfig);
				requestRender();
				ctx.ui.notify("Status line: reset to defaults", "info");
				return;
			}

			ctx.ui.notify(`Unknown subcommand "${sub}". Usage: /status-line mode <verbose|compact> | hide <id> | show <id> | reset`, "error");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// Reload from disk in case the file changed between sessions in this process.
		currentConfig = loadConfig();
		pinHeader = undefined;

		if (ctx.mode !== "tui") return;

		getExtensionStatuses = undefined;
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			getExtensionStatuses = () => footerData.getExtensionStatuses();

			return {
				dispose() {
					if (activeTui === tui) {
						activeTui = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					// Narrow terminals auto-degrade to compact before dropping segments.
					const mode: FooterMode = width < NARROW_WIDTH ? "compact" : currentConfig.mode;
					// This extension owns the separators: a single dim " | " in verbose mode,
					// a bare space in compact mode, so individual extensions emit bare content.
					const separator = mode === "compact" ? " " : theme.fg("dim", " | ");
					const extensionStatuses = footerData.getExtensionStatuses();
					const texts = buildSegmentTexts(ctx, theme, extensionStatuses, mode, separator);

					const hidden = new Set(currentConfig.hidden);
					let active = effectiveOrder(currentConfig).filter((id) => !hidden.has(id) && texts[id].length > 0);

					// Fallback for very narrow widths: drop whole segments from the END of
					// the effective order until both lines fit — whole segments only, never
					// a mid-segment truncation into garbage.
					let sides = composeSides(active, texts, separator);
					while (active.length > 0 && !footerFits(sides, width)) {
						active = active.slice(0, -1);
						sides = composeSides(active, texts, separator);
					}

					const lines: string[] = [];
					if (sides.l1 || sides.r1) lines.push(splitLine(sides.l1, sides.r1, width));
					if (sides.l2 || sides.r2) lines.push(splitLine(sides.l2, sides.r2, width));

					return lines;
				},
			};
		});

		// The project/Git + model row is the STATUS BAR of the widget stack: it
		// belongs directly above the editor, below every content widget (todo list,
		// teams/subagents trees) — those sit under the working indicator. pi core
		// keeps aboveEditor widgets in a Map where every setWidget call moves that
		// key to the END (= rendered bottom-most), so any widget that refreshes its
		// content would otherwise hop BELOW this static row. Pin the row to the
		// bottom on a slow safety tick; late-mounted content widgets can also emit
		// `status-line:pin-header` for an immediate, deterministic re-pin.
		pinHeader = (): void => {
			ctx.ui.setWidget(
				HEADER_WIDGET_KEY,
				(_tui, theme) => ({
					invalidate() {},
					render(width: number): string[] {
						const extensionStatuses = getExtensionStatuses?.();
						return extensionStatuses ? renderHeader(extensionStatuses, theme, width) : [];
					},
				}),
				{ placement: "aboveEditor" },
			);
		};
		pinHeader();
		if (headerPinTimer) clearInterval(headerPinTimer);
		headerPinTimer = setInterval(() => pinHeader?.(), 1000);
		headerPinTimer.unref?.();
	});
}
