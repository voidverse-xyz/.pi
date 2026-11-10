/**
 * The interactive ask-user flow, factored out of index.ts. It runs only in the
 * main TUI; headless callers are rejected by the tool before reaching this panel.
 *
 * This file is the orchestrator: tab/cursor state, the shared editor, keyboard
 * dispatch, validation, and answer collection. The pieces live in siblings —
 * input-state.ts (per-input state + row geometry), file-input.ts (typed paths,
 * stat checks, picker state machine), and render.ts (drawing).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey } from "@earendil-works/pi-tui";
import {
	checkFilePath,
	collapseOrParentPickerNode,
	ensurePickerLoaded,
	expandPickerNode,
	movePicker,
	selectedPickerNode,
	typedPath,
} from "./file-input.ts";
import {
	activateChoiceRow,
	createInputState,
	type EditTarget,
	nextButtonRow,
	rowCount,
} from "./input-state.ts";
import type { TreeNode } from "./picker-tree.ts";
import { renderPanel } from "./render.ts";
import type { Input, InputAnswer, UserInputsResult } from "./schema.ts";

const MAX_ANSWER_CHARS = 16 * 1024;

/**
 * Render the interactive inputs panel and resolve with the user's answers. Requires
 * TUI mode; callers gate on that.
 */
export function showUserInputs(
	ctx: ExtensionContext,
	inputs: Input[],
	rootDir = ctx.cwd,
): Promise<UserInputsResult> {
	return ctx.ui.custom<UserInputsResult>((tui, theme, _kb, done) => {
		const totalTabs = inputs.length + 1; // inputs + Submit
		const submitTab = inputs.length;
		let currentTab = 0;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		let editing: EditTarget = null;
		// Review page: an optional Notes section plus a focusable cursor (0 = notes, 1 = Submit).
		// Defaults to the Submit button so Enter on the review page still submits immediately.
		let notes = "";
		let submitCursor = 1;

		const states = inputs.map(createInputState);

		const compiledPatterns = inputs.map((input) => (input.pattern !== undefined ? new RegExp(input.pattern) : null));

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		// ----- derived state -----

		function selectionCount(idx: number): number {
			const s = states[idx];
			return s.selected.size + (s.customSelected && s.customValue ? 1 : 0);
		}

		function hasResponse(idx: number): boolean {
			const inp = inputs[idx];
			const s = states[idx];
			if (inp.type === "text" || inp.type === "file") {
				return s.textValue.trim().length > 0;
			}
			return selectionCount(idx) > 0;
		}

		function isAnswered(idx: number): boolean {
			return hasResponse(idx) && validationWarning(idx) === null;
		}

		function refresh() {
			cachedWidth = undefined;
			cachedLines = undefined;
			tui.requestRender();
		}

		// ----- editing -----

		function openEditor(target: Exclude<EditTarget, null>) {
			editing = target;
			if (target.kind === "notes") {
				editor.setText(notes);
				refresh();
				return;
			}
			const s = states[target.inputIdx];
			if (target.kind === "picker") {
				ensurePickerLoaded(rootDir, s, refresh);
				refresh();
				return;
			}
			editor.setText(target.kind === "text" ? s.textValue : s.customValue);
			refresh();
		}

		function closeEditor() {
			editing = null;
			editor.setText("");
			refresh();
		}

		editor.onSubmit = (value) => {
			if (!editing || editing.kind === "picker") return;
			const trimmed = value.trim();
			if (trimmed.length > MAX_ANSWER_CHARS) {
				ctx.ui.notify(`Answer is too long (maximum ${MAX_ANSWER_CHARS} characters)`, "warning");
				return;
			}
			if (editing.kind === "notes") {
				notes = trimmed;
				closeEditor();
				return;
			}
			const s = states[editing.inputIdx];
			if (editing.kind === "text") {
				s.textValue = trimmed;
				s.textEdited = true;
				s.fileStat = undefined;
			} else {
				// custom "Something else"
				if (trimmed) {
					s.customValue = trimmed;
					s.customSelected = true;
					s.selectionEdited = true;
					if (inputs[editing.inputIdx].type === "radio") s.selected.clear();
				} else {
					s.customValue = "";
					s.customSelected = false;
					s.selectionEdited = true;
				}
			}
			closeEditor();
		};

		// ----- file picker / validation -----

		function pickNode(idx: number, node: TreeNode) {
			const inp = inputs[idx];
			const s = states[idx];
			s.textValue = node.rel || node.abs;
			s.textEdited = true;
			s.fileStat = undefined;
			if (inp.type === "file") void checkFilePath(rootDir, inp.fileKind, s, refresh);
			closeEditor();
		}

		function handlePickerInput(data: string, idx: number) {
			const s = states[idx];
			ensurePickerLoaded(rootDir, s, refresh);
			if (data === "q" || matchesKey(data, Key.escape)) {
				closeEditor();
				return;
			}
			if (matchesKey(data, Key.up) || data === "k") {
				movePicker(s, -1, refresh);
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				movePicker(s, 1, refresh);
				return;
			}
			const node = selectedPickerNode(s);
			if (!node) return;
			if (matchesKey(data, Key.right)) {
				void expandPickerNode(rootDir, s, node, refresh);
				return;
			}
			if (matchesKey(data, Key.left)) {
				collapseOrParentPickerNode(s, node, refresh);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				pickNode(idx, node);
			}
		}

		function validationWarning(idx: number): string | null {
			const inp = inputs[idx];
			const s = states[idx];
			const has = hasResponse(idx);
			if (!has) return null;

			if (inp.type === "text") {
				const text = s.textValue.trim();
				const pattern = compiledPatterns[idx];
				if (pattern && !pattern.test(text)) return inp.patternHint ?? `Must match: ${inp.pattern}`;
				return null;
			}

			if (inp.type === "file") {
				const cache = checkFilePath(rootDir, inp.fileKind, s, refresh);
				if (!cache || cache.status === "checking") return "Checking path…";
				if (cache.status === "wrong-kind") return cache.message ?? "Pick a file/directory";
				return null;
			}

			return null;
		}

		// ----- activation of a highlighted row -----

		function goNext() {
			currentTab = Math.min(submitTab, currentTab + 1);
			refresh();
		}

		function activateRow(idx: number) {
			const inp = inputs[idx];
			const s = states[idx];
			// The trailing button row advances to the next tab (or the Submit review).
			if (s.cursor === nextButtonRow(inp)) {
				goNext();
				return;
			}
			if (inp.type === "text") {
				openEditor({ kind: "text", inputIdx: idx });
				return;
			}
			if (inp.type === "file") {
				if (s.cursor === 0) {
					openEditor({ kind: "picker", inputIdx: idx });
					return;
				}
				if (s.cursor === 1) {
					openEditor({ kind: "text", inputIdx: idx });
				}
				return;
			}

			const action = activateChoiceRow(inp, s);
			if (action === "selection-changed") {
				refresh();
				return;
			}
			if (action === "edit-custom") {
				// Always reopen with the saved value so "Something else" is editable
				// after choosing another option or returning to this row later.
				openEditor({ kind: "custom", inputIdx: idx });
			}
		}

		// ----- input handling -----

		function handleInput(data: string) {
			if (editing) {
				if (editing.kind === "picker") {
					handlePickerInput(data, editing.inputIdx);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					closeEditor();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// Tab navigation across inputs + submit.
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				currentTab = (currentTab + 1) % totalTabs;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				currentTab = (currentTab - 1 + totalTabs) % totalTabs;
				refresh();
				return;
			}

			// Submit tab: navigate between the optional Notes section (0) and the Submit button (1).
			if (currentTab === submitTab) {
				if (matchesKey(data, Key.up) || data === "k") {
					submitCursor = Math.max(0, submitCursor - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down) || data === "j") {
					submitCursor = Math.min(1, submitCursor + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
					if (submitCursor === 0) {
						openEditor({ kind: "notes" });
					} else {
						done({ answers: collectAnswers(), cancelled: false, note: notes || undefined });
					}
					return;
				}
				if (data === "q" || matchesKey(data, Key.escape)) {
					done({ answers: [], cancelled: true });
				}
				return;
			}

			const idx = currentTab;
			const s = states[idx];

			if (matchesKey(data, Key.up) || data === "k") {
				s.cursor = Math.max(0, s.cursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				s.cursor = Math.min(rowCount(inputs[idx]) - 1, s.cursor + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				activateRow(idx);
				return;
			}
			if (data === "q" || matchesKey(data, Key.escape)) {
				done({ answers: [], cancelled: true });
			}
		}

		function collectAnswers(): InputAnswer[] {
			return inputs.map((inp, idx): InputAnswer => {
				const s = states[idx];
				let answer: InputAnswer;
				if (!hasResponse(idx)) {
					answer = { type: inp.type, title: inp.title };
					if (inp.optional) answer.skipped = true;
					else if (inp.type === "text" || inp.type === "file") answer.text = "(no response)";
					else answer.selections = [];
				} else if (inp.type === "text") {
					answer = { type: inp.type, title: inp.title, text: s.textValue };
				} else if (inp.type === "file") {
					const pathInfo = typedPath(rootDir, s.textValue);
					answer = { type: inp.type, title: inp.title, text: pathInfo.display, path: pathInfo.abs };
				} else {
					const selections: { title: string; value: string; custom: boolean }[] = [];
					for (let i = 0; i < inp.options.length; i++) {
						if (s.selected.has(i)) {
							const opt = inp.options[i];
							selections.push({ title: opt.title, value: opt.value ?? opt.title, custom: false });
						}
					}
					if (s.customSelected && s.customValue) {
						selections.push({ title: s.customValue, value: s.customValue, custom: true });
					}
					answer = { type: inp.type, title: inp.title, selections };
				}
				if (inp.id) answer.id = inp.id;
				return answer;
			});
		}

		// ----- rendering (render.ts draws from a per-call snapshot of the state) -----

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const fitted = renderPanel(
				{
					inputs,
					states,
					theme,
					editor,
					editing,
					currentTab,
					submitCursor,
					notes,
					terminalRows: tui.terminal.rows,
					hasResponse,
					isAnswered,
					validationWarning,
					ensurePickerLoaded: (idx) => ensurePickerLoaded(rootDir, states[idx], refresh),
				},
				width,
			);
			cachedWidth = width;
			cachedLines = fitted;
			return fitted;
		}

		return {
			get focused() {
				return editor.focused;
			},
			set focused(value: boolean) {
				editor.focused = value;
			},
			render,
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}
