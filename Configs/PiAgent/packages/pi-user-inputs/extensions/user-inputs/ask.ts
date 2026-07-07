/**
 * The user-inputs ask flow, factored out of index.ts so it can run in two places:
 *
 *   - directly, when the agent calling ask_user has the interactive TUI, and
 *   - on behalf of a headless subagent: index.ts's `ipc:serve` handler runs the panel in
 *     the parent session when a "user.ask" is forwarded up through the optional `ipc`
 *     extension.
 *
 * showUserInputs takes a `from` agent path (e.g. ["worker","reviewer"]) and, when it
 * is non-empty, renders a header naming who is asking — so the user always knows the
 * question is coming from a subagent rather than the main agent, and which one.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type InputType = "text" | "radio" | "multi";

export interface Option {
	title: string;
	description?: string;
}

export interface Input {
	type: InputType;
	title: string;
	description?: string;
	options: Option[];
}

export interface InputAnswer {
	type: InputType;
	title: string;
	/** Present for "text" inputs. */
	text?: string;
	/** Present for "radio"/"multi" inputs. `custom` flags the "Something else" answer. */
	selections?: { title: string; custom: boolean }[];
	/** Optional free-text note attached to a list input. */
	note?: string;
}

export interface UserInputsResult {
	answers: InputAnswer[];
	cancelled: boolean;
}

/** Raw input as it arrives from the tool schema (options optional/looser). */
export interface RawInput {
	type: InputType;
	title: string;
	description?: string;
	options?: { title: string; description?: string }[];
}

// Per-input mutable UI state.
interface InputState {
	selected: Set<number>; // chosen option indices
	customValue: string; // "Something else" text ("" = none)
	customSelected: boolean;
	note: string;
	textValue: string;
	cursor: number; // highlighted row within this input
}

// What the shared editor is currently capturing.
type EditTarget = { kind: "text" | "custom" | "note"; inputIdx: number } | null;

/** Normalize schema input into the internal shape (options always an array). */
export function normalizeInputs(raw: RawInput[]): Input[] {
	return raw.map((i) => ({
		type: i.type,
		title: i.title,
		description: i.description,
		options: (i.options ?? []).map((o) => ({ title: o.title, description: o.description })),
	}));
}

/** Returns an error message if the inputs can't be presented, else null. */
export function validateInputs(inputs: Input[]): string | null {
	if (inputs.length === 0) return "Error: no inputs provided.";
	const badList = inputs.find((i) => i.type !== "text" && i.options.length === 0);
	if (badList) return `Error: input "${badList.title}" is a ${badList.type} list but has no options.`;
	return null;
}

/** A readable summary of the answers for the model. */
export function summarizeAnswers(result: UserInputsResult): string {
	if (result.cancelled) return "User cancelled the inputs.";
	const lines = result.answers.map((a) => {
		if (a.type === "text") return `- ${a.title}: ${a.text}`;
		const picks = (a.selections ?? []).map((s) => (s.custom ? `${s.title} (something else)` : s.title));
		const chosen = picks.length ? picks.join(", ") : "(none)";
		const note = a.note ? ` [note: ${a.note}]` : "";
		return `- ${a.title}: ${chosen}${note}`;
	});
	return `User answered:\n${lines.join("\n")}`;
}

/**
 * Render the interactive inputs panel and resolve with the user's answers. Requires
 * tui mode; callers gate on that (a headless caller forwards over IPC instead). When
 * `from` is non-empty, a header names the asking subagent chain.
 */
export function showUserInputs(ctx: ExtensionContext, inputs: Input[], from: string[]): Promise<UserInputsResult> {
	return ctx.ui.custom<UserInputsResult>((tui, theme, _kb, done) => {
		const totalTabs = inputs.length + 1; // inputs + Submit
		const submitTab = inputs.length;
		let currentTab = 0;
		let cachedLines: string[] | undefined;
		let editing: EditTarget = null;

		const states: InputState[] = inputs.map(() => ({
			selected: new Set<number>(),
			customValue: "",
			customSelected: false,
			note: "",
			textValue: "",
			cursor: 0,
		}));

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

		// ----- geometry helpers -----

		function optionRows(idx: number): number {
			return inputs[idx].options.length;
		}
		function rowCount(idx: number): number {
			return inputs[idx].type === "text" ? 1 : optionRows(idx) + 2;
		}
		function somethingElseRow(idx: number): number {
			return optionRows(idx);
		}
		function noteRow(idx: number): number {
			return optionRows(idx) + 1;
		}

		function isAnswered(idx: number): boolean {
			const s = states[idx];
			if (inputs[idx].type === "text") return s.textValue.trim().length > 0;
			return s.selected.size > 0 || s.customSelected;
		}
		function allAnswered(): boolean {
			return inputs.every((_, i) => isAnswered(i));
		}

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		// ----- editing -----

		function openEditor(target: Exclude<EditTarget, null>) {
			editing = target;
			const s = states[target.inputIdx];
			editor.setText(target.kind === "text" ? s.textValue : target.kind === "custom" ? s.customValue : s.note);
			refresh();
		}

		function closeEditor() {
			editing = null;
			editor.setText("");
			refresh();
		}

		editor.onSubmit = (value) => {
			if (!editing) return;
			const trimmed = value.trim();
			const s = states[editing.inputIdx];
			if (editing.kind === "text") {
				s.textValue = trimmed;
			} else if (editing.kind === "note") {
				s.note = trimmed;
			} else {
				// custom "Something else"
				if (trimmed) {
					s.customValue = trimmed;
					s.customSelected = true;
					if (inputs[editing.inputIdx].type === "radio") s.selected.clear();
				} else {
					s.customValue = "";
					s.customSelected = false;
				}
			}
			closeEditor();
		};

		// ----- activation of a highlighted row -----

		function activateRow(idx: number) {
			const inp = inputs[idx];
			const s = states[idx];
			if (inp.type === "text") {
				openEditor({ kind: "text", inputIdx: idx });
				return;
			}
			const row = s.cursor;
			if (row < optionRows(idx)) {
				if (inp.type === "radio") {
					s.selected.clear();
					s.selected.add(row);
					s.customSelected = false;
				} else {
					if (s.selected.has(row)) s.selected.delete(row);
					else s.selected.add(row);
				}
				refresh();
				return;
			}
			if (row === somethingElseRow(idx)) {
				// If a custom value already exists, a bare toggle is more useful than reopening the editor.
				if (s.customValue) {
					s.customSelected = !s.customSelected;
					if (s.customSelected && inp.type === "radio") s.selected.clear();
					refresh();
				} else {
					openEditor({ kind: "custom", inputIdx: idx });
				}
				return;
			}
			if (row === noteRow(idx)) {
				openEditor({ kind: "note", inputIdx: idx });
			}
		}

		// ----- input handling -----

		function handleInput(data: string) {
			if (editing) {
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

			// Submit tab.
			if (currentTab === submitTab) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					done({ answers: collectAnswers(), cancelled: false });
				} else if (matchesKey(data, Key.escape)) {
					done({ answers: [], cancelled: true });
				}
				return;
			}

			const idx = currentTab;
			const s = states[idx];

			if (matchesKey(data, Key.up)) {
				s.cursor = Math.max(0, s.cursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				s.cursor = Math.min(rowCount(idx) - 1, s.cursor + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				activateRow(idx);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done({ answers: [], cancelled: true });
			}
		}

		function collectAnswers(): InputAnswer[] {
			return inputs.map((inp, idx) => {
				const s = states[idx];
				if (inp.type === "text") {
					return { type: inp.type, title: inp.title, text: s.textValue || "(no response)" };
				}
				const selections: { title: string; custom: boolean }[] = [];
				for (let i = 0; i < inp.options.length; i++) {
					if (s.selected.has(i)) selections.push({ title: inp.options[i].title, custom: false });
				}
				if (s.customSelected && s.customValue) selections.push({ title: s.customValue, custom: true });
				const answer: InputAnswer = { type: inp.type, title: inp.title, selections };
				if (s.note) answer.note = s.note;
				return answer;
			});
		}

		// ----- rendering -----

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
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

			// Who's asking — only when a subagent is the origin (empty for the main agent).
			if (from.length > 0) {
				addWrappedWithPrefix(
					" ",
					theme.fg("warning", from.join(" → ")) + theme.fg("dim", " is asking:"),
				);
				lines.push("");
			}

			// Tab bar.
			const tabs: string[] = ["← "];
			for (let i = 0; i < inputs.length; i++) {
				const active = i === currentTab;
				const box = isAnswered(i) ? "■" : "□";
				const color = isAnswered(i) ? "success" : "muted";
				const label = ` ${box} ${inputs[i].title} `;
				tabs.push(`${active ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(color, label)} `);
			}
			const submitText = " ✓ Submit ";
			tabs.push(
				`${
					currentTab === submitTab
						? theme.bg("selectedBg", theme.fg("text", submitText))
						: theme.fg(allAnswered() ? "success" : "dim", submitText)
				} →`,
			);
			addWrappedWithPrefix(" ", tabs.join(""));
			lines.push("");

			if (currentTab === submitTab) {
				renderSubmit(addWrappedWithPrefix);
			} else {
				renderInput(currentTab, renderWidth, addWrappedWithPrefix);
			}

			lines.push("");
			const help = editing
				? "Enter to save • Esc to go back"
				: currentTab === submitTab
					? "Tab/←→ switch • Enter submit • Esc cancel"
					: "↑↓ move • Space/Enter choose • Tab/←→ switch • Esc cancel";
			addWrappedWithPrefix(" ", theme.fg("dim", help));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;

			// --- nested renderers (capture addWrappedWithPrefix / lines) ---

			function renderInput(idx: number, rw: number, add: (prefix: string, text: string) => void) {
				const inp = inputs[idx];
				const s = states[idx];
				const typeTag = inp.type === "text" ? "text" : inp.type === "radio" ? "pick one" : "pick any";
				add(" ", theme.fg("text", theme.bold(inp.title)) + theme.fg("dim", `  (${typeTag})`));
				if (inp.description) add(" ", theme.fg("muted", inp.description));
				lines.push("");

				if (inp.type === "text") {
					if (editing && editing.kind === "text" && editing.inputIdx === idx) {
						add(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, rw - 2))) lines.push(` ${line}`);
					} else {
						const prefix = theme.fg("accent", "> ");
						add(prefix, theme.fg("accent", s.textValue ? "✎ Edit answer" : "✎ Type your answer"));
						if (s.textValue) add("     ", theme.fg("text", s.textValue));
					}
					return;
				}

				// List options.
				for (let i = 0; i < inp.options.length; i++) {
					const opt = inp.options[i];
					const cursor = s.cursor === i;
					const chosen = s.selected.has(i);
					const mark = inp.type === "radio" ? (chosen ? "(●)" : "( )") : chosen ? "[x]" : "[ ]";
					const prefix = cursor ? theme.fg("accent", "> ") : "  ";
					const color = cursor ? "accent" : "text";
					add(prefix, `${theme.fg(chosen ? "success" : "dim", mark)} ${theme.fg(color, opt.title)}`);
					if (opt.description) add("       ", theme.fg("muted", opt.description));
				}

				// "Something else" row.
				{
					const rowIdx = somethingElseRow(idx);
					const cursor = s.cursor === rowIdx;
					const chosen = s.customSelected;
					const mark = inp.type === "radio" ? (chosen ? "(●)" : "( )") : chosen ? "[x]" : "[ ]";
					const prefix = cursor ? theme.fg("accent", "> ") : "  ";
					const label = s.customValue ? `Something else: ${s.customValue}` : "Something else…";
					add(prefix, `${theme.fg(chosen ? "success" : "dim", mark)} ${theme.fg(cursor ? "accent" : "text", label)}`);
					if (editing && editing.kind === "custom" && editing.inputIdx === idx) {
						add("   ", theme.fg("muted", "Type your answer:"));
						for (const line of editor.render(Math.max(1, rw - 4))) lines.push(`   ${line}`);
					}
				}

				// "Add a note" row — padded from the choices above it.
				lines.push("");
				{
					const rowIdx = noteRow(idx);
					const cursor = s.cursor === rowIdx;
					const prefix = cursor ? theme.fg("accent", "> ") : "  ";
					const label = s.note ? "✎ Note" : "✎ Add a note…";
					add(prefix, theme.fg(cursor ? "accent" : "dim", label));
					if (s.note && !(editing && editing.kind === "note" && editing.inputIdx === idx)) {
						add("     ", theme.fg("muted", s.note));
					}
					if (editing && editing.kind === "note" && editing.inputIdx === idx) {
						add("   ", theme.fg("muted", "Your note:"));
						for (const line of editor.render(Math.max(1, rw - 4))) lines.push(`   ${line}`);
					}
				}
			}

			function renderSubmit(add: (prefix: string, text: string) => void) {
				add(" ", theme.fg("accent", theme.bold("Review & submit")));
				lines.push("");
				for (let i = 0; i < inputs.length; i++) {
					const inp = inputs[i];
					const s = states[i];
					let value: string;
					if (inp.type === "text") {
						value = s.textValue || theme.fg("warning", "(unanswered)");
					} else {
						const picks: string[] = [];
						for (let j = 0; j < inp.options.length; j++) {
							if (s.selected.has(j)) picks.push(inp.options[j].title);
						}
						if (s.customSelected && s.customValue) picks.push(`${s.customValue} (else)`);
						value = picks.length ? picks.join(", ") : theme.fg("warning", "(unanswered)");
						if (s.note) value += theme.fg("dim", `  — note: ${s.note}`);
					}
					add(" ", `${theme.fg("muted", `${inp.title}: `)}${theme.fg("text", value)}`);
				}
				lines.push("");
				if (allAnswered()) {
					add(" ", theme.fg("success", "Press Enter to submit"));
				} else {
					const missing = inputs.filter((_, i) => !isAnswered(i)).map((inp) => inp.title).join(", ");
					add(" ", theme.fg("warning", `Still unanswered: ${missing}`));
				}
			}
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}
