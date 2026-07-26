import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	MAX_INSTRUCTION_CHARS,
	MAX_INTERVAL_MS,
	MAX_LABEL_CHARS,
	MAX_TIMERS,
	MIN_INTERVAL_MS,
	TimerManager,
	type TimerSnapshot,
	type TimerWake,
} from "./timer-manager.ts";
import { createTimerPicker, type TimerPickerResult } from "./tui/picker.ts";
import { CANCEL_KEY } from "./tui/render.ts";
import { createTimerWidget, type TimerWidgetController } from "./tui/widget.ts";

const TOOL_NAME = "manage_timers";
const CUSTOM_TYPE = "pi-timers-wake";

/**
 * Busy hosts queue the wake as a follow-up; idle hosts start a turn. Both
 * options are required because Pi selects one behavior based on current state.
 */
export const WAKE_DELIVERY = { deliverAs: "followUp", triggerTurn: true } as const;

const ManageTimersParams = Type.Object(
	{
		action: StringEnum(["create", "list", "cancel", "cancel_all"] as const, {
			description: "Create, inspect, or cancel main-agent timers.",
		}),
		instruction: Type.Optional(
			Type.String({
				maxLength: MAX_INSTRUCTION_CHARS,
				description: "For create: the instruction sent back to the main agent each time the timer fires.",
			}),
		),
		intervalSeconds: Type.Optional(
			Type.Integer({
				minimum: MIN_INTERVAL_MS / 1000,
				maximum: MAX_INTERVAL_MS / 1000,
				description: "For create: seconds between wake-ups. The first wake occurs after one full interval.",
			}),
		),
		maxRuns: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "For create: optional number of accepted wake-ups before automatic removal. Omit to repeat until cancelled or the session ends.",
			}),
		),
		label: Type.Optional(
			Type.String({
				maxLength: MAX_LABEL_CHARS,
				description: "For create: short human-readable timer label.",
			}),
		),
		timerId: Type.Optional(
			Type.String({
				description: "For cancel: timer id returned by create or list, such as timer-1.",
			}),
		),
	},
	{ additionalProperties: false },
);

export default function timersExtension(pi: ExtensionAPI): void {
	let timers: TimerManager | undefined;
	let activeContext: ExtensionContext | undefined;
	let widget: TimerWidgetController | undefined;
	let pickerOpen = false;

	const getTimers = (): TimerManager => {
		if (!timers) throw new Error("Timers are unavailable because the main session is not active.");
		return timers;
	};

	const injectWake = (wake: TimerWake): void => {
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: buildWakeMessage(wake),
				display: true,
				details: wake,
			},
			WAKE_DELIVERY,
		);
	};

	const applyPickerResult = (manager: TimerManager, result: TimerPickerResult, ctx: ExtensionContext): void => {
		if (result.action === "closed") return;
		if (result.action === "cancel-all") {
			const cancelled = manager.cancelAll();
			const pending = cancelled.filter((timer) => timer.pending).length;
			const pendingNote = pending > 0 ? ` ${pending} accepted wake${pending === 1 ? " may" : "s may"} still run once.` : "";
			ctx.ui.notify(`Cancelled ${cancelled.length} timer${cancelled.length === 1 ? "" : "s"}.${pendingNote}`, "info");
			return;
		}

		const cancelled = manager.cancel(result.timerId);
		if (!cancelled) {
			ctx.ui.notify(`Timer ${result.timerId} is no longer active.`, "warning");
			return;
		}
		const pendingNote = cancelled.pending ? " An accepted wake may still run once." : "";
		ctx.ui.notify(`Cancelled ${cancelled.id} (${cancelled.label}).${pendingNote}`, "info");
	};

	const openCancellationPicker = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The timer cancellation picker is available in interactive mode only.", "warning");
			return;
		}
		if (pickerOpen) return;
		const manager = getTimers();
		const active = manager.list();
		if (active.length === 0) {
			ctx.ui.notify("No main-agent timers are active.", "info");
			return;
		}

		pickerOpen = true;
		let result: TimerPickerResult | undefined;
		try {
			result = await ctx.ui.custom<TimerPickerResult>((tui, theme, _keybindings, done) =>
				createTimerPicker({ timers: active, tui, theme, onDone: done }),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "70%", minWidth: 48, maxHeight: "80%", margin: 1 },
				},
			);
		} finally {
			pickerOpen = false;
		}
		if (result) applyPickerResult(manager, result, ctx);
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Main-agent timers",
		description:
			`Create and manage up to ${MAX_TIMERS} recurring, in-process timers owned by the main Pi agent. ` +
			"Each timer waits one full interval, then sends its stored instruction back to the main agent and triggers a turn. " +
			"Busy turns are never interrupted; one accepted wake may wait as a follow-up, and further ticks for that timer are " +
			"coalesced until the agent settles. Timers disappear on cancellation, after an optional maxRuns limit, or when the Pi " +
			"session reloads, switches, or exits. Subagents cannot use this tool.",
		promptSnippet: "manage_timers — schedule recurring in-process wake-ups for the main agent",
		promptGuidelines: [
			"Use manage_timers only when the user explicitly asks the main agent to perform something later or repeatedly.",
			"For manage_timers create, set maxRuns only when the user requests a finite count; omit it to repeat until cancellation or session shutdown. Tell the user that the first run occurs after one full interval and that timers do not survive reload, session replacement, or process exit.",
			"Do not create replacement timers when a pi-timers wake message arrives; the existing timer already controls recurrence.",
			"Use manage_timers list or cancel when the user asks about or stops scheduled main-agent work. Subagents and procedure workers must not manage timers.",
		],
		parameters: ManageTimersParams,

		async execute(_toolCallId, params) {
			const manager = getTimers();
			switch (params.action) {
				case "create": {
					if (params.instruction === undefined || params.intervalSeconds === undefined) {
						throw new Error("create requires instruction and intervalSeconds.");
					}
					const timer = manager.create({
						instruction: params.instruction,
						intervalMs: params.intervalSeconds * 1000,
						...(params.maxRuns !== undefined ? { maxRuns: params.maxRuns } : {}),
						...(params.label !== undefined ? { label: params.label } : {}),
					});
					const runLimit = timer.maxRuns === undefined
						? "it will repeat until cancelled or the session ends."
						: `it will run at most ${timer.maxRuns} time${timer.maxRuns === 1 ? "" : "s"}.`;
					return toolResult(
						`Created ${timer.id} (${timer.label}). First wake in ${formatDuration(timer.intervalMs)}; ${runLimit}`,
						{ action: "create", timer },
					);
				}
				case "list": {
					const active = manager.list();
					return toolResult(formatTimerList(active), { action: "list", timers: active });
				}
				case "cancel": {
					if (!params.timerId) throw new Error("cancel requires timerId.");
					const cancelled = manager.cancel(params.timerId);
					if (!cancelled) throw new Error(`No active timer has id ${JSON.stringify(params.timerId)}.`);
					const pendingNote = cancelled.pending ? " An already accepted wake may still run once." : "";
					return toolResult(`Cancelled ${cancelled.id} (${cancelled.label}).${pendingNote}`, {
						action: "cancel",
						timer: cancelled,
					});
				}
				case "cancel_all": {
					const cancelled = manager.cancelAll();
					const pending = cancelled.filter((timer) => timer.pending).length;
					const pendingNote = pending > 0 ? ` ${pending} already accepted wake${pending === 1 ? " may" : "s may"} still run once.` : "";
					return toolResult(`Cancelled ${cancelled.length} timer${cancelled.length === 1 ? "" : "s"}.${pendingNote}`, {
						action: "cancel_all",
						timers: cancelled,
					});
				}
			}
		},
	});

	pi.registerCommand("timers", {
		description: `List main-agent timers or cancel them: /timers [cancel [<id>]|cancel-all]. ${CANCEL_KEY} opens the picker.`,
		handler: async (args, ctx) => {
			const manager = getTimers();
			const [action, timerId] = args.trim().split(/\s+/, 2);
			if (!action || action === "list" || action === "status") {
				ctx.ui.notify(formatTimerList(manager.list()), "info");
				return;
			}
			if (action === "cancel" && !timerId) {
				await openCancellationPicker(ctx);
				return;
			}
			if (action === "cancel" && timerId) {
				const cancelled = manager.cancel(timerId);
				ctx.ui.notify(cancelled ? `Cancelled ${timerId}.` : `No active timer has id ${timerId}.`, cancelled ? "info" : "warning");
				return;
			}
			if (action === "cancel-all") {
				const count = manager.cancelAll().length;
				ctx.ui.notify(`Cancelled ${count} timer${count === 1 ? "" : "s"}.`, "info");
				return;
			}
			ctx.ui.notify("Usage: /timers [list|status|cancel [<id>]|cancel-all]", "warning");
		},
	});

	pi.registerShortcut(CANCEL_KEY, {
		description: "Open the active-timer cancellation picker",
		handler: async (ctx) => {
			await openCancellationPicker(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		widget?.dispose();
		widget = undefined;
		timers?.dispose();
		activeContext = ctx;
		const manager = new TimerManager({
			onWake: injectWake,
			onWakeError: (error, timer) => {
				if (!activeContext?.hasUI) return;
				const message = error instanceof Error ? error.message : String(error);
				activeContext.ui.notify(`Timer ${timer.id} could not wake the main agent: ${message}`, "warning");
			},
			onChange: () => widget?.refresh(),
		});
		timers = manager;
		if (ctx.mode === "tui") widget = createTimerWidget(manager, ctx.ui);
	});

	pi.on("agent_settled", () => {
		timers?.markAgentSettled();
	});

	pi.on("session_shutdown", () => {
		widget?.dispose();
		widget = undefined;
		pickerOpen = false;
		timers?.dispose();
		timers = undefined;
		activeContext = undefined;
	});
}

function buildWakeMessage(wake: TimerWake): string {
	const skipped = wake.skippedTicks > 0
		? ` ${wake.skippedTicks} overlapping tick${wake.skippedTicks === 1 ? " was" : "s were"} coalesced.`
		: "";
	const run = wake.maxRuns === undefined
		? `Run ${wake.run} (no run limit).`
		: `Run ${wake.run} of ${wake.maxRuns}${wake.finalRun ? " (final run)" : ""}.`;
	return [
		`[Main-agent timer ${wake.id}: ${wake.label}]`,
		`${run}${skipped}`,
		wake.instruction,
		"Carry out the instruction now in the main agent. Do not create another timer for this recurrence; the existing timer owns the remaining schedule.",
	].join("\n\n");
}

function formatTimerList(timers: TimerSnapshot[]): string {
	if (timers.length === 0) return "No main-agent timers are active.";
	const lines = [`${timers.length} active main-agent timer${timers.length === 1 ? "" : "s"}:`];
	for (const timer of timers) {
		const state = timer.pending ? " · wake pending" : "";
		const skipped = timer.skippedTicks > 0 ? ` · ${timer.skippedTicks} coalesced` : "";
		const runProgress = timer.maxRuns === undefined ? `${timer.runCount}/∞` : `${timer.runCount}/${timer.maxRuns}`;
		lines.push(
			`- ${timer.id} (${timer.label}): ${runProgress} accepted · every ${formatDuration(timer.intervalMs)} · next ${new Date(timer.nextRunAt).toISOString()}${state}${skipped}`,
			`  ${truncateInstruction(timer.instruction)}`,
		);
	}
	return lines.join("\n");
}

function formatDuration(intervalMs: number): string {
	const seconds = intervalMs / 1000;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function truncateInstruction(instruction: string): string {
	const flat = instruction.replace(/\s+/g, " ").trim();
	return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function toolResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
