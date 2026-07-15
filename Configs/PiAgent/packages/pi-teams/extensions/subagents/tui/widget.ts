/**
 * tui/widget.ts — ambient main-session status (D22). Segments appear only when
 * non-zero; the widget is silent at zero agents.
 *
 *   󰚩 2 running · 1 waiting · 󰇮 3
 *
 * running (running+queued) · waiting (blocked on a pi-safety confirmation) ·
 * unread main mail. No budget segment (D21/D22 — autonomy budget dropped).
 * Published as plain text via setStatus; pi-status-line owns styling.
 */

import type { SubagentsCore } from "../core.ts";

export const AGENTS_ICON = "󰚩"; // nf-md-robot
export const MAIL_ICON = "󰇮"; // nf-md-email

export interface WidgetSnapshot {
	agentCount: number;
	running: number;
	waiting: number;
	unread: number;
}

export function emptySnapshot(): WidgetSnapshot {
	return { agentCount: 0, running: 0, waiting: 0, unread: 0 };
}

export async function takeSnapshot(core: SubagentsCore): Promise<WidgetSnapshot> {
	const roster = await core.status();
	return {
		agentCount: roster.length,
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

/** Production shared-footer text; undefined = hidden (zero agents / nothing to say). */
export function widgetStatusText(snap: WidgetSnapshot): string | undefined {
	if (snap.agentCount === 0) return undefined;
	const segments = widgetSegments(snap);
	return segments.length > 0 ? `${AGENTS_ICON} ${segments.join(" · ")}` : undefined;
}

export interface WidgetController {
	snapshot(): WidgetSnapshot;
	refresh(): void;
	dispose(): void;
}

export interface CreateWidgetControllerOptions {
	core: SubagentsCore;
	/** Called whenever a refresh produced a DIFFERENT snapshot. */
	onChange: () => void;
	pollMs?: number;
}

/** Owns the snapshot cache: refreshes on runtime events + a cheap poll; onChange only on real change. */
export function createWidgetController(options: CreateWidgetControllerOptions): WidgetController {
	const { core, onChange } = options;
	let current = emptySnapshot();
	let disposed = false;
	let refreshing = false;
	let refreshQueued = false;

	const refresh = (): void => {
		if (disposed) return;
		if (refreshing) {
			refreshQueued = true;
			return;
		}
		refreshing = true;
		void takeSnapshot(core)
			.then((next) => {
				if (disposed) return;
				if (JSON.stringify(next) !== JSON.stringify(current)) {
					current = next;
					onChange();
				}
			})
			.catch(() => {})
			.finally(() => {
				refreshing = false;
				if (refreshQueued) {
					refreshQueued = false;
					refresh();
				}
			});
	};

	const offRuntime = core.onEvent(() => refresh());
	const timer = setInterval(refresh, options.pollMs ?? 2000);
	timer.unref?.();
	refresh();

	return {
		snapshot: () => current,
		refresh,
		dispose: () => {
			disposed = true;
			clearInterval(timer);
			offRuntime();
		},
	};
}
