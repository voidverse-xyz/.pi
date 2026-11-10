/**
 * tui/widget.ts — shared status data for the subagents tree widget.
 *
 *    2 running · 1 waiting · 󰇮 3
 *
 * running (running+queued) · waiting (blocked on a pi-safety confirmation) ·
 * unread main mail. The tree widget owns presentation; nothing is published to
 * the shared footer/status line.
 */

import type { SubagentsCore } from "../core.ts";

export const AGENTS_ICON = ""; // nf-cod-list_tree
export const MAIL_ICON = "󰇮"; // nf-md-email

/** Match Pi's compact token counters across subagent TUI surfaces. */
export function formatTokens(count: number): string {
	const safe = Math.max(0, Math.round(count));
	if (safe < 1_000) return String(safe);
	if (safe < 10_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000) return `${Math.round(safe / 1_000)}k`;
	if (safe < 10_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${Math.round(safe / 1_000_000)}M`;
}

export interface WidgetSnapshot {
	running: number;
	waiting: number;
	unread: number;
}

export function emptySnapshot(): WidgetSnapshot {
	return { running: 0, waiting: 0, unread: 0 };
}

export async function takeSnapshot(core: SubagentsCore): Promise<WidgetSnapshot> {
	const roster = await core.status();
	return {
		running: roster.filter((e) => e.state === "running" || e.state === "queued").length,
		waiting: roster.filter((e) => e.state === "waiting").length,
		unread: core.mainUnreadCount(),
	};
}

/** ANSI-free segment texts, non-zero only (exported for the harness). */
export function widgetSegments(snap: WidgetSnapshot): string[] {
	const segments: string[] = [];
	if (snap.running > 0) segments.push(`${snap.running} running`);
	if (snap.waiting > 0) segments.push(`${snap.waiting} waiting`);
	if (snap.unread > 0) segments.push(`${MAIL_ICON} ${snap.unread}`);
	return segments;
}
