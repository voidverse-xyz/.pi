/**
 * Live tool-execution monitor.
 *
 * Tracks every tool call via tool_execution_start/update/end and exposes it two ways:
 *
 * 1. A ">_ (<names>)" / ">_ (none)" indicator published via ctx.ui.setStatus() -
 *    the same generic cross-extension footer-status channel codex-usage and
 *    command-safety use - so status-line joins it onto the same line as the context
 *    gauge and those other segments, rather than it living on its own separate row.
 *    (It used to be its own belowEditor widget; John asked for it combined onto that
 *    line instead.)
 *
 * 2. `/tools` — a near-full-screen floating overlay (ctx.ui.custom, inset by OVERLAY_MARGIN
 *    on all sides via overlayOptions.margin/width/maxHeight) listing running + recent tool
 *    calls, on a background fill distinct from the plain transcript, with interior padding
 *    around the content. Arrow keys + Enter drill into one to see its live streaming output;
 *    Escape/'b' goes back to the list; Escape/'q'/Ctrl+C closes the overlay entirely.
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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const STATUS_KEY = "tool-monitor";
const MAX_FINISHED_HISTORY = 100;
const WIDGET_ICON = ">_"; // terminal prompt - plain ASCII, not a Nerd Font glyph

// Outer inset from the terminal edges (as full-screen as reasonably possible while
// still reading as a floating overlay rather than literally the whole terminal).
const OVERLAY_MARGIN = 1;
// Interior padding, inside the box itself, on top of OVERLAY_MARGIN.
const INNER_PAD_X = 2;
const INNER_PAD_Y = 1;

// pi-tui has a function with this exact name/behavior, but it isn't re-exported from the
// package's public index — only visibleWidth is. Reimplemented locally (see codex-usage).
function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
	return bgFn(line + padding);
}

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
	// Content-line index (within renderList output) of the selected row, or null.
	private highlightRow: number | null = null;

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
		// Running tool calls pinned to the top; recency (most recent first) is
		// preserved within each group via the stable sort.
		items.sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
		return items;
	}

	private attemptAbort(run: ToolRun | undefined): void {
		if (run?.status === "running") {
			this.ctx.abort();
			this.ctx.ui.notify("Sent abort (stops the whole current turn - Pi has no per-tool abort).", "warning");
		} else {
			this.ctx.ui.notify("That tool call already finished - nothing to abort.", "info");
		}
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
		} else if (data === "x") {
			this.attemptAbort(items[this.selectedIndex]);
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
			this.attemptAbort(this.selectedId ? this.runs.get(this.selectedId) : undefined);
		}
	}

	render(width: number): string[] {
		// Content is built against the padded-in width, then each line gets a left/right
		// interior margin plus a full-width background fill distinct from the transcript's
		// (which has none), and the frame is padded with blank filled rows to the full
		// available terminal height (pi-tui sizes the overlay to however many lines we
		// return — it does not auto-stretch short content to fill the box on its own).
		const contentWidth = Math.max(1, width - INNER_PAD_X * 2);
		const content = this.mode === "list" ? this.renderList(contentWidth) : this.renderDetail(contentWidth);

		const bgFn = (text: string) => this.theme.bg("customMessageBg", text);
		const selBgFn = (text: string) => this.theme.bg("selectedBg", text);
		const pad = " ".repeat(INNER_PAD_X);
		const blankRow = applyBackgroundToLine("", width, bgFn);
		const rows = content.map((line, i) =>
			applyBackgroundToLine(`${pad}${line}`, width, i === this.highlightRow ? selBgFn : bgFn),
		);

		// Top interior padding so the content isn't flush against the box edge.
		for (let i = 0; i < INNER_PAD_Y; i++) rows.unshift(blankRow);

		// Fill the remaining box height (bottom padding), keeping the frame opaque.
		const targetRows = Math.max(rows.length, this.tui.terminal.rows - OVERLAY_MARGIN * 2);
		while (rows.length < targetRows) rows.push(blankRow);

		return rows;
	}

	private renderList(width: number): string[] {
		this.highlightRow = null;
		const items = this.currentItems();
		const lines: string[] = [
			this.theme.fg("accent", "Tool Monitor"),
			this.theme.fg("dim", "up/down: navigate  enter: view  x: abort  esc/q: close"),
			"",
		];

		if (items.length === 0) {
			lines.push(this.theme.fg("dim", "No tool executions yet."));
			return lines;
		}

		// Keep the selection in range as the list reorders (running pinned to top).
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));

		items.forEach((run, index) => {
			const selected = index === this.selectedIndex;
			if (selected) this.highlightRow = lines.length;
			const marker = selected ? ">" : " ";
			const label = `${marker} ${run.name} ${statusLabel(run.status)}`;
			lines.push(truncateToWidth(this.theme.fg(statusColor(run.status), label), width));
		});
		return lines;
	}

	private renderDetail(width: number): string[] {
		this.highlightRow = null;
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

	// Bare content, no leading/trailing separator of its own - status-line owns the
	// " | " between footer segments and joins whatever any extension publishes here.
	const publishStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const running = [...runs.values()].filter((r) => r.status === "running");
		const label = running.length === 0 ? "none" : running.map((r) => r.name).join(", ");
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${WIDGET_ICON} (${label})`));
	};

	pi.on("tool_execution_start", (event, ctx) => {
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
		publishStatus(ctx);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		const run = runs.get(event.toolCallId);
		if (run) run.partialResult = event.partialResult;
		publishStatus(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const run = runs.get(event.toolCallId);
		if (run) {
			run.status = event.isError ? "error" : "done";
			run.endedAt = Date.now();
			run.result = event.result;
		}
		trimFinishedHistory();
		publishStatus(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		publishStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("tools", {
		description: "Full-screen monitor for running/recent tool executions",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new ToolMonitorComponent(tui, theme, done, ctx, runs, order),
				{
					overlay: true,
					// Without an explicit width, pi-tui defaults an overlay to min(80, available) —
					// nowhere near full-screen. width/maxHeight "100%" plus a small margin is what
					// actually gets it as close to full-screen as the terminal allows.
					overlayOptions: { margin: OVERLAY_MARGIN, width: "100%", maxHeight: "100%" },
				},
			);
		},
	});
}
