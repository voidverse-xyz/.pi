/**
 * tui/widget.ts — the ambient main-session widget (05-tui-spec §1, D22).
 *
 *   ⚒ 2 running · 1 waiting · 📬 3 · ⏸ budget 12/40
 *
 * Segments appear only when non-zero: running count · waiting (agents blocked
 * on a human escalation) · unread queued main mail (D16 quiet reports) ·
 * autonomy budget (only once >50% of either pool axis is consumed). When a
 * D21 rail trips the whole widget becomes a single paused BANNER line (with
 * the queued-mail count); at zero agents the widget renders nothing at all —
 * the extension is silent when unused.
 *
 * Placement: ctx.ui.setWidget(..., { placement: "belowEditor" }) — the
 * closest thing the extension API has to "main session footer area".
 * // DEVIATION: the spec says "footer"; ctx.ui.setFooter() REPLACES Pi's
 * built-in footer wholesale (and would fight the status-line extension), so
 * the spec's ambient-footer-widget maps to a belowEditor widget instead.
 *
 * Data flow: rendering is synchronous but roster state is behind an async
 * facade call, so the widget renders from a cached snapshot that is refreshed
 * (a) on every runtime event, (b) on autonomy pause/resume, and (c) by a
 * cheap poll for the figures no event covers (mail counts are directory
 * scans). Refreshes that change nothing don't request a render.
 *
 * No-nested-SGR constraint (hard-won): the paused banner is ONE padded line
 * wrapped in a single bg+fg pair ending in \x1b[0m — the band interior is
 * plain text, never theme.fg()-styled fragments (a nested reset would kill
 * the background for the rest of the line).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentsCore } from "../core.ts";

// Structural slice of the SDK Theme — lets the render fns run under a fake
// theme in the component harness while accepting the real Theme unchanged.
export interface WidgetTheme {
	fg(color: string, text: string): string;
	getFgAnsi(color: string): string;
	getBgAnsi(color: string): string;
}

/** Everything one render pass needs, snapshotted (see module header). */
export interface WidgetSnapshot {
	/** Registry size — 0 hides the widget entirely. */
	agentCount: number;
	running: number;
	/** Agents in `waiting` (blocked on a human escalation — needs eyes). */
	waiting: number;
	/** Unread envelopes in the MAIN mailbox (📬, D16 quiet reports). */
	unread: number;
	/** Unprocessed envelopes across all subagent mailboxes (paused banner). */
	queuedMail: number;
	paused: boolean;
	trippedBy: "turns" | "tokens" | null;
	turnsUsed: number;
	turnsBudget: number;
	tokensUsed: number;
	tokensBudget: number;
}

export function emptySnapshot(): WidgetSnapshot {
	return {
		agentCount: 0,
		running: 0,
		waiting: 0,
		unread: 0,
		queuedMail: 0,
		paused: false,
		trippedBy: null,
		turnsUsed: 0,
		turnsBudget: 0,
		tokensUsed: 0,
		tokensBudget: 0,
	};
}

/** Take a fresh snapshot off the facade (async: status() is a runtime call). */
export async function takeSnapshot(core: SubagentsCore): Promise<WidgetSnapshot> {
	const roster = await core.status();
	const autonomy = core.autonomy.status();
	return {
		agentCount: roster.length,
		running: roster.filter((entry) => entry.state === "running" || entry.state === "queued").length,
		waiting: roster.filter((entry) => entry.state === "waiting").length,
		unread: core.mainUnreadCount(),
		queuedMail: core.queuedMailCount(),
		paused: autonomy.paused,
		trippedBy: autonomy.trippedBy,
		turnsUsed: autonomy.turnsUsed,
		turnsBudget: autonomy.turnsBudget,
		tokensUsed: autonomy.tokensUsed,
		tokensBudget: autonomy.tokensBudget,
	};
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * The budget segment's text, or null while <50% of BOTH axes is consumed
 * (the widget stays quiet until the pool is half gone). Shows whichever axis
 * is closer to tripping.
 */
export function budgetSegmentText(snap: WidgetSnapshot): string | null {
	const turnFrac = snap.turnsBudget > 0 ? snap.turnsUsed / snap.turnsBudget : 0;
	const tokenFrac = snap.tokensBudget > 0 ? snap.tokensUsed / snap.tokensBudget : 0;
	if (turnFrac <= 0.5 && tokenFrac <= 0.5) return null;
	return turnFrac >= tokenFrac
		? `⏸ budget ${snap.turnsUsed}/${snap.turnsBudget}`
		: `⏸ budget ${formatTokens(snap.tokensUsed)}/${formatTokens(snap.tokensBudget)}`;
}

/** ANSI-free segment texts, non-zero only (exported for the harness). */
export function widgetSegments(snap: WidgetSnapshot): string[] {
	const segments: string[] = [];
	if (snap.running > 0) segments.push(`${snap.running} running`);
	if (snap.waiting > 0) segments.push(`${snap.waiting} waiting`);
	if (snap.unread > 0) segments.push(`📬 ${snap.unread}`);
	const budget = budgetSegmentText(snap);
	if (budget !== null) segments.push(budget);
	return segments;
}

/**
 * Truncate PLAIN text to the terminal width (pi-tui's non-overlay render path
 * THROWS on overwide lines and takes the whole host session down with it).
 * Width math goes through pi-tui's own visibleWidth/truncateToWidth so
 * emoji/unicode widths agree with the renderer's accounting — but
 * truncateToWidth wraps its "..." suffix in reset codes, which would nest an
 * SGR inside our single-pair bands, so strip the escapes it injects (the
 * input is plain text, so every escape in the output is its own).
 */
function clipTo(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	// eslint-disable-next-line no-control-regex
	return truncateToWidth(text, width).replace(/\x1b\[[0-9;]*m/g, "");
}

/** Fit plain text to EXACTLY the width: clip when too long, pad when short. */
function fitTo(text: string, width: number): string {
	const clipped = clipTo(text, width);
	const visible = visibleWidth(clipped);
	return visible >= width ? clipped : clipped + " ".repeat(width - visible);
}

/**
 * The paused banner (D21 rail tripped): one full-width band in a SINGLE
 * bg+fg SGR pair, plain-text interior, one reset at the end.
 */
export function renderPausedBanner(snap: WidgetSnapshot, theme: WidgetTheme, width: number): string {
	const by =
		snap.trippedBy === "tokens"
			? `tokens ${formatTokens(snap.tokensUsed)}/${formatTokens(snap.tokensBudget)}`
			: `turns ${snap.turnsUsed}/${snap.turnsBudget}`;
	const mail = snap.queuedMail + snap.unread;
	const text = ` ⏸ subagents paused — autonomy budget spent (${by}) · 📬 ${mail} queued · /subagents resume or your next message resumes `;
	// Truncate BEFORE wrapping in the single bg+fg pair: the interior stays
	// plain text (no nested SGR) and the line can never exceed the terminal.
	return `${theme.getBgAnsi("toolErrorBg")}${theme.getFgAnsi("warning")}${fitTo(text, width)}\x1b[0m`;
}

/**
 * The widget's lines for one render pass. [] = hidden (zero agents, or an
 * idle system with nothing to say).
 */
export function renderWidgetLines(snap: WidgetSnapshot, theme: WidgetTheme, width: number): string[] {
	if (snap.agentCount === 0) return [];
	if (snap.paused) return [renderPausedBanner(snap, theme, width)];
	const segments = widgetSegments(snap);
	if (segments.length === 0) return [];
	const line = `⚒ ${segments.join(" · ")}`;
	// One fg wrap around the WHOLE line (single SGR pair, no nesting).
	return [theme.fg("dim", clipTo(line, width))];
}

// ---------------------------------------------------------------------------
// Live widget wiring (index.ts owns setWidget; this owns refresh mechanics)
// ---------------------------------------------------------------------------

export interface WidgetController {
	/** Current cached snapshot (render side). */
	snapshot(): WidgetSnapshot;
	/** Force a refresh now (event hook). */
	refresh(): void;
	/** Stop the poll + event subscriptions. */
	dispose(): void;
}

export interface CreateWidgetControllerOptions {
	core: SubagentsCore;
	/** Called whenever a refresh produced a DIFFERENT snapshot. */
	onChange: () => void;
	/** Poll interval for un-evented figures (mail counts). Default 2000ms. */
	pollMs?: number;
}

/**
 * Owns the snapshot cache: refreshes on runtime events, autonomy transitions,
 * and a cheap poll; calls onChange (→ tui.requestRender) only on real change.
 */
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
			.catch(() => {
				// A refresh must never break the host TUI.
			})
			.finally(() => {
				refreshing = false;
				if (refreshQueued) {
					refreshQueued = false;
					refresh();
				}
			});
	};

	const offRuntime = core.runtime.onEvent(() => refresh());
	const offAutonomy = core.autonomy.subscribe(() => refresh());
	const timer = setInterval(refresh, options.pollMs ?? 2000);
	// Never keep the process alive for a status poll.
	timer.unref?.();
	refresh();

	return {
		snapshot: () => current,
		refresh,
		dispose: () => {
			disposed = true;
			clearInterval(timer);
			offRuntime();
			offAutonomy();
		},
	};
}
