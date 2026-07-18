/**
 * tui/widget.ts — shared status data for the subagents tree widget.
 *
 *   󰚩 2 running · 1 waiting · 󰇮 3
 *
 * running (running+queued) · waiting (blocked on a pi-safety confirmation) ·
 * unread main mail. The tree widget owns presentation; nothing is published to
 * the shared footer/status line.
 */

import type { SubagentsCore } from "../core.ts";

export const AGENTS_ICON = "󰚩"; // nf-md-robot
export const MAIL_ICON = "󰇮"; // nf-md-email

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
