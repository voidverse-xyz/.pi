/**
 * Configuration — ~/.pi/agent/status-line.json (extension-local optional settings):
 * load on demand with a try/catch fallback to defaults, save best-effort.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FooterMode = "verbose" | "compact";

// Stable segment ids, in DEFAULT order. Most render into a fixed line/side slot;
// tool-monitor dynamically uses line 1-left when subagents are absent and line
// 2-left when subagents occupy line 1. `order` also sets narrow-width drop priority.
export const SEGMENT_IDS = ["plan-mode", "subagents", "context", "extension-statuses", "tool-monitor", "tokens", "cost", "hourly"] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

export const DEFAULT_MODE: FooterMode = "verbose";
// Below this many columns the footer auto-degrades to compact mode (before the
// segment-dropping fallback kicks in).
export const NARROW_WIDTH = 80;

export const CONFIG_PATH = join(getAgentDir(), "status-line.json");

export interface StatusLineConfig {
	// Explicitly-ordered segment ids; ids not listed append in default order.
	order: SegmentId[];
	hidden: SegmentId[];
	mode: FooterMode;
}

export function defaultConfig(): StatusLineConfig {
	return { order: [], hidden: [], mode: DEFAULT_MODE };
}

export function isSegmentId(value: unknown): value is SegmentId {
	return typeof value === "string" && (SEGMENT_IDS as readonly string[]).includes(value);
}

export function isFooterMode(value: unknown): value is FooterMode {
	return value === "verbose" || value === "compact";
}

// Coerces an untrusted JSON value into a deduped list of KNOWN segment ids —
// unknown ids and non-arrays are silently ignored (never crash on bad config).
// Preserve configs written before `extensions` was renamed to `extension-statuses`.
function toIdList(value: unknown): SegmentId[] {
	if (!Array.isArray(value)) return [];
	const out: SegmentId[] = [];
	for (const entry of value) {
		const id = entry === "extensions" ? "extension-statuses" : entry;
		if (isSegmentId(id) && !out.includes(id)) out.push(id);
	}
	return out;
}

export function loadConfig(): StatusLineConfig {
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

export function saveConfig(config: StatusLineConfig): void {
	try {
		const dir = dirname(CONFIG_PATH);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
	} catch {
		// Best effort: if we can't persist, the config still applies to this session.
	}
}

// Configured order first, then every unlisted segment in default order.
export function effectiveOrder(config: StatusLineConfig): SegmentId[] {
	return [...config.order, ...SEGMENT_IDS.filter((id) => !config.order.includes(id))];
}
