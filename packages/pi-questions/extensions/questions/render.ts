/**
 * Rendering for the ask_user panel. renderPanel turns a snapshot of the
 * panel's state (PanelView) into the widget's lines: tab bar, the focused
 * input (or the Submit review page), inline validation, help, and terminal-
 * height fitting. ask.ts owns the state and the line cache and builds a fresh
 * view per render; the idx-based predicates it passes may trigger async
 * revalidation as a side effect, exactly as when they lived in ask.ts.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PICKER_ROW_CAP } from "./file-input.ts";
import {
	ICON_CHECK,
	ICON_CHECKBOX_OFF,
	ICON_CHECKBOX_ON,
	ICON_COMPLETE,
	ICON_EDIT,
	ICON_ERROR,
	ICON_INVALID,
	ICON_PENDING,
	ICON_RADIO_OFF,
	ICON_RADIO_ON,
	ICON_SKIPPED,
} from "./icons.ts";
import { type EditTarget, type InputState, nextButtonRow, somethingElseRow } from "./input-state.ts";
import type { Input } from "./schema.ts";

// The snapshot of panel state renderPanel needs; ask.ts builds one per render.
export interface PanelView {
	inputs: Input[];
	states: InputState[];
	theme: Theme;
	editor: Editor;
	editing: EditTarget;
	currentTab: number;
	submitCursor: number;
	notes: string;
	terminalRows: number;
	hasResponse(idx: number): boolean;
	isAnswered(idx: number): boolean;
	validationWarning(idx: number): string | null;
	ensurePickerLoaded(idx: number): void;
}

export function renderPanel(view: PanelView, width: number): string[] {
	const { inputs, states, theme, editor, editing, currentTab, submitCursor, notes } = view;
	const { hasResponse, isAnswered, validationWarning, ensurePickerLoaded } = view;
	const submitTab = inputs.length;
	const lines: string[] = [];
	const renderWidth = Math.max(1, width);

	function addWrapped(text: string) {
		lines.push(...wrapTextWithAnsi(text, renderWidth));
	}
	function addWrappedWithPrefix(prefix: string, text: string) {
		const prefixWidth = visibleWidth(prefix);
		if (prefixWidth >= renderWidth) {
			addWrapped(prefix + text);
			return;
		}
		const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
		const continuation = " ".repeat(prefixWidth);
		for (let i = 0; i < wrapped.length; i++) {
			lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
		}
	}

	lines.push(theme.fg("accent", "─".repeat(renderWidth)));

	// Tab bar.
	const tabs: string[] = ["← "];
	for (let i = 0; i < inputs.length; i++) {
		const active = i === currentTab;
		const skippedOptional = inputs[i].optional && !hasResponse(i);
		const valid = isAnswered(i);
		const invalid = hasResponse(i) && validationWarning(i) !== null;
		const box = valid ? ICON_COMPLETE : skippedOptional ? ICON_SKIPPED : invalid ? ICON_INVALID : ICON_PENDING;
		const color = valid ? "success" : skippedOptional ? "dim" : invalid ? "warning" : "muted";
		const label = ` ${box} ${inputs[i].title} `;
		tabs.push(`${active ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(color, label)} `);
	}
	const submitText = ` ${ICON_CHECK} Submit `;
	tabs.push(
		`${
			currentTab === submitTab
				? theme.bg("selectedBg", theme.fg("text", submitText))
				: theme.fg("success", submitText)
		} →`,
	);
	addWrappedWithPrefix(" ", tabs.join(""));
	lines.push("");
	const bodyStart = lines.length;

	if (currentTab === submitTab) {
		renderSubmit(addWrappedWithPrefix);
	} else {
		renderInput(currentTab, renderWidth, addWrappedWithPrefix);
	}
	const bodyEnd = lines.length;

	lines.push("");
	const help = editing
		? editing.kind === "picker"
			? "↑↓ move · →/← expand/collapse · Enter pick · q close"
			: "Enter to save · Esc to go back"
		: currentTab === submitTab
			? "↑↓ move · Enter choose · Tab/←→ switch · q cancel"
			: "↑↓ move · Space/Enter choose · Tab/←→ switch · q cancel";
	addWrappedWithPrefix(" ", theme.fg("dim", help));
	lines.push(theme.fg("accent", "─".repeat(renderWidth)));

	const terminalRows = Math.max(5, view.terminalRows);
	let fitted = lines;
	if (lines.length > terminalRows) {
		const header = lines.slice(0, bodyStart);
		const body = lines.slice(bodyStart, bodyEnd);
		const footer = lines.slice(bodyEnd);
		const available = terminalRows - header.length - footer.length;
		if (available > 0) {
			// Keep the focused action visible when a long option list exceeds the
			// terminal height. ANSI styling is ignored only for locating the marker.
			const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
			const focusLine = Math.max(0, body.findIndex((line) => /^\s*>\s/.test(plain(line))));
			const start = Math.max(0, Math.min(body.length - available, focusLine - Math.floor(available / 2)));
			fitted = [...header, ...body.slice(start, start + available), ...footer];
		} else {
			// Pathological tab wrapping: preserve the top and the help/footer.
			fitted = [...lines.slice(0, Math.max(1, terminalRows - 2)), ...lines.slice(-2)].slice(0, terminalRows);
		}
	}

	return fitted;

	// --- nested renderers (capture addWrappedWithPrefix / lines) ---

	function typeTag(inp: Input): string {
		if (inp.type === "text") return "text";
		if (inp.type === "radio") return "pick one";
		if (inp.type === "multi") return "pick any";
		// "file" — the only remaining type; validateInputs rejects anything else.
		return inp.fileKind === "any" ? "path" : inp.fileKind;
	}

	function optionSuffix(isDefault: boolean, isRecommended: boolean): string {
		const defaultLabel = isDefault ? theme.fg("dim", " (default)") : "";
		const recommendedLabel = isRecommended ? theme.fg("success", " (recommended)") : "";
		return defaultLabel + recommendedLabel;
	}

	function renderInput(idx: number, rw: number, add: (prefix: string, text: string) => void) {
		const inp = inputs[idx];
		const s = states[idx];
		add(
			" ",
			theme.fg("text", theme.bold(inp.title)) +
				theme.fg("dim", `  (${typeTag(inp)})`) +
				(inp.optional ? theme.fg("dim", "  (optional)") : ""),
		);
		if (inp.description) add(" ", theme.fg("muted", inp.description));
		lines.push("");

		if (inp.type === "text") {
			if (editing && editing.kind === "text" && editing.inputIdx === idx) {
				add(" ", theme.fg("muted", "Your answer:"));
				for (const line of editor.render(Math.max(1, rw - 2))) lines.push(` ${line}`);
			} else {
				// The edit action shares a tab with the trailing Next/Review button, so it
				// must only highlight when the cursor is actually on it (row 0).
				const editCursor = s.cursor === 0;
				const editPrefix = editCursor ? theme.fg("accent", "> ") : "  ";
				const editColor = editCursor ? "accent" : "dim";
				if (s.textValue) {
					// Show the current value first, then the edit action beneath it, so the
					// default (or previously entered) value reads as the answer and "Edit"
					// is the action that changes it.
					add("     ", theme.fg("text", s.textValue) + optionSuffix(!s.textEdited && !!inp.defaultText, false));
					lines.push("");
					add(editPrefix, theme.fg(editColor, `${ICON_EDIT} Edit`));
				} else {
					add(editPrefix, theme.fg(editColor, `${ICON_EDIT} Type your answer`));
				}
			}
			renderInlineWarning(idx, add);
			// Keep Edit and Next/Review adjacent (no gap) so they read as a switchable pair.
			renderNextButton(idx, add, false);
			return;
		}

		if (inp.type === "file") {
			renderFileInput(idx, rw, add);
			renderInlineWarning(idx, add);
			renderNextButton(idx, add);
			return;
		}

		// List options (radio / multi).
		for (let i = 0; i < inp.options.length; i++) {
			const opt = inp.options[i];
			const cursor = s.cursor === i;
			const chosen = s.selected.has(i);
			const mark = inp.type === "multi" ? (chosen ? ICON_CHECKBOX_ON : ICON_CHECKBOX_OFF) : chosen ? ICON_RADIO_ON : ICON_RADIO_OFF;
			const prefix = cursor ? theme.fg("accent", "> ") : "  ";
			const color = cursor ? "accent" : "text";
			const suffix = optionSuffix(!s.selectionEdited && !!inp.defaultSelections?.has(i), opt.recommended === true);
			add(prefix, `${theme.fg(chosen ? "success" : "dim", mark)} ${theme.fg(color, opt.title)}${suffix}`);
			if (opt.description) add("       ", theme.fg("muted", opt.description));
		}

		// "Something else" row.
		{
			const rowIdx = somethingElseRow(inp);
			const cursor = s.cursor === rowIdx;
			const chosen = s.customSelected;
			const mark = inp.type === "multi" ? (chosen ? ICON_CHECKBOX_ON : ICON_CHECKBOX_OFF) : chosen ? ICON_RADIO_ON : ICON_RADIO_OFF;
			const prefix = cursor ? theme.fg("accent", "> ") : "  ";
			const label = s.customValue ? `Something else: ${s.customValue}` : "Something else…";
			add(prefix, `${theme.fg(chosen ? "success" : "dim", mark)} ${theme.fg(cursor ? "accent" : "text", label)}`);
			if (editing && editing.kind === "custom" && editing.inputIdx === idx) {
				add("   ", theme.fg("muted", "Type your answer:"));
				for (const line of editor.render(Math.max(1, rw - 4))) lines.push(`   ${line}`);
			}
		}

		renderInlineWarning(idx, add);
		renderNextButton(idx, add);
	}

	function renderFileInput(idx: number, rw: number, add: (prefix: string, text: string) => void) {
		const s = states[idx];
		const pickerOpen = editing?.kind === "picker" && editing.inputIdx === idx;
		const browsePrefix = s.cursor === 0 || pickerOpen ? theme.fg("accent", "> ") : "  ";
		add(browsePrefix, theme.fg(pickerOpen || s.cursor === 0 ? "accent" : "text", `${pickerOpen ? "▾" : "▸"} Browse…`));
		if (pickerOpen) renderPicker(idx, rw, add);

		const typePrefix = s.cursor === 1 ? theme.fg("accent", "> ") : "  ";
		const typeLabel = s.textValue ? `${ICON_EDIT} Path` : `${ICON_EDIT} Type a path…`;
		add(typePrefix, theme.fg(s.cursor === 1 ? "accent" : "dim", typeLabel));
		if (editing && editing.kind === "text" && editing.inputIdx === idx) {
			add("   ", theme.fg("muted", "Path:"));
			for (const line of editor.render(Math.max(1, rw - 4))) lines.push(`   ${line}`);
		} else if (s.textValue) {
			add("     ", theme.fg("text", s.textValue) + optionSuffix(!s.textEdited && !!inputs[idx].defaultText, false));
		}
	}

	function renderPicker(idx: number, rw: number, add: (prefix: string, text: string) => void) {
		ensurePickerLoaded(idx);
		const s = states[idx];
		const visible = s.pickerRows.slice(s.pickerScroll, s.pickerScroll + PICKER_ROW_CAP);
		if (s.pickerLoading && visible.length === 0) {
			add("   ", theme.fg("muted", "Loading…"));
			return;
		}
		if (visible.length === 0) {
			add("   ", theme.fg("muted", "(empty directory)"));
			return;
		}
		if (s.pickerScroll > 0) add("   ", theme.fg("dim", "↑ more"));
		for (let i = 0; i < visible.length; i++) {
			const node = visible[i]!;
			const absIdx = s.pickerScroll + i;
			const isCursor = absIdx === s.pickerSelected;
			const indent = "  ".repeat(Math.max(0, node.depth - 1));
			const typeMark = node.isDir ? (node.expanded ? "▾" : "▸") : " ";
			const name = node.isDir ? `${node.name}/` : node.name;
			const label = `${indent}${typeMark} ${name}`;
			const pointer = isCursor ? theme.fg("accent", "> ") : "  ";
			const body = isCursor ? theme.fg("accent", label) : node.isDir ? theme.fg("text", label) : theme.fg("dim", label);
			add("   ", `${pointer}${truncateToWidth(body, Math.max(1, rw - 5), "…")}`);
		}
		if (s.pickerScroll + PICKER_ROW_CAP < s.pickerRows.length) add("   ", theme.fg("dim", "↓ more"));
	}

	function renderInlineWarning(idx: number, add: (prefix: string, text: string) => void) {
		const warning = validationWarning(idx);
		if (warning) {
			lines.push("");
			add(" ", theme.fg("warning", `${ICON_ERROR} ${warning}`));
		}
	}

	function renderNextButton(idx: number, add: (prefix: string, text: string) => void, spaced = true) {
		const cursor = states[idx].cursor === nextButtonRow(inputs[idx]);
		// The last input advances to the Submit review; earlier ones to the next input.
		const label = idx === inputs.length - 1 ? "Review →" : "Next →";
		const prefix = cursor ? theme.fg("accent", "> ") : "  ";
		if (spaced) lines.push("");
		add(prefix, theme.fg(cursor ? "accent" : "muted", label));
	}

	function answerPreview(idx: number): string {
		const inp = inputs[idx];
		const s = states[idx];
		if (inp.optional && !hasResponse(idx)) return theme.fg("dim", "(skipped — optional)");
		if (inp.type === "text" || inp.type === "file") {
			return s.textValue || theme.fg("warning", "(unanswered)");
		}
		const picks: string[] = [];
		for (let j = 0; j < inp.options.length; j++) {
			if (s.selected.has(j)) picks.push(inp.options[j].title);
		}
		if (s.customSelected && s.customValue) picks.push(`${s.customValue} (else)`);
		return picks.length ? picks.join(", ") : theme.fg("warning", "(unanswered)");
	}

	function renderSubmit(add: (prefix: string, text: string) => void) {
		add(" ", theme.fg("accent", theme.bold("Review & submit")));
		lines.push("");
		for (let i = 0; i < inputs.length; i++) {
			const inp = inputs[i];
			add(" ", `${theme.fg("muted", `${inp.title}: `)}${theme.fg("text", answerPreview(i))}`);
		}
		lines.push("");

		// Optional Notes section (submitCursor row 0).
		const noteCursor = submitCursor === 0;
		const notePrefix = noteCursor ? theme.fg("accent", "> ") : "  ";
		const noteLabel = notes ? `${ICON_EDIT} Notes` : `${ICON_EDIT} Add notes…`;
		add(notePrefix, theme.fg(noteCursor ? "accent" : "dim", noteLabel));
		if (notes && !(editing && editing.kind === "notes")) {
			add("     ", theme.fg("muted", notes));
		}
		if (editing && editing.kind === "notes") {
			add("   ", theme.fg("muted", "Your notes:"));
			for (const line of editor.render(Math.max(1, renderWidth - 4))) lines.push(`   ${line}`);
		}
		lines.push("");

		// Submit button (submitCursor row 1). Validation is advisory, so warnings
		// remain visible without disabling submission.
		const submitFocused = submitCursor === 1;
		const submitPrefix = submitFocused ? theme.fg("accent", "> ") : "  ";
		const submitColor = submitFocused ? "accent" : "success";
		add(submitPrefix, theme.fg(submitColor, `${ICON_CHECK} Submit`));

		const warnings = inputs
			.filter((_, i) => hasResponse(i) && validationWarning(i) !== null)
			.map((inp) => inp.title);
		if (warnings.length > 0) {
			add(" ", theme.fg("warning", `Check: ${warnings.join(", ")} (submission is allowed)`));
		}
	}
}
