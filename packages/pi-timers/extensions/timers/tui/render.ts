import type { TimerSnapshot } from "../timer-manager.ts";

export const CANCEL_KEY = "alt+r";
export const CANCEL_ALL_VALUE = "cancel-all";
export const TIMER_ICON = "󰔛";

export interface TimerRenderTheme {
	fg(color: string, text: string): string;
}

export interface TimerPickerItem {
	value: string;
	label: string;
	description: string;
}

/** Pure active-timer tree. Width clipping belongs to the TUI adapter. */
export function renderTimerWidgetLines(
	timers: TimerSnapshot[],
	nowMs: number,
	theme: TimerRenderTheme,
): string[] {
	if (timers.length === 0) return [];

	const count = `${timers.length} active`;
	const lines = [
		theme.fg("muted", `${TIMER_ICON} Timers · ${count}`) + theme.fg("dim", ` · ${CANCEL_KEY} cancel`),
	];

	timers.forEach((timer, index) => {
		const last = index === timers.length - 1;
		const branch = last ? "└─" : "├─";
		const continuation = last ? "   " : "│  ";
		const schedule = timer.pending
			? theme.fg("warning", "wake queued")
			: theme.fg("accent", formatCountdown(timer.nextRunAt, nowMs));
		const runLimit = timer.maxRuns === undefined ? "∞" : timer.maxRuns;
		const runs = theme.fg("muted", `${timer.runCount}/${runLimit} runs`);
		const label = theme.fg("text", timer.label);
		const coalesced = timer.skippedTicks > 0
			? theme.fg("dim", ` · ${timer.skippedTicks} coalesced`)
			: "";
		const failures = timer.wakeFailures > 0
			? theme.fg("warning", ` · ${timer.wakeFailures} failed`)
			: "";

		lines.push(
			theme.fg("dim", `${branch} `) +
			`${schedule}${theme.fg("dim", " · ")}${runs}${theme.fg("dim", " · ")}${label}${coalesced}${failures}`,
		);
		lines.push(
			theme.fg("dim", `${continuation}└ ${flattenInstruction(timer.instruction)}`),
		);
	});
	lines.push("");
	return lines;
}

export function buildTimerPickerItems(timers: TimerSnapshot[], nowMs: number): TimerPickerItem[] {
	const items = timers.map((timer) => ({
		value: `timer:${timer.id}`,
		label: `${timer.label} (${timer.id})`,
		description: [
			timer.pending ? "wake queued" : `next ${formatCountdown(timer.nextRunAt, nowMs)}`,
			timer.remainingRuns === undefined ? "no run limit" : `${timer.remainingRuns} remaining`,
		].join(" · "),
	}));
	if (timers.length > 1) {
		items.push({
			value: CANCEL_ALL_VALUE,
			label: `Cancel all ${timers.length} timers`,
			description: "prevent every future wake",
		});
	}
	return items;
}

export function formatCountdown(nextRunAt: number, nowMs: number): string {
	const seconds = Math.max(0, Math.ceil((nextRunAt - nowMs) / 1000));
	if (seconds === 0) return "due";
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) return `${hours}h ${remainingMinutes}m`;

	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return `${days}d ${remainingHours}h`;
}

function flattenInstruction(instruction: string): string {
	return instruction.replace(/\s+/g, " ").trim();
}
