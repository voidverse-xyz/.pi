/**
 * Per-input mutable UI state for the ask_user panel, plus the pure row
 * geometry derived from an input's shape. Shared by ask.ts (state + keyboard)
 * and render.ts (drawing); kept free of TUI concerns.
 */

import type { FileInputState } from "./file-input.ts";
import type { Input } from "./schema.ts";

// Per-input mutable UI state (the file/picker slice lives in FileInputState).
export interface InputState extends FileInputState {
	selected: Set<number>; // chosen option indices
	customValue: string; // "Something else" text ("" = none)
	customSelected: boolean;
	cursor: number; // highlighted row within this input
	textEdited: boolean;
	selectionEdited: boolean;
}

// What the shared editor/tree picker is currently capturing.
export type EditTarget =
	| { kind: "text" | "custom" | "picker"; inputIdx: number }
	| { kind: "notes" }
	| null;

function defaultSet(set: Set<number> | undefined): Set<number> {
	return new Set(set ?? []);
}

export function createInputState(input: Input): InputState {
	return {
		selected: defaultSet(input.defaultSelections),
		customValue: "",
		customSelected: false,
		textValue: input.defaultText ?? "",
		cursor: 0,
		textEdited: false,
		selectionEdited: false,
		pickerRows: [],
		pickerSelected: 0,
		pickerScroll: 0,
		pickerLoading: false,
		pickerLoadToken: 0,
		fileStatToken: 0,
	};
}

// ----- row geometry -----

export function optionRows(inp: Input): number {
	return inp.options.length;
}
export function somethingElseRow(inp: Input): number {
	return optionRows(inp);
}
// Rows the input's own content occupies (before the trailing "Next" button).
// text: 1 (edit). file: 2 (browse, type). radio/multi: options + "Something else".
export function contentRows(inp: Input): number {
	if (inp.type === "text") return 1;
	if (inp.type === "file") return 2;
	return optionRows(inp) + 1;
}
// Every input ends with a focusable "Next →" (or "Review →") button row.
export function nextButtonRow(inp: Input): number {
	return contentRows(inp);
}
export function rowCount(inp: Input): number {
	return contentRows(inp) + 1;
}

export type ChoiceRowAction = "selection-changed" | "edit-custom" | null;

/** Apply a radio/multi option row, or request the custom-value editor. */
export function activateChoiceRow(inp: Input, state: InputState): ChoiceRowAction {
	if (inp.type !== "radio" && inp.type !== "multi") return null;
	const row = state.cursor;
	if (row < optionRows(inp)) {
		if (inp.type === "radio") {
			state.selected.clear();
			state.selected.add(row);
			state.customSelected = false;
		} else if (state.selected.has(row)) {
			state.selected.delete(row);
		} else {
			state.selected.add(row);
		}
		state.selectionEdited = true;
		return "selection-changed";
	}
	if (row === somethingElseRow(inp)) {
		state.customSelected = true;
		state.selectionEdited = true;
		if (inp.type === "radio") state.selected.clear();
		return "edit-custom";
	}
	return null;
}
