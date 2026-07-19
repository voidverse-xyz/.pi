/**
 * tui/activity.ts — pure helpers that turn session-entry events into the
 * tree-widget's per-agent activity rows (current tool + one-line summary).
 * Lives beside the widget that consumes the shape; the runtime feeds it raw
 * appended entries. PURE — no fs, no session access.
 */

import type { AgentActivity } from "../runtime/types.ts";
import { collapseAndCap } from "../text.ts";

/** Extract the latest tool call from an appended session entry, or null. */
export function extractToolActivity(entry: unknown): AgentActivity | null {
	const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
	if (e?.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) return null;
	for (let i = e.message.content.length - 1; i >= 0; i--) {
		const part = e.message.content[i] as { type?: string; name?: unknown; arguments?: unknown };
		if (part?.type === "toolCall") {
			const tool = String(part.name ?? "?");
			return { tool, summary: toolSummary(tool, part.arguments), toolUses: 0 };
		}
	}
	return null;
}

/** A short one-line summary of a tool call for the tree widget. */
function toolSummary(tool: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const label = tool.charAt(0).toUpperCase() + tool.slice(1);
	const detail =
		typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : typeof a.pattern === "string" ? a.pattern : typeof a.to === "string" ? String(a.to) : "";
	const flat = collapseAndCap(detail, 48);
	return flat ? `${label}: ${flat}` : label;
}
