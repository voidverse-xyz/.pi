/**
 * Live tool-execution monitor.
 *
 * Tracks every tool call via tool_execution_start/update/end and exposes it two ways:
 *
 * 1. A small persistent widget, bottom-left (placement "belowEditor", plain left-aligned
 *    text — no background fill, no centering, colored "dim" to match the rest of
 *    status-line's segments), always showing one line: ">_ · <names>" while tools
 *    run, or ">_ · none" when idle.
 *
 * 2. `/tools` — a full-screen floating overlay (ctx.ui.custom, evenly inset on all sides
 *    via overlayOptions.margin) listing running + recent tool calls. Arrow keys + Enter
 *    drill into one to see its live streaming output; Escape/'b' goes back to the list;
 *    Escape/'q'/Ctrl+C closes the overlay entirely.
 *
 * No true mouse/click support: Pi's extension API has no structured mouse/hit-testing
 * primitive, only raw terminal input (ctx.ui.onTerminalInput) — building real clicking
 * would mean hand-parsing raw SGR mouse escape sequences and guessing our own screen
 * coordinates, which is fragile across terminals. `/tools` is the reliable entry point.
 *
 * "Send close signal" from the detail view (key: x) calls ctx.abort() — the only abort
 * primitive Pi exposes to extensions. It stops the whole current turn, not just the one
 * tool, since there's no per-tool-call cancel in the SDK.
 *
 * Install: ~/.pi/agent/extensions/tool-monitor/index.ts
 * Reload: /reload
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const WIDGET_KEY = "tool-monitor-active";
const MAX_FINISHED_HISTORY = 100;
const WIDGET_ICON = ">_"; // terminal prompt - plain ASCII, not a Nerd Font glyph

type ToolStatus = "running" | "done" | "error";

interface ToolRun {
	id: string;
	name: string;
	args: unknown;
	status: ToolStatus;
	startedAt: number;
	endedAt: number | null;
	partialResult: unknown;
	result: unknown;
}

function summarize(value: unknown): string {
	if (value === undefined) return "(none yet)";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function statusLabel(status: ToolStatus): string {
	if (status === "running") return "[running]";
	if (status === "error") return "[error]";
	return "[done]";
}

function statusColor(status: ToolStatus): "warning" | "error" | "success" {
	if (status === "running") return "warning";
	if (status === "error") return "error";
	return "success";
}

// Full-screen /tools overlay: a hand-rolled two-mode (list/detail) component. Not built on
// pi-tui's SelectList since that only accepts its item array at construction time — there's
// no way to refresh it in place as tool runs start/finish while the overlay is open.
class ToolMonitorComponent {
	private mode: "list" | "detail" = "list";
	private selectedIndex = 0;
	private selectedId: string | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly ctx: ExtensionCommandContext,
		private readonly runs: Map<string, ToolRun>,
		private readonly order: string[],
	) {}

	invalidate(): void {}

	private currentItems(): ToolRun[] {
		const items: ToolRun[] = [];
		for (let i = this.order.length - 1; i >= 0; i--) {
			const run = this.runs.get(this.order[i]);
			if (run) items.push(run);
		}
		return items;
	}

	handleInput(data: string): void {
		if (this.mode === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
		this.tui.requestRender();
	}

	private handleListInput(data: string): void {
		const items = this.currentItems();
		if (matchesKey(data, "up")) {
			this.selectedIndex = items.length === 0 ? 0 : (this.selectedIndex - 1 + items.length) % items.length;
		} else if (matchesKey(data, "down")) {
			this.selectedIndex = items.length === 0 ? 0 : (this.selectedIndex + 1) % items.length;
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const item = items[this.selectedIndex];
			if (item) {
				this.selectedId = item.id;
				this.mode = "detail";
			}
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, "escape") || data === "b") {
			this.mode = "list";
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (data === "x") {
			const run = this.selectedId ? this.runs.get(this.selectedId) : undefined;
			if (run?.status === "running") {
				this.ctx.abort();
				this.ctx.ui.notify("Sent abort (stops the whole current turn - Pi has no per-tool abort).", "warning");
			} else {
				this.ctx.ui.notify("That tool call already finished - nothing to abort.", "info");
			}
		}
	}

	render(width: number): string[] {
		return this.mode === "list" ? this.renderList(width) : this.renderDetail(width);
	}

	private renderList(width: number): string[] {
		const items = this.currentItems();
		const lines: string[] = [
			this.theme.fg("accent", "Tool Monitor"),
			this.theme.fg("dim", "up/down: navigate  enter: view  esc/q: close"),
			"",
		];

		if (items.length === 0) {
			lines.push(this.theme.fg("dim", "No tool executions yet."));
			return lines;
		}

		items.forEach((run, index) => {
			const marker = index === this.selectedIndex ? ">" : " ";
			const label = `${marker} ${run.name} ${statusLabel(run.status)}`;
			lines.push(truncateToWidth(this.theme.fg(statusColor(run.status), label), width));
		});
		return lines;
	}

	private renderDetail(width: number): string[] {
		const run = this.selectedId ? this.runs.get(this.selectedId) : undefined;
		if (!run) {
			this.mode = "list";
			return this.renderList(width);
		}

		const lines: string[] = [
			this.theme.fg("accent", `Tool: ${run.name}`),
			this.theme.fg(statusColor(run.status), `Status: ${run.status}`),
			this.theme.fg("dim", "esc/b: back  x: abort (stops whole turn)  ctrl+c: close"),
			"",
			this.theme.fg("dim", "Args:"),
			...wrapTextWithAnsi(summarize(run.args), width),
			"",
			this.theme.fg("dim", run.status === "running" ? "Live output:" : "Result:"),
			...wrapTextWithAnsi(summarize(run.status === "running" ? run.partialResult : run.result), width),
		];
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const runs = new Map<string, ToolRun>();
	const order: string[] = [];
	let activeTui: TUI | undefined;

	const requestRender = () => activeTui?.requestRender();

	const trimFinishedHistory = () => {
		const finishedIds = order.filter((id) => runs.get(id)?.status !== "running");
		const excess = finishedIds.length - MAX_FINISHED_HISTORY;
		if (excess <= 0) return;
		const toDrop = new Set(finishedIds.slice(0, excess));
		for (const id of toDrop) {
			runs.delete(id);
			const idx = order.indexOf(id);
			if (idx !== -1) order.splice(idx, 1);
		}
	};

	pi.on("tool_execution_start", (event) => {
		runs.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			args: event.args,
			status: "running",
			startedAt: Date.now(),
			endedAt: null,
			partialResult: undefined,
			result: undefined,
		});
		order.push(event.toolCallId);
		requestRender();
	});

	pi.on("tool_execution_update", (event) => {
		const run = runs.get(event.toolCallId);
		if (run) run.partialResult = event.partialResult;
		requestRender();
	});

	pi.on("tool_execution_end", (event) => {
		const run = runs.get(event.toolCallId);
		if (run) {
			run.status = event.isError ? "error" : "done";
			run.endedAt = Date.now();
			run.result = event.result;
		}
		trimFinishedHistory();
		requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, widgetTheme) => {
				activeTui = tui;
				return {
					render(width: number): string[] {
						const running = [...runs.values()].filter((r) => r.status === "running");
						const label = running.length === 0 ? "none" : running.map((r) => r.name).join(", ");
						// "dim" to match the rest of status-line's segments (path, tokens, cost, etc.)
						return [truncateToWidth(widgetTheme.fg("dim", `${WIDGET_ICON} (${label})`), width)];
					},
					invalidate() {},
					dispose() {
						if (activeTui === tui) activeTui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("tools", {
		description: "Full-screen monitor for running/recent tool executions",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new ToolMonitorComponent(tui, theme, done, ctx, runs, order),
				{ overlay: true, overlayOptions: { margin: 2 } },
			);
		},
	});
}
