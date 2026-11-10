/**
 * tui/picker.ts — the `/subagents` roster selector. Native settings-selector
 * chrome (see Pi's SettingsSelectorComponent / the pi-bookmark manager idiom):
 * DynamicBorder rules top and bottom, an accent bold title, a pi-tui SelectList
 * for the rows (accent `→ ` cursor, aligned muted description column), and a
 * dim hint footer. Flat roster + a collapsed `.archive` section.
 *
 * Keys: ↑↓/jk navigate · Enter view · x cancel · X retire (y/N) · S stop all ·
 * a toggle archive · q close. Action keys are intercepted before the list so
 * SelectList only ever sees navigation input.
 */

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ArchivedAgentInfo, SubagentsCore } from "../core.ts";
import type { RosterEntry } from "../runtime/types.ts";
import { formatTokens, MAIL_ICON } from "./widget.ts";

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

/** SelectList item for a row: label column = who, description column = state. */
export function pickerRowItem(row: PickerRow): SelectItem {
	switch (row.kind) {
		case "agent": {
			const { entry } = row;
			const pct = entry.vitals.ctxPercent !== null ? `${Math.round(entry.vitals.ctxPercent)}% ctx` : "ctx ?";
			const badge = row.unread > 0 ? ` · ${MAIL_ICON} ${row.unread}` : "";
			return {
				value: `agent:${entry.address}`,
				label: `${STATE_GLYPHS[entry.state]} ${entry.label || entry.address}`,
				description: `${entry.state} · ${formatTokens(entry.vitals.tokens)} tok · ${pct}${badge}`,
			};
		}
		case "archive-header":
			return {
				value: "archive-header",
				label: `${row.expanded ? "" : ""} .archive (${row.count})`,
				description: row.expanded ? "enter to collapse" : "enter to expand",
			};
		case "archived":
			return {
				value: `archived:${row.info.address}`,
				label: `   ${row.info.label || row.info.address}`,
				...(row.info.retiredAt ? { description: `retired ${row.info.retiredAt.slice(0, 10)}` } : {}),
			};
	}
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

	// Pi's native select-list treatment (matches getSelectListTheme).
	const listTheme = {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("muted", t),
	};
	// Same rule color as Pi's own /settings selector ("border" — dim in codex).
	const border = new DynamicBorder((s: string) => theme.fg("border", s));

	let roster: RosterEntry[] = [];
	let archived: ArchivedAgentInfo[] = [];
	let rows: PickerRow[] = [];
	let list: SelectList | null = null;
	let archiveExpanded = false;
	let confirmRetire: string | null = null;
	let closed = false;

	const selectedRow = (): PickerRow | undefined => {
		const value = list?.getSelectedItem()?.value;
		if (value === undefined) return undefined;
		return rows[rows.findIndex((row) => pickerRowItem(row).value === value)];
	};

	const rebuild = (): void => {
		const keepValue = list?.getSelectedItem()?.value;
		rows = buildPickerRows(roster, archived, { archiveExpanded, unread: (a) => core.agentUnreadCount(a) });
		if (rows.length === 0) {
			list = null;
			return;
		}
		const items = rows.map(pickerRowItem);
		list = new SelectList(items, Math.min(items.length, maxBody), listTheme, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 40 });
		const keep = items.findIndex((item) => item.value === keepValue);
		if (keep > 0) list.setSelectedIndex(keep);
		list.onSelect = (item) => {
			if (item.value.startsWith("agent:")) return finish({ action: "view", address: item.value.slice("agent:".length) });
			if (item.value === "archive-header") {
				archiveExpanded = !archiveExpanded;
				rebuild();
				tui.requestRender();
			}
		};
		list.onCancel = () => finish({ action: "closed" });
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

	function finish(result: PickerResult): void {
		if (closed) return;
		closed = true;
		offEvents();
		onDone(result);
	}

	return {
		invalidate() {
			list?.invalidate();
		},
		dispose() {
			closed = true;
			offEvents();
		},
		render(width: number): string[] {
			const clip = (text: string): string => truncateToWidth(text, Math.max(1, width), "…");
			const rule = border.render(width)[0] ?? "";
			const lines: string[] = [rule, clip(theme.fg("accent", theme.bold(`Subagents (${roster.length})`)))];
			if (list) lines.push(...list.render(width));
			else lines.push(theme.fg("muted", "  no subagents — spawn one with subagent_spawn"));
			if (confirmRetire) lines.push(clip(theme.fg("error", `  Retire ${confirmRetire}? [y/N]`)));
			else lines.push(clip(theme.fg("dim", "  ↑↓ move · Enter view · x cancel · S stop all · X retire · a archive · q close")));
			lines.push(rule);
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
			if (data === "q") return finish({ action: "closed" });
			// Empty roster: no SelectList exists, so its onCancel can never fire —
			// close on Esc/Ctrl+C here or the picker would swallow input forever.
			if (!list && (data === "\x1b" || data === "\x03")) return finish({ action: "closed" });
			if (data === "a") {
				archiveExpanded = !archiveExpanded;
				rebuild();
				return tui.requestRender();
			}
			// Stop-all: cancel every working agent (non-destructive; mail stays
			// pending). Uppercase, like retire — a fleet-wide action shouldn't be a
			// stray lowercase keypress away.
			if (data === "S") {
				return void core.cancelAllWorking().then(reload, reload);
			}
			const row = selectedRow();
			if (row?.kind === "agent" && data === "x") return void core.cancel(row.entry.address).then(reload).catch(reload);
			if (row?.kind === "agent" && data === "X") {
				confirmRetire = row.entry.address;
				return tui.requestRender();
			}
			// vim-style navigation on top of the list's native arrow handling.
			const forwarded = data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data;
			list?.handleInput(forwarded);
			tui.requestRender();
		},
	};
}
