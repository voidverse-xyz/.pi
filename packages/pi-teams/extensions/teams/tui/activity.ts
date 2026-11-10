/**
 * tui/activity.ts — pure formatting for live tree-widget tool activity.
 * PURE — no fs or session access.
 */

import { collapseAndCap } from "../text.ts";

/** A short one-line summary of a tool call for the tree widget. */
export function toolSummary(tool: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const label = tool.charAt(0).toUpperCase() + tool.slice(1);
	const detail =
		typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : typeof a.pattern === "string" ? a.pattern : typeof a.to === "string" ? String(a.to) : "";
	const flat = collapseAndCap(detail, 48);
	return flat ? `${label}: ${flat}` : label;
}
