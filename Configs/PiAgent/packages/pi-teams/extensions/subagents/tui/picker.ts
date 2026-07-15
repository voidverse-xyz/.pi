/**
 * tui/picker.ts — the `/teams` roster overlay (D22). Flat roster (no teams,
 * D12) + a collapsed `.archive` section. Per row: state glyph, address, unread
 * badge. Keys: ↑↓ navigate · Enter view · x interrupt · X retire (y/N) ·
 * a toggle archive · Esc close.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ArchivedAgentInfo, SubagentsCore } from "../core.ts";
import type { RosterEntry } from "../runtime/types.ts";
import { MAIL_ICON } from "./widget.ts";

export const STATE_GLYPHS: Record<RosterEntry["state"], string> = {
	running: "", // nf-fa-circle
	queued: "", // nf-fa-hourglass_half
	dormant: "", // nf-fa-circle_o
	waiting: "", // nf-fa-warning
};

export type PickerRow =
	| { kind: "agent"; entry: RosterEntry; unread: number }
	| { kind: "archive-header"; count: number; expanded: boolean }
	| { kind: "archived"; info: ArchivedAgentInfo };

export interface BuildPickerRowsOptions {
	archiveExpanded: boolean;
	unread: (address: string) => number;
}

export function buildPickerRows(roster: RosterEntry[], archived: ArchivedAgentInfo[], options: BuildPickerRowsOptions): PickerRow[] {
	const rows: PickerRow[] = [];
	for (const entry of [...roster].sort((a, b) => a.address.localeCompare(b.address))) {
		rows.push({ kind: "agent", entry, unread: options.unread(entry.address) });
	}
	if (archived.length > 0) {
		rows.push({ kind: "archive-header", count: archived.length, expanded: options.archiveExpanded });
		if (options.archiveExpanded) for (const info of archived) rows.push({ kind: "archived", info });
	}
	return rows;
}

export function isSelectable(row: PickerRow): boolean {
	return row.kind === "agent" || row.kind === "archived" || row.kind === "archive-header";
}

export function pickerRowText(row: PickerRow): string {
	switch (row.kind) {
		case "agent": {
			const { entry } = row;
			const pct = entry.vitals.ctxPercent !== null ? ` · ${Math.round(entry.vitals.ctxPercent * 100)}%` : "";
			const badge = row.unread > 0 ? ` · ${MAIL_ICON} ${row.unread}` : "";
			return `${STATE_GLYPHS[entry.state]} ${entry.address} · ${entry.state}${pct}${badge}`;
		}
		case "archive-header":
			return `${row.expanded ? "" : ""} .archive (${row.count})`;
		case "archived": {
			const when = row.info.retiredAt ? ` · retired ${row.info.retiredAt.slice(0, 10)}` : "";
			return `   ${row.info.address}${when}`;
		}
	}
}

function clip(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	// eslint-disable-next-line no-control-regex
	return truncateToWidth(text, width).replace(/\x1b\[[0-9;]*m/g, "");
}

export function renderPickerRow(row: PickerRow, theme: Theme, width: number, selected: boolean): string {
	const text = clip(pickerRowText(row), width - 2);
	const prefix = selected ? "▸ " : "  ";
	const color = row.kind === "agent" ? (selected ? "text" : "muted") : "dim";
	return theme.fg(color, `${prefix}${text}`);
}

export type PickerResult = { action: "view"; address: string } | { action: "closed" };

export interface PickerOptions {
	core: SubagentsCore;
	tui: TUI;
	theme: Theme;
	onDone: (result: PickerResult) => void;
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
	const maxBody = options.maxBody ?? Math.max(3, Math.min(12, tui.terminal.rows - 8));

	let roster: RosterEntry[] = [];
	let archived: ArchivedAgentInfo[] = [];
	let rows: PickerRow[] = [];
	let selected = 0;
	let scroll = 0;
	let archiveExpanded = false;
	let confirmRetire: string | null = null;
	let closed = false;

	const rebuild = (): void => {
		rows = buildPickerRows(roster, archived, { archiveExpanded, unread: (a) => core.agentUnreadCount(a) });
		selected = rows.length === 0 ? 0 : Math.min(selected, rows.length - 1);
		scroll = Math.min(scroll, Math.max(0, rows.length - maxBody));
		if (rows[selected] && !isSelectable(rows[selected]!)) move(1);
	};

	const reload = (): void => {
		void core.status().then((entries) => {
			if (closed) return;
			roster = entries;
			archived = core.archived();
			rebuild();
			tui.requestRender();
		}).catch(() => {});
	};

	const offEvents = core.onEvent(() => reload());
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

	function finish(result: PickerResult): void {
		if (closed) return;
		closed = true;
		offEvents();
		onDone(result);
	}

	return {
		invalidate() {},
		dispose() {
			closed = true;
			offEvents();
		},
		render(width: number): string[] {
			const lines: string[] = [theme.fg("accent", "󱘎 Teams"), ""];
			if (rows.length === 0) {
				lines.push(theme.fg("dim", "  (no agents — spawn one with team_spawn)"));
			} else {
				for (let i = scroll; i < Math.min(rows.length, scroll + maxBody); i++) {
					lines.push(renderPickerRow(rows[i]!, theme, width, i === selected));
				}
			}
			lines.push("");
			if (confirmRetire) lines.push(theme.fg("error", `  Retire ${confirmRetire}? [y/N]`));
			else lines.push(theme.fg("dim", "  ↑↓ move · enter view · x interrupt · X retire · a archive · esc"));
			return lines;
		},
		handleInput(data: string) {
			if (confirmRetire !== null) {
				const target = confirmRetire;
				confirmRetire = null;
				if (data === "y" || data === "Y") void core.retire(target).then(reload).catch(reload);
				else tui.requestRender();
				return;
			}
			if (data === "\x1b" || data === "\x03" || data === "q") return finish({ action: "closed" });
			if (data === "\x1b[A" || data === "k") return move(-1), tui.requestRender();
			if (data === "\x1b[B" || data === "j") return move(1), tui.requestRender();
			if (data === "a") {
				archiveExpanded = !archiveExpanded;
				rebuild();
				return tui.requestRender();
			}
			const row = rows[selected];
			if (!row) return;
			if (data === "\r" || data === "\n") {
				if (row.kind === "agent") return finish({ action: "view", address: row.entry.address });
				if (row.kind === "archive-header") {
					archiveExpanded = !archiveExpanded;
					rebuild();
					return tui.requestRender();
				}
				return;
			}
			if (row.kind === "agent" && data === "x") return void core.interrupt(row.entry.address).then(reload).catch(reload);
			if (row.kind === "agent" && data === "X") {
				confirmRetire = row.entry.address;
				return tui.requestRender();
			}
		},
	};
}
