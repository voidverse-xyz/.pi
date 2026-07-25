/**
 * Live tool-execution monitor.
 *
 * Tracks every tool call via tool_execution_start/update/end and exposes it two ways:
 *
 * 1. A live "<spinner>  <N running:> <names>" indicator published as plain
 *    text through the reserved `tool-monitor` setStatus key. pi-status-line owns
 *    its styling and dynamic footer position: line 1-left when subagent status is
 *    absent, line 2-left when subagent status occupies line 1.
 *
 *    When nothing is running the status is cleared entirely (setStatus(key, undefined))
 *    rather than showing general agent activity or a dead " (none)" - the segment
 *    only reports actual tool execution. While ≥1 tool runs, a braille spinner animates
 *    via a ~100ms interval (SPINNER_INTERVAL_MS) that only ticks while something is
 *    running and stops the moment the last tool finishes; each tick re-publishes the
 *    status, which
 *    is what drives the footer re-render (same mechanism codex-usage's poll timer relies
 *    on). A leading count ("N running:") appears only when more than one tool runs.
 *
 * 2. `/tools` — a near-full-screen floating overlay (ctx.ui.custom, inset by OVERLAY_MARGIN
 *    on all sides via overlayOptions.margin/width/maxHeight) listing running + recent tool
 *    calls, on a background fill distinct from the plain transcript, with interior padding
 *    around the content. The list is bounded to the overlay height: arrow-key selection follows
 *    the active row, PgUp/PgDn scroll long row sets (including expanded subagent children), and
 *    Home/End jump to the first/last call. Enter drills into one to see its live streaming output;
 *    q/Escape/'b' goes back to the list; q from the list or Ctrl+C closes the overlay.
 *
 *    Each row (and the detail header) shows a duration - elapsed-so-far for running calls,
 *    total for finished ones - from the startedAt/endedAt stamps the run map already keeps.
 *    Running durations count up live: the component owns a DURATION_TICK_MS interval that
 *    calls tui.requestRender() while ≥1 run is live (the overlay-scoped analogue of the
 *    footer spinner's re-publish tick) and is cleared when the overlay closes.
 *
 *    '/' opens a single-line filter (pi-tui Input, same idiom as plan-commit's Ask panel):
 *    case-insensitive substring match on the tool name and, for subagent rows, the inner
 *    tool names / agent labels. While the input is focused it owns every key except
 *    Ctrl+C (so "q"/"x" are typeable); Enter applies the filter and returns focus to the
 *    list, Escape clears it. With a filter applied but unfocused, Escape clears the filter
 *    first and only a second Escape closes the overlay.
 *
 * Subagent awareness: the `subagent` delegation tool runs each subagent in its own
 * child `pi` process, so those subagents' tool calls never fire tool_execution_* on
 * THIS process's bus — a delegating turn would otherwise show as one opaque
 * "delegate" tool. We recover the inner calls from the delegate tool's streamed
 * result details (see subagentChildren) and surface them everywhere: expanded into
 * the footer's running-tool list/count, indented under their parent in the /tools
 * list, and enumerated in the detail view. Granularity is message-level (a child
 * tool appears when its assistant message streams back, flips to done/error when its
 * toolResult arrives), not the sub-second streaming of local tools.
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
 * Enable the pi-tool-monitor package in settings.json.
 * Reload: /reload
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const STATUS_KEY = "tool-monitor";
const MAX_FINISHED_HISTORY = 100;
const WIDGET_ICON = ""; // nf-oct-terminal

// Braille spinner animated while ≥1 tool runs. Plain Unicode (not a Nerd Font glyph),
// so it renders on any terminal. ~100ms per frame is the usual spinner cadence.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

// Re-render cadence for the /tools overlay while ≥1 run is live, so elapsed-time
// columns count up on screen. Coarser than the spinner (durations only show 0.1s
// resolution) but still smooth; the tick is a no-op when nothing is running.
const DURATION_TICK_MS = 250;

// Outer inset from the terminal edges (as full-screen as reasonably possible while
// still reading as a floating overlay rather than literally the whole terminal).
const OVERLAY_MARGIN = 1;
// Interior padding, inside the box itself, on top of OVERLAY_MARGIN.
const INNER_PAD_X = 2;
const INNER_PAD_Y = 1;

// pi-tui has a function with this exact name/behavior, but it isn't among the text utils
// re-exported from the package's public index. Reimplemented locally (see codex-usage).
function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	const bounded = truncateToWidth(line, Math.max(1, width), "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(bounded)));
	return bgFn(bounded + padding);
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

// Elapsed-so-far for a running call, total wall time for a finished one, straight
// from the timestamps tool_execution_start/end already stamp on the run.
function runDurationMs(run: ToolRun): number {
	return (run.endedAt ?? Date.now()) - run.startedAt;
}

// Compact human duration for list rows / the detail header. Sub-10s keeps one
// decimal so quick tools don't all flatten to "0s"; longer spans use whole units.
function formatDuration(ms: number): string {
	const clamped = Math.max(0, ms);
	if (clamped < 10_000) return `${(clamped / 1000).toFixed(1)}s`;
	const totalSec = Math.round(clamped / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) return `${totalMin}m ${String(totalSec % 60).padStart(2, "0")}s`;
	return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, "0")}m`;
}

// The `subagent` delegation tool (extensions/subagents) runs each subagent in a
// separate child `pi` process whose OWN tool calls never reach this process's event
// bus — from here a delegating turn otherwise looks like a single opaque "subagent"
// tool, blind to the bash/read/edit/... the subagents are actually running. But the
// tool streams its child transcript back through the tool-result details
// (partialResult while running, result when done), so we reach in and surface those
// inner calls as child rows. Shape mirrors SubagentDetails in
// extensions/subagents/delegate.ts — read loosely, only what we need.
const DELEGATE_TOOL_NAME = "delegate";

interface InnerToolCall {
	id: string;
	name: string;
	args: unknown;
	status: ToolStatus;
	agent?: string;
}

// Walk one subagent result's message transcript, pairing each assistant toolCall
// with its later toolResult (matched by id) to infer status: no result yet =>
// running, isError result => error, otherwise done.
function innerCallsFromMessages(messages: unknown, agent: string | undefined): InnerToolCall[] {
	if (!Array.isArray(messages)) return [];
	const resultIsError = new Map<string, boolean>();
	for (const msg of messages) {
		const m = msg as { role?: string; toolCallId?: unknown; isError?: unknown };
		if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
			resultIsError.set(m.toolCallId, Boolean(m.isError));
		}
	}
	const calls: InnerToolCall[] = [];
	for (const msg of messages) {
		const m = msg as { role?: string; content?: unknown };
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of m.content) {
			const p = part as { type?: string; id?: unknown; name?: unknown; arguments?: unknown };
			if (p?.type !== "toolCall" || typeof p.id !== "string") continue;
			const errored = resultIsError.get(p.id);
			const status: ToolStatus = errored === undefined ? "running" : errored ? "error" : "done";
			calls.push({ id: p.id, name: typeof p.name === "string" ? p.name : "(tool)", args: p.arguments, status, agent });
		}
	}
	return calls;
}

// Inner tool calls of a subagent run, drawn from the freshest details available
// (final result once done, else the streaming partialResult). Non-subagent runs
// have none. When the parent has finished, nothing under it is still executing, so
// any still-"running" leaf is clamped to done (e.g. an aborted child mid-call).
function subagentChildren(run: ToolRun): InnerToolCall[] {
	if (run.name !== DELEGATE_TOOL_NAME) return [];
	const details = ((run.result as { details?: unknown })?.details ??
		(run.partialResult as { details?: unknown })?.details) as { results?: unknown } | undefined;
	const results = details?.results;
	if (!Array.isArray(results)) return [];
	const calls: InnerToolCall[] = [];
	for (const r of results) {
		const res = r as { agent?: unknown; messages?: unknown };
		const agent = typeof res?.agent === "string" ? res.agent : undefined;
		calls.push(...innerCallsFromMessages(res?.messages, agent));
	}
	if (run.status !== "running") {
		for (const c of calls) if (c.status === "running") c.status = "done";
	}
	return calls;
}

// Filter predicates for the /tools overlay: case-insensitive substring match on
// the tool name, plus (for subagent rows) the inner tool names and agent labels,
// since those are what the list actually displays. `query` is pre-lowercased.
function childMatchesQuery(child: InnerToolCall, query: string): boolean {
	return child.name.toLowerCase().includes(query) || (child.agent?.toLowerCase().includes(query) ?? false);
}

function runMatchesQuery(run: ToolRun, query: string): boolean {
	if (run.name.toLowerCase().includes(query)) return true;
	return subagentChildren(run).some((child) => childMatchesQuery(child, query));
}

// A running tool's contribution to the footer's leaf-tool list: a running subagent
// resolves to the inner tool names currently in flight (agent-qualified so parallel
// subagents stay distinct); between inner calls, or for any ordinary tool, it's just
// the tool's own name.
function runningLeafNames(run: ToolRun): string[] {
	if (run.name === DELEGATE_TOOL_NAME) {
		const inFlight = subagentChildren(run).filter((c) => c.status === "running");
		if (inFlight.length > 0) return inFlight.map((c) => (c.agent ? `${c.agent}:${c.name}` : c.name));
	}
	return [run.name];
}

export function calculateListWindow(
	totalRows: number,
	selectedRow: number,
	viewportRows: number,
	scroll: number,
	followSelection: boolean,
): { scroll: number; maxScroll: number; end: number } {
	const viewport = Math.max(1, viewportRows);
	const maxScroll = Math.max(0, totalRows - viewport);
	let nextScroll = Math.max(0, Math.min(scroll, maxScroll));

	if (followSelection && selectedRow >= 0 && selectedRow < totalRows) {
		if (selectedRow < nextScroll) nextScroll = selectedRow;
		else if (selectedRow >= nextScroll + viewport) nextScroll = selectedRow - viewport + 1;
	}

	return { scroll: nextScroll, maxScroll, end: Math.min(totalRows, nextScroll + viewport) };
}

// Full-screen /tools overlay: a hand-rolled two-mode (list/detail) component. Not built on
// pi-tui's SelectList since that only accepts its item array at construction time — there's
// no way to refresh it in place as tool runs start/finish while the overlay is open.
export class ToolMonitorComponent {
	private mode: "list" | "detail" = "list";
	private selectedIndex = 0;
	private selectedId: string | undefined;
	private listScroll = 0;
	private listCursorRow = 0;
	private listLineCount = 0;
	private listViewportRows = 1;
	private listFollowSelection = true;
	private listRowItemIndices: number[] = [];
	private detailScroll = 0;
	private detailLineCount = 0;
	// Content-line index (within renderList output) of the selected row, or null.
	private highlightRow: number | null = null;
	// '/' filter for the list view. The Input stays around (holding its text) even
	// when unfocused, so an applied filter survives drilling into a detail view.
	private readonly filterInput = new Input();
	private filterFocused = false;
	// Keeps elapsed-time columns counting up while ≥1 run is live; a no-op tick
	// otherwise. Cleared in close() - every exit path funnels through there.
	private readonly durationTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly ctx: ExtensionCommandContext,
		private readonly runs: Map<string, ToolRun>,
		private readonly order: string[],
	) {
		this.filterInput.onSubmit = () => this.blurFilter(false);
		this.filterInput.onEscape = () => this.blurFilter(true);
		this.durationTimer = setInterval(() => {
			for (const run of this.runs.values()) {
				if (run.status === "running") {
					this.tui.requestRender();
					return;
				}
			}
		}, DURATION_TICK_MS);
	}

	invalidate(): void {
		this.filterInput.invalidate();
	}

	dispose(): void {
		clearInterval(this.durationTimer);
	}

	private close(): void {
		this.dispose();
		this.done();
	}

	// Rows available for scrollable content: terminal height minus the overlay's
	// outer margin and the interior vertical padding (top + bottom of each).
	private viewportRows(): number {
		return Math.max(1, this.tui.terminal.rows - OVERLAY_MARGIN * 2 - INNER_PAD_Y * 2);
	}

	private blurFilter(clear: boolean): void {
		if (clear) this.filterInput.setValue("");
		this.filterFocused = false;
		this.filterInput.focused = false;
		this.listFollowSelection = true;
	}

	private filterQuery(): string {
		return this.filterInput.getValue().trim().toLowerCase();
	}

	private currentItems(): ToolRun[] {
		const items: ToolRun[] = [];
		for (let i = this.order.length - 1; i >= 0; i--) {
			const run = this.runs.get(this.order[i]);
			if (run) items.push(run);
		}
		// Running tool calls pinned to the top; recency (most recent first) is
		// preserved within each group via the stable sort.
		items.sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
		const query = this.filterQuery();
		return query === "" ? items : items.filter((run) => runMatchesQuery(run, query));
	}

	private attemptAbort(run: ToolRun | undefined): void {
		if (run?.status === "running") {
			this.ctx.abort();
			this.ctx.ui.notify("Sent abort (stops the whole current turn - Pi has no per-tool abort).", "warning");
		} else {
			this.ctx.ui.notify("That tool call already finished - nothing to abort.", "info");
		}
	}

	private scrollListPage(delta: number): void {
		const maxScroll = Math.max(0, this.listLineCount - this.listViewportRows);
		this.listScroll = Math.max(0, Math.min(maxScroll, this.listScroll + delta * this.listViewportRows));
		this.listCursorRow = Math.min(Math.max(0, this.listLineCount - 1), this.listScroll);
		this.selectedIndex = this.listRowItemIndices[this.listCursorRow] ?? this.selectedIndex;
		this.listFollowSelection = false;
	}

	handleInput(data: string): void {
		if (this.mode === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
		this.tui.requestRender();
	}

	private handleListInput(data: string): void {
		// While the filter input is focused it owns every key except ctrl+c, so
		// letters like "q"/"x" are typeable as filter text. Enter/escape hand focus
		// back via the Input's own onSubmit/onEscape callbacks (see constructor).
		if (this.filterFocused) {
			if (matchesKey(data, "ctrl+c")) {
				this.close();
				return;
			}
			this.filterInput.handleInput(data);
			this.listFollowSelection = true;
			return;
		}
		const items = this.currentItems();
		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = items.length === 0 ? 0 : (this.selectedIndex - 1 + items.length) % items.length;
			this.listFollowSelection = true;
		} else if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = items.length === 0 ? 0 : (this.selectedIndex + 1) % items.length;
			this.listFollowSelection = true;
		} else if (matchesKey(data, "pageup")) {
			this.scrollListPage(-1);
		} else if (matchesKey(data, "pagedown")) {
			this.scrollListPage(1);
		} else if (matchesKey(data, "home") || data === "g") {
			this.selectedIndex = 0;
			this.listFollowSelection = true;
		} else if (matchesKey(data, "end") || data === "G") {
			this.selectedIndex = Math.max(0, items.length - 1);
			this.listFollowSelection = true;
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const item = items[this.selectedIndex];
			if (item) {
				this.selectedId = item.id;
				this.detailScroll = 0;
				this.mode = "detail";
			}
		} else if (data === "x") {
			this.attemptAbort(items[this.selectedIndex]);
		} else if (data === "/") {
			this.filterFocused = true;
			this.filterInput.focused = true;
		} else if (matchesKey(data, "escape") && this.filterQuery() !== "") {
			// First escape clears an applied filter; a second one closes the overlay.
			this.filterInput.setValue("");
			this.listFollowSelection = true;
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.close();
		}
	}

	private handleDetailInput(data: string): void {
		if (data === "q" || matchesKey(data, "escape") || data === "b") {
			this.mode = "list";
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		const viewport = this.viewportRows();
		const maxScroll = Math.max(0, this.detailLineCount - viewport);
		if (matchesKey(data, "up") || data === "k") this.detailScroll = Math.max(0, this.detailScroll - 1);
		else if (matchesKey(data, "down") || data === "j") this.detailScroll = Math.min(maxScroll, this.detailScroll + 1);
		else if (matchesKey(data, "pageup")) this.detailScroll = Math.max(0, this.detailScroll - viewport);
		else if (matchesKey(data, "pagedown")) this.detailScroll = Math.min(maxScroll, this.detailScroll + viewport);
		else if (data === "g") this.detailScroll = 0;
		else if (data === "G") this.detailScroll = maxScroll;
		else if (data === "x") this.attemptAbort(this.selectedId ? this.runs.get(this.selectedId) : undefined);
	}

	render(width: number): string[] {
		// Content is built against the padded-in width, then each line gets a left/right
		// interior margin plus a full-width background fill distinct from the transcript's
		// (which has none), and the frame is padded with blank filled rows to the full
		// available terminal height (pi-tui sizes the overlay to however many lines we
		// return — it does not auto-stretch short content to fill the box on its own).
		const horizontalPad = Math.min(INNER_PAD_X, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - horizontalPad * 2);
		const content = this.mode === "list" ? this.renderList(contentWidth) : this.renderDetail(contentWidth);
		const targetRows = Math.max(1, this.tui.terminal.rows - OVERLAY_MARGIN * 2);
		const contentRows = Math.max(0, targetRows - INNER_PAD_Y * 2);

		const bgFn = (text: string) => this.theme.bg("customMessageBg", text);
		const selBgFn = (text: string) => this.theme.bg("selectedBg", text);
		const pad = " ".repeat(horizontalPad);
		const blankRow = applyBackgroundToLine("", width, bgFn);
		const rows = content.slice(0, contentRows).map((line, i) =>
			applyBackgroundToLine(
				`${pad}${truncateToWidth(line, contentWidth, "…")}`,
				width,
				i === this.highlightRow ? selBgFn : bgFn,
			),
		);

		// Keep the frame at exactly the overlay's available height. The final slice is
		// defensive for terminals too short to fit both configured padding rows.
		for (let i = 0; i < INNER_PAD_Y && rows.length < targetRows; i++) rows.unshift(blankRow);
		while (rows.length < targetRows) rows.push(blankRow);

		return rows.slice(0, targetRows);
	}

	private renderList(width: number): string[] {
		this.highlightRow = null;
		const query = this.filterQuery();
		const items = this.currentItems();
		const hints = this.filterFocused
			? "type to filter  enter: apply  esc: clear filter  ctrl+c: close"
			: query !== ""
				? "↑↓: select  PgUp/PgDn: scroll  enter: view  /: edit filter  esc: clear  x: abort  q: close"
				: "↑↓: select  PgUp/PgDn: scroll  Home/End: jump  enter: view  /: filter  x: abort  q: close";
		const header: string[] = [this.theme.fg("accent", "Tool Monitor"), ""];

		// Filter row, shown while editing or while a filter is applied. The Input
		// renders its own cursor when focused; unfocused it's just the query text.
		if (this.filterFocused || query !== "") {
			const label = "filter: ";
			const inputLine = this.filterInput.render(Math.max(1, width - label.length))[0] ?? "";
			header.push(truncateToWidth(this.theme.fg("dim", label) + inputLine, width));
		}
		header.push("");

		if (items.length === 0) {
			header[1] = this.theme.fg("dim", `0/0 · ${hints}`);
			header.push(this.theme.fg("dim", query !== "" ? "No tool executions match the filter." : "No tool executions yet."));
			this.listScroll = 0;
			this.listCursorRow = 0;
			this.listLineCount = 0;
			this.listViewportRows = 1;
			this.listRowItemIndices = [];
			return header;
		}

		// Keep the selection in range as the list reorders (running pinned to top).
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));

		const itemLines: string[] = [];
		const rowItemIndices: number[] = [];
		let selectedParentRow = -1;
		items.forEach((run, index) => {
			const selected = index === this.selectedIndex;
			if (selected) selectedParentRow = itemLines.length;
			rowItemIndices.push(index);
			const marker = selected ? ">" : " ";
			const label = `${marker} ${run.name} ${statusLabel(run.status)}`;
			const duration = this.theme.fg("dim", ` ${formatDuration(runDurationMs(run))}`);
			itemLines.push(truncateToWidth(this.theme.fg(statusColor(run.status), label) + duration, width));
			// Inner subagent tool calls, indented beneath their parent so a delegating
			// turn shows the bash/read/edit its subagents ran, not just "subagent".
			// Under a filter that the parent itself doesn't match, only the matching
			// children are listed (they're what earned the parent its row).
			const parentMatched = query === "" || run.name.toLowerCase().includes(query);
			for (const child of subagentChildren(run)) {
				if (!parentMatched && !childMatchesQuery(child, query)) continue;
				const prefix = child.agent ? `[${child.agent}] ` : "";
				const childLabel = `    ${prefix}${child.name} ${statusLabel(child.status)}`;
				itemLines.push(truncateToWidth(this.theme.fg(statusColor(child.status), childLabel), width));
				rowItemIndices.push(index);
			}
		});

		const availableRows = Math.max(0, this.viewportRows() - header.length);
		this.listLineCount = itemLines.length;
		this.listViewportRows = Math.max(1, availableRows);
		this.listRowItemIndices = rowItemIndices;
		if (this.listFollowSelection) this.listCursorRow = selectedParentRow;
		else this.listCursorRow = Math.max(0, Math.min(this.listCursorRow, itemLines.length - 1));
		this.selectedIndex = rowItemIndices[this.listCursorRow] ?? this.selectedIndex;
		const window = calculateListWindow(
			itemLines.length,
			this.listCursorRow,
			this.listViewportRows,
			this.listScroll,
			this.listFollowSelection,
		);
		this.listScroll = window.scroll;

		const scrollPosition =
			window.maxScroll > 0 ? ` · rows ${window.scroll + 1}-${window.end}/${itemLines.length}` : "";
		header[1] = this.theme.fg("dim", `${this.selectedIndex + 1}/${items.length}${scrollPosition} · ${hints}`);
		if (availableRows === 0) return header;

		if (this.listCursorRow >= window.scroll && this.listCursorRow < window.end) {
			this.highlightRow = header.length + this.listCursorRow - window.scroll;
		}
		return [...header, ...itemLines.slice(window.scroll, window.end)];
	}

	private renderDetail(width: number): string[] {
		this.highlightRow = null;
		const run = this.selectedId ? this.runs.get(this.selectedId) : undefined;
		if (!run) {
			this.mode = "list";
			return this.renderList(width);
		}

		const duration = formatDuration(runDurationMs(run));
		const lines: string[] = [
			this.theme.fg("accent", `Tool: ${run.name}`),
			this.theme.fg(statusColor(run.status), `Status: ${run.status} · ${duration}${run.status === "running" ? " elapsed" : ""}`),
			this.theme.fg("dim", "↑↓/PgUp/PgDn: scroll  q/b: back  x: abort  ctrl+c: close"),
			"",
		];

		// For a subagent, the raw details JSON is a huge transcript dump; the useful
		// view is the list of tools it ran, so surface that instead.
		const children = subagentChildren(run);
		if (run.name === DELEGATE_TOOL_NAME) {
			lines.push(this.theme.fg("dim", `Subagent tool calls (${children.length}):`));
			if (children.length === 0) {
				lines.push(this.theme.fg("muted", "  (none yet)"));
			} else {
				for (const child of children) {
					const prefix = child.agent ? `[${child.agent}] ` : "";
					lines.push(
						truncateToWidth(this.theme.fg(statusColor(child.status), `  ${prefix}${child.name} ${statusLabel(child.status)}`), width),
					);
				}
			}
			lines.push("");
		}

		lines.push(
			this.theme.fg("dim", "Args:"),
			...wrapTextWithAnsi(summarize(run.args), width),
			"",
			this.theme.fg("dim", run.status === "running" ? "Live output:" : "Result:"),
			...wrapTextWithAnsi(summarize(run.status === "running" ? run.partialResult : run.result), width),
		);
		this.detailLineCount = lines.length;
		const viewport = this.viewportRows();
		this.detailScroll = Math.min(this.detailScroll, Math.max(0, lines.length - viewport));
		return lines.slice(this.detailScroll, this.detailScroll + viewport);
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

	let spinnerFrame = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	// Latest ctx seen from an event, so the spinner interval (which fires outside any
	// event) has a live handle to setStatus without a session_start dependency.
	let lastCtx: ExtensionContext | undefined;

	const stopSpinner = () => {
		if (spinnerTimer) clearInterval(spinnerTimer);
		spinnerTimer = undefined;
		spinnerFrame = 0;
	};

	// Publish plain content only: status-line owns styling, separators, truncation,
	// and the indicator's dynamic footer row. Clear it entirely while idle.
	const publishStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		const running = [...runs.values()].filter((r) => r.status === "running");

		if (running.length === 0) {
			stopSpinner();
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		// Keep the animation ticking for as long as anything runs; each tick re-publishes,
		// which is what nudges the footer to re-render (setStatus is the render trigger).
		if (!spinnerTimer) {
			spinnerTimer = setInterval(() => {
				spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
				if (lastCtx) publishStatus(lastCtx);
			}, SPINNER_INTERVAL_MS);
		}

		// Expand each running subagent into the inner tools it's actually executing
		// (see runningLeafNames), so the footer reflects the real work rather than one
		// opaque "subagent". Count reflects those leaves too.
		const leaves = running.flatMap(runningLeafNames);
		const count = leaves.length > 1 ? `${leaves.length} running: ` : "";
		const names = leaves.join(", ");
		ctx.ui.setStatus(STATUS_KEY, `${SPINNER_FRAMES[spinnerFrame]} ${WIDGET_ICON} ${count}${names}`);
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
		stopSpinner();
		lastCtx = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("tools", {
		description: "Full-screen monitor for running/recent tool executions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires interactive TUI mode", "error");
				return;
			}
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
