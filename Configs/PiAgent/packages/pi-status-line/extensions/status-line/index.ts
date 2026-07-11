/**
 * Status line footer for Pi — two stacked lines:
 *   line 1: the subagents agent-chips on the left; a context-usage gauge + every
 *           other extension's setStatus() text on the right
 *   line 2: tool-monitor's shell/tool-call indicator on the left; token/cost usage
 *           on the right
 *
 * The project dir, git segment, and model + thinking all live on their own row
 * above the input editor (the separate dir-git extension), not in this footer.
 *
 * Line 1: the subagents agent-chips sit on the left; the context gauge (hard-drive
 * icon + NN%, colored dim -> success -> warning -> error as usage climbs, never a
 * progress bar) plus every other extension's setStatus() text (codex-usage,
 * command-safety) sit on the right.
 * This extension owns the " | " separators on the right side, so individual
 * extensions emit bare content. When a line is too narrow for both sides, the left
 * side truncates first so the right side stays visible.
 * Line 2 (bottom): tool-monitor's shell/tool-call indicator on the left, token/cost
 * usage (session + trailing 1h) on the right.
 *
 * Configurable via ~/.pi/agent/status-line.json:
 *   { "order": [segment ids], "hidden": [segment ids], "mode": "verbose" | "compact" }
 * Segment ids: subagents, context, extensions, tool-monitor, tokens, cost, hourly.
 * A missing/invalid file (or unknown ids in it) degrades to the defaults — never
 * crashes. Segments not listed in `order` append in default order. `compact` mode
 * drops labels and shrinks separators; below NARROW_WIDTH columns the footer
 * auto-degrades to compact, then drops whole segments from the END of the effective
 * order until both lines fit (never truncates mid-segment into garbage).
 * The /status-line command inspects and persists all of this live.
 *
 * Install: ~/.pi/agent/extensions/status-line/index.ts
 * Reload: /reload
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

function formatContext(ctx: ExtensionContext, theme: ExtensionContext["ui"]["theme"], mode: FooterMode): string {
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
// The subagents extension publishes its agent chips under this key; they render
// on the left of line 1 (ahead of tool-monitor) so the active agent shares a line
// with the context/token statuses instead of taking its own row.
const SUBAGENT_STATUS_KEY = "subagents";

// `left ...gap... right` across the full width, ANSI-aware. When both don't fit,
// truncates the left side first so the right side (context/safety/codex) survives.
// With the segment-dropping fallback in render() this is a last-resort safety net;
// in practice lines arrive here already fitting.
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

// ---------------------------------------------------------------------------
// Configuration — ~/.pi/agent/status-line.json (same idiom as command-safety):
// load on demand with a try/catch fallback to defaults, save best-effort.
// ---------------------------------------------------------------------------

type FooterMode = "verbose" | "compact";

// Stable segment ids, in DEFAULT order. Each renders into a fixed slot (line 1/2,
// left/right side); `order` reorders segments within their slot and sets the
// drop priority (segments are dropped from the END of the effective order first).
const SEGMENT_IDS = ["subagents", "context", "extensions", "tool-monitor", "tokens", "cost", "hourly"] as const;
type SegmentId = (typeof SEGMENT_IDS)[number];

type Slot = "1L" | "1R" | "2L" | "2R";
const SEGMENT_SLOTS: Record<SegmentId, Slot> = {
	subagents: "1L",
	context: "1R",
	extensions: "1R",
	"tool-monitor": "2L",
	tokens: "2R",
	cost: "2R",
	hourly: "2R",
};

const DEFAULT_MODE: FooterMode = "verbose";
// Below this many columns the footer auto-degrades to compact mode (before the
// segment-dropping fallback kicks in).
const NARROW_WIDTH = 80;

const CONFIG_PATH = join(getAgentDir(), "status-line.json");

interface StatusLineConfig {
	// Explicitly-ordered segment ids; ids not listed append in default order.
	order: SegmentId[];
	hidden: SegmentId[];
	mode: FooterMode;
}

function defaultConfig(): StatusLineConfig {
	return { order: [], hidden: [], mode: DEFAULT_MODE };
}

function isSegmentId(value: unknown): value is SegmentId {
	return typeof value === "string" && (SEGMENT_IDS as readonly string[]).includes(value);
}

function isFooterMode(value: unknown): value is FooterMode {
	return value === "verbose" || value === "compact";
}

// Coerces an untrusted JSON value into a deduped list of KNOWN segment ids —
// unknown ids and non-arrays are silently ignored (never crash on bad config).
function toIdList(value: unknown): SegmentId[] {
	if (!Array.isArray(value)) return [];
	const out: SegmentId[] = [];
	for (const entry of value) {
		if (isSegmentId(entry) && !out.includes(entry)) out.push(entry);
	}
	return out;
}

function loadConfig(): StatusLineConfig {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (raw && typeof raw === "object") {
			return {
				order: toIdList(raw.order),
				hidden: toIdList(raw.hidden),
				mode: isFooterMode(raw.mode) ? raw.mode : DEFAULT_MODE,
			};
		}
	} catch {
		// Missing or malformed config — fall back to the defaults.
	}
	return defaultConfig();
}

function saveConfig(config: StatusLineConfig): void {
	try {
		const dir = dirname(CONFIG_PATH);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
	} catch {
		// Best effort: if we can't persist, the config still applies to this session.
	}
}

// Configured order first, then every unlisted segment in default order.
function effectiveOrder(config: StatusLineConfig): SegmentId[] {
	return [...config.order, ...SEGMENT_IDS.filter((id) => !config.order.includes(id))];
}

let currentConfig: StatusLineConfig = loadConfig();

// ---------------------------------------------------------------------------
// Segment rendering
// ---------------------------------------------------------------------------

// Every segment's text for one render pass. Pass-through segments (subagents,
// extensions, tool-monitor) are owned by other extensions and render identically
// in both modes; the mode only shapes this extension's own segments.
function buildSegmentTexts(
	ctx: ExtensionContext,
	theme: ExtensionContext["ui"]["theme"],
	extensionStatuses: ReadonlyMap<string, string>,
	mode: FooterMode,
	separator: string,
): Record<SegmentId, string> {
	const { input, output, cost, lastHour } = collectUsage(ctx);
	const otherStatuses = Array.from(extensionStatuses.entries())
		.filter(([key]) => key !== TOOL_MONITOR_STATUS_KEY && key !== SUBAGENT_STATUS_KEY)
		.map(([, value]) => value);

	return {
		subagents: extensionStatuses.get(SUBAGENT_STATUS_KEY) ?? "",
		context: formatContext(ctx, theme, mode),
		extensions: joinSegments(otherStatuses, separator),
		"tool-monitor": extensionStatuses.get(TOOL_MONITOR_STATUS_KEY) ?? "",
		tokens:
			input > 0 || output > 0
				? theme.fg("dim", `↑${formatTokens(input)} ↓${formatTokens(output)}`)
				: "",
		cost: theme.fg("dim", `$${cost.toFixed(mode === "compact" ? 2 : 3)}`),
		hourly:
			lastHour > 0
				? theme.fg("dim", mode === "compact" ? `1h ${formatTokens(lastHour)}` : `↑/↓ last 1h: ${formatTokens(lastHour)}`)
				: "",
	};
}

interface FooterSides {
	l1: string;
	r1: string;
	l2: string;
	r2: string;
}

function composeSides(active: SegmentId[], texts: Record<SegmentId, string>, separator: string): FooterSides {
	const slot = (which: Slot) =>
		joinSegments(
			active.filter((id) => SEGMENT_SLOTS[id] === which).map((id) => texts[id]),
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

function footerFits(sides: FooterSides, width: number): boolean {
	return sideFits(sides.l1, sides.r1, width) && sideFits(sides.l2, sides.r2, width);
}

export default function (pi: ExtensionAPI) {
	let activeTui: TUI | undefined;

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
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
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

		if (ctx.mode !== "tui") return;

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
	});
}
