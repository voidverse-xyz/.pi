/**
 * tui/picker.ts — the /agents editor-local picker (05-tui-spec §2, D17/D22).
 *
 * Rows grouped by team, then (solo). Per row: state glyph (● running /
 * ◐ queued / ○ dormant / ⚠ waiting), address, ctx%, unread badge. A collapsed
 * `▸ .archive (n)` section at the bottom lists retired agents (D13
 * post-mortem promise) — Enter on the header expands it; Enter on an archived
 * row opens the read-only viewer.
 *
 * Keys: ↑↓ navigate · Enter view (or expand/collapse .archive) · x interrupt
 * · X retire (inline y/N confirm) · Esc close.
 *
 * The picker never mutates state directly except interrupt/retire, both via
 * the core facade; its RESULT tells index.ts what to open next (viewer /
 * archived viewer / nothing) so overlay lifetimes stay linear.
 *
 * Imports: core.ts + pi SDK/pi-tui only (06-architecture structural rule).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ArchivedAgentInfo, SubagentsCore } from "../core.ts";
import type { RosterEntry } from "../runtime/types.ts";

// ---------------------------------------------------------------------------
// Pure row model (harness-testable without a terminal)
// ---------------------------------------------------------------------------

export type PickerRow =
	| { kind: "team-header"; team: string }
	| { kind: "agent"; entry: RosterEntry; unread: number }
	| { kind: "archive-header"; count: number; expanded: boolean }
	| { kind: "archived"; info: ArchivedAgentInfo };

export const STATE_GLYPHS: Record<RosterEntry["state"], string> = {
	running: "●",
	queued: "◐",
	dormant: "○",
	waiting: "⚠",
};

export interface BuildPickerRowsOptions {
	archiveExpanded: boolean;
	/** Unread badge per agent address (mailbox pending count). */
	unread: (address: string) => number;
}

/**
 * Group the roster by team (sorted), then (solo); append the .archive
 * section header (+ rows when expanded). An agent on several teams is listed
 * under its first team only — one row per agent, the roster stays scannable.
 */
export function buildPickerRows(
	roster: RosterEntry[],
	archived: ArchivedAgentInfo[],
	options: BuildPickerRowsOptions,
): PickerRow[] {
	const byTeam = new Map<string, RosterEntry[]>();
	const solo: RosterEntry[] = [];
	for (const entry of [...roster].sort((a, b) => a.address.localeCompare(b.address))) {
		const team = [...entry.teams].sort()[0];
		if (team === undefined) solo.push(entry);
		else {
			const bucket = byTeam.get(team) ?? [];
			bucket.push(entry);
			byTeam.set(team, bucket);
		}
	}

	const rows: PickerRow[] = [];
	for (const team of [...byTeam.keys()].sort()) {
		rows.push({ kind: "team-header", team });
		for (const entry of byTeam.get(team)!) {
			rows.push({ kind: "agent", entry, unread: options.unread(entry.address) });
		}
	}
	if (solo.length > 0) {
		rows.push({ kind: "team-header", team: "(solo)" });
		for (const entry of solo) {
			rows.push({ kind: "agent", entry, unread: options.unread(entry.address) });
		}
	}
	if (archived.length > 0) {
		rows.push({ kind: "archive-header", count: archived.length, expanded: options.archiveExpanded });
		if (options.archiveExpanded) {
			for (const info of archived) rows.push({ kind: "archived", info });
		}
	}
	return rows;
}

export function isSelectable(row: PickerRow): boolean {
	return row.kind !== "team-header";
}

/** Plain-text (theme-free) row text — what the harness asserts on. */
export function pickerRowText(row: PickerRow): string {
	switch (row.kind) {
		case "team-header":
			return row.team;
		case "agent": {
			const { entry } = row;
			const parts = [
				`${STATE_GLYPHS[entry.state]} ${entry.address}`,
				entry.state,
				`ctx ${Math.round(entry.vitals.contextPercent)}%`,
			];
			if (row.unread > 0) parts.push(`📬 ${row.unread}`);
			return `  ${parts.join("  ·  ")}`;
		}
		case "archive-header":
			return `${row.expanded ? "▾" : "▸"} .archive (${row.count})`;
		case "archived": {
			const when = row.info.retiredAt ? ` · retired ${row.info.retiredAt.slice(0, 10)}` : "";
			return `  ✝ ${row.info.address}${when}`;
		}
	}
}

const GLYPH_COLOR: Record<RosterEntry["state"], string> = {
	running: "success",
	queued: "warning",
	dormant: "dim",
	waiting: "warning",
};

/** One themed row line (fg-only styling — rows are not bg bands). */
export function renderPickerRow(row: PickerRow, theme: Theme, width: number, selected: boolean): string {
	const prefix = selected ? "→ " : "  ";
	const text = pickerRowText(row);
	const body = truncateToWidth(`${prefix}${text}`, width);
	if (selected) return theme.fg("accent", body);
	switch (row.kind) {
		case "team-header":
			return theme.fg("muted", body);
		case "archive-header":
		case "archived":
			return theme.fg("dim", body);
		case "agent":
			return theme.fg(GLYPH_COLOR[row.entry.state] as Parameters<Theme["fg"]>[0], body);
	}
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type PickerResult =
	| { action: "view"; address: string }
	| { action: "view-archived"; archived: ArchivedAgentInfo }
	| { action: "closed" };

export interface PickerOptions {
	core: SubagentsCore;
	tui: TUI;
	theme: Theme;
	onDone: (result: PickerResult) => void;
	/** Height budget for the list body. Defaults to at most 10 rows. */
	maxBody?: number;
}

interface PickerComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

export function createPicker(options: PickerOptions): PickerComponent {
	const { core, tui, theme, onDone } = options;
	const maxBody = options.maxBody ?? Math.max(3, Math.min(10, tui.terminal.rows - 8));

	let roster: RosterEntry[] = [];
	let archived: ArchivedAgentInfo[] = [];
	let rows: PickerRow[] = [];
	let selected = 0;
	let scroll = 0;
	let archiveExpanded = false;
	/** Address awaiting the inline retire y/N confirm; null = not confirming. */
	let confirmRetire: string | null = null;
	let closed = false;

	const rebuild = (): void => {
		rows = buildPickerRows(roster, archived, {
			archiveExpanded,
			unread: (address) => core.agentUnreadCount(address),
		});
		if (rows.length === 0) {
			selected = 0;
			scroll = 0;
			return;
		}
		selected = Math.min(selected, rows.length - 1);
		// Clamp the scroll window too: when rows shrink (retire/GC) while
		// scrolled down, a stale scroll would render an empty list body.
		scroll = Math.min(scroll, Math.max(0, rows.length - maxBody));
		if (!isSelectable(rows[selected]!)) move(1);
	};

	const reload = (): void => {
		void core
			.status()
			.then((entries) => {
				if (closed) return;
				roster = entries;
				archived = core.archived();
				rebuild();
				tui.requestRender();
			})
			.catch(() => {});
	};

	const offEvents = core.runtime.onEvent(() => reload());
	reload();

	function move(delta: number): void {
		if (rows.length === 0) return;
		let index = selected;
		do {
			index += delta;
		} while (index >= 0 && index < rows.length && !isSelectable(rows[index]!));
		if (index < 0 || index >= rows.length) return;
		selected = index;
		if (selected < scroll) scroll = selected;
		if (selected >= scroll + maxBody) scroll = selected - maxBody + 1;
	}

	function selectedRow(): PickerRow | undefined {
		return rows[selected];
	}

	function finish(result: PickerResult): void {
		if (closed) return;
		closed = true;
		offEvents();
		onDone(result);
	}

	function handleConfirmInput(data: string): void {
		const address = confirmRetire!;
		confirmRetire = null;
		if (data === "y" || data === "Y") {
			void core
				.retire(address)
				.then(() => reload())
				.catch(() => reload());
		}
		tui.requestRender();
	}

	return {
		invalidate() {},
		dispose() {
			closed = true;
			offEvents();
		},
		handleInput(data: string) {
			if (confirmRetire !== null) {
				handleConfirmInput(data);
				return;
			}
			// Esc / ctrl+c close.
			if (data === "\x1b" || data === "\x03" || data === "q") {
				finish({ action: "closed" });
				return;
			}
			if (data === "\x1b[A" || data === "k") {
				move(-1);
				tui.requestRender();
				return;
			}
			if (data === "\x1b[B" || data === "j") {
				move(1);
				tui.requestRender();
				return;
			}
			const row = selectedRow();
			if (!row) return;
			if (data === "\r" || data === "\n") {
				if (row.kind === "agent") finish({ action: "view", address: row.entry.address });
				else if (row.kind === "archived") finish({ action: "view-archived", archived: row.info });
				else if (row.kind === "archive-header") {
					archiveExpanded = !archiveExpanded;
					rebuild();
					tui.requestRender();
				}
				return;
			}
			if (data === "x" && row.kind === "agent") {
				void core
					.interrupt(row.entry.address)
					.then(() => reload())
					.catch(() => reload());
				return;
			}
			if (data === "X" && row.kind === "agent") {
				confirmRetire = row.entry.address;
				tui.requestRender();
				return;
			}
		},
		render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			const border = new DynamicBorder((text: string) => theme.fg("borderMuted", text));
			const rule = border.render(renderWidth)[0] ?? "";
			// Match Pi's editor-local selectors: muted dynamic borders, accent cursor,
			// compact rows, and a dim key-hint footer.
			const lines: string[] = [rule];
			lines.push(theme.fg("accent", truncateToWidth(" Subagents", renderWidth)));
			if (rows.length === 0) {
				lines.push(theme.fg("dim", "  (no agents — subagent_spawn creates one)"));
			} else {
				const end = Math.min(rows.length, scroll + maxBody);
				for (let i = scroll; i < end; i++) {
					lines.push(renderPickerRow(rows[i]!, theme, renderWidth, i === selected));
				}
				if (rows.length > maxBody) {
					lines.push(theme.fg("dim", `  ${selected + 1}/${rows.length}`));
				}
			}
			if (confirmRetire !== null) {
				lines.push(theme.fg("warning", truncateToWidth(` retire ${confirmRetire}? [y/N]`, renderWidth)));
			} else {
				lines.push(
					theme.fg("dim", truncateToWidth(" ↑↓ move · enter view · x interrupt · X retire · esc", renderWidth)),
				);
			}
			lines.push(rule);
			// Defensive width clamp for every generated line.
			return lines.map((line) => (visibleWidth(line) > renderWidth ? truncateToWidth(line, renderWidth) : line));
		},
	};
}
