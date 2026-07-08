/**
 * /queue (alias: /steer) — management panel for the pending-message queue.
 *
 * A SelectList of the pending entries (bookmark-manager idiom: action keys are
 * intercepted before the list so SelectList only ever sees navigation input):
 *
 *   ↑↓        select an entry
 *   Enter / e edit the selected entry in an embedded footer editor
 *   s         send the selected entry NOW (same delivery path as turn_end/agent_end)
 *   K / J     move the selected entry up / down (shift+k / shift+j)
 *   d / x     delete the selected entry
 *   t         toggle the whole queue between steer and queue (follow-up) mode
 *   Esc / q   close the panel
 *
 * The panel does not own the queue — index.ts does. It talks to it through a
 * QueueController and subscribes via setOnChange, so mutations that happen while
 * the panel is open (turn_end/agent_end delivery, alt+x, alt+q) refresh the list
 * live; when the queue empties from any side the panel closes itself.
 *
 * Edit uses the embedded footer-editor idiom (pi-browse filterEditor /
 * pi-show-files searchEditor): note that Editor.submitValue() clears the editor
 * and fires onChange("") BEFORE onSubmit, so onSubmit must take the submitted
 * text from its argument and re-apply it — never read it back from the editor.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	matchesKey,
	type SelectItem,
	SelectList,
	type TUI,
} from "@earendil-works/pi-tui";

/** Queue-wide delivery mode ("followUp" is Pi's name for queue-after-finish). */
export type QueueMode = "steer" | "followUp";

/** Read-only view of one pending entry (images stay behind in index.ts). */
export interface QueueEntryView {
	text: string;
	imageCount: number;
}

/**
 * The panel's handle on the queue owned by index.ts. Every mutator fires the
 * onChange callback (set via setOnChange) after the queue has been updated.
 */
export interface QueueController {
	entries(): QueueEntryView[];
	mode(): QueueMode;
	toggleMode(): QueueMode;
	removeAt(index: number): void;
	updateText(index: number, text: string): void;
	/** Move an entry by delta; returns the entry's new index (or the old one if blocked). */
	moveBy(index: number, delta: number): number;
	/** Remove an entry and deliver it immediately via the normal delivery path. */
	sendNow(index: number): void;
	/** Subscribe to queue mutations (panel refresh); pass null to unsubscribe. */
	setOnChange(cb: (() => void) | null): void;
}

export interface QueuePanelOptions {
	ctrl: QueueController;
	tui: TUI;
	theme: Theme;
	onDone: () => void;
}

export function createQueuePanel(opts: QueuePanelOptions): Component & { dispose?(): void } {
	const { ctrl, tui, theme, onDone } = opts;

	let editingIndex: number | null = null;
	let closed = false;

	const listTheme = {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};

	// ---- entry editor (embedded footer-editor idiom) -------------------------

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: listTheme,
	};
	const editor = new Editor(tui, editorTheme);
	editor.onSubmit = (value) => {
		// Editor.submitValue() fires onChange("") and clears the editor BEFORE
		// onSubmit runs, so the submitted text must come from `value` here (the
		// re-apply quirk — see pi-browse filterEditor / pi-show-files searchEditor).
		const index = editingIndex;
		editingIndex = null;
		const text = value.trim();
		if (index !== null && text) {
			ctrl.updateText(index, text); // fires onChange → rebuild
		}
		tui.requestRender();
	};

	// ---- select list (rebuilt on every queue mutation) ------------------------

	function buildItems(): SelectItem[] {
		return ctrl.entries().map((entry, i) => {
			const entryLines = entry.text.split("\n");
			const first = entryLines[0]?.trim() || "(empty)";
			const extras: string[] = [];
			if (entryLines.length > 1) extras.push(`+${entryLines.length - 1} more line${entryLines.length > 2 ? "s" : ""}`);
			if (entry.imageCount > 0) extras.push(`${entry.imageCount} image${entry.imageCount > 1 ? "s" : ""}`);
			return {
				value: String(i),
				label: `${i + 1}. ${first}`,
				description: extras.join(" · ") || undefined,
			};
		});
	}

	function buildList(selected: number): SelectList {
		const items = buildItems();
		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), listTheme);
		list.onSelect = (item) => beginEdit(Number(item.value));
		list.onCancel = () => close();
		list.setSelectedIndex(selected);
		return list;
	}

	let selectList = buildList(0);

	function selectedIndex(): number {
		const item = selectList.getSelectedItem();
		return item ? Number(item.value) : -1;
	}

	function rebuild(selected: number) {
		selectList = buildList(Math.max(0, Math.min(selected, ctrl.entries().length - 1)));
	}

	function close() {
		if (closed) return;
		closed = true;
		ctrl.setOnChange(null);
		onDone();
	}

	// Queue changed underneath us (panel action, keybind, or a delivery event):
	// refresh the list in place; when the queue is empty there is nothing left
	// to manage, so close.
	ctrl.setOnChange(() => {
		if (ctrl.entries().length === 0) {
			close();
		} else {
			if (editingIndex !== null && editingIndex >= ctrl.entries().length) editingIndex = null;
			rebuild(selectedIndex());
		}
		tui.requestRender();
	});

	// ---- actions ---------------------------------------------------------------

	function beginEdit(index: number) {
		const entry = ctrl.entries()[index];
		if (!entry) return;
		editingIndex = index;
		editor.setText(entry.text);
		tui.requestRender();
	}

	function handleInput(data: string): void {
		if (closed) return;

		if (editingIndex !== null) {
			if (matchesKey(data, "escape")) {
				editingIndex = null;
				tui.requestRender();
				return;
			}
			editor.handleInput(data);
			tui.requestRender();
			return;
		}

		const index = selectedIndex();
		if (index >= 0 && (matchesKey(data, "e") || matchesKey(data, "shift+e"))) {
			beginEdit(index);
			return;
		}
		if (
			index >= 0 &&
			(matchesKey(data, "d") || matchesKey(data, "shift+d") || matchesKey(data, "x") || matchesKey(data, "shift+x"))
		) {
			ctrl.removeAt(index); // onChange rebuilds (or closes when empty)
			return;
		}
		if (index >= 0 && matchesKey(data, "s")) {
			ctrl.sendNow(index); // onChange rebuilds (or closes when empty)
			return;
		}
		if (index >= 0 && matchesKey(data, "shift+k")) {
			const next = ctrl.moveBy(index, -1); // onChange rebuilds; re-seat on the moved entry
			selectList.setSelectedIndex(next);
			tui.requestRender();
			return;
		}
		if (index >= 0 && matchesKey(data, "shift+j")) {
			const next = ctrl.moveBy(index, 1);
			selectList.setSelectedIndex(next);
			tui.requestRender();
			return;
		}
		if (matchesKey(data, "t") || matchesKey(data, "shift+t")) {
			ctrl.toggleMode(); // onChange rerenders (header shows the mode)
			return;
		}
		if (matchesKey(data, "q")) {
			close();
			tui.requestRender();
			return;
		}
		selectList.handleInput(data);
		tui.requestRender();
	}

	// ---- render ------------------------------------------------------------------

	function render(width: number): string[] {
		const rule = new DynamicBorder((s: string) => theme.fg("accent", s)).render(width)[0] ?? "";
		const mode = ctrl.mode();
		const modeLabel =
			mode === "steer"
				? theme.fg("accent", "steer (next step boundary)")
				: theme.fg("success", "queue (after the agent finishes)");
		const lines: string[] = [];
		lines.push(rule);
		lines.push(
			theme.fg("accent", theme.bold(`Pending messages (${ctrl.entries().length})`)) +
				theme.fg("dim", " — mode: ") +
				modeLabel,
		);
		lines.push(...selectList.render(width));
		if (editingIndex !== null) {
			lines.push(
				theme.fg("accent", `Edit message ${editingIndex + 1}`) + theme.fg("dim", "  (Enter apply · Esc cancel)"),
			);
			for (const l of editor.render(Math.max(10, width - 2))) lines.push(` ${l}`);
		} else {
			lines.push(
				theme.fg("dim", "↑↓ select · Enter/e edit · s send now · K/J move · d/x delete · t toggle mode · Esc close"),
			);
		}
		lines.push(rule);
		return lines;
	}

	function invalidate() {
		selectList.invalidate();
		editor.invalidate();
	}

	return {
		render,
		handleInput,
		invalidate,
		dispose() {
			// Torn down from outside (not via close()): drop the subscription.
			closed = true;
			ctrl.setOnChange(null);
		},
	};
}
