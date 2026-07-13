/**
 * The interactive ask-user flow, factored out of index.ts. It runs only in the
 * main TUI; headless callers are rejected by the tool before reaching this panel.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createRoot, flatten, loadChildren, type TreeNode } from "./picker-tree.ts";

export type InputType = "text" | "radio" | "multi" | "file";
export type FileKind = "file" | "directory" | "any";

export interface Option {
	title: string;
	description?: string;
	/** Stable value returned when this option is selected, instead of its display title. */
	value?: string;
	/** Visually suggests this option without selecting it. */
	recommended?: boolean;
}

export interface Input {
	type: InputType;
	title: string;
	/** Optional stable identifier echoed back in this input's answer. */
	id?: string;
	description?: string;
	options: Option[];
	optional?: boolean;
	default?: string;
	defaults?: string[];
	pattern?: string;
	patternHint?: string;
	fileKind: FileKind;
	defaultText?: string;
	defaultSelections?: Set<number>;
	defaultError?: string;
	defaultProvided?: boolean;
	defaultsProvided?: boolean;
	fileKindProvided?: boolean;
}

export interface InputAnswer {
	type: InputType;
	title: string;
	/** Stable id echoed from the input, when one was provided. */
	id?: string;
	/** Present for text-like inputs and human-readable list/file answers. */
	text?: string;
	/** Present for "radio"/"multi" inputs. `value` is options[].value ?? title; `custom` flags "Something else". */
	selections?: { title: string; value: string; custom: boolean }[];
	/** Absolute path for file inputs. */
	path?: string;
	/** True when an optional input was intentionally left unanswered. */
	skipped?: boolean;
}

export interface UserInputsResult {
	answers: InputAnswer[];
	cancelled: boolean;
	/** Optional free-text notes the user added in the review page's Notes section. */
	note?: string;
	/** Set when the tool could not be presented at all (validation failure, no reachable user). Distinct from a user cancellation. */
	error?: string;
}

/** Raw input as it arrives from the tool schema (options optional/looser). */
export interface RawInput {
	type: InputType;
	title: string;
	id?: string;
	description?: string;
	options?: { title: string; description?: string; value?: string; recommended?: boolean }[];
	optional?: boolean;
	default?: string;
	defaults?: string[];
	pattern?: string;
	patternHint?: string;
	fileKind?: FileKind;
}

interface FileStatCache {
	raw: string;
	abs: string;
	status: "checking" | "ok" | "wrong-kind";
	message?: string;
}

// Per-input mutable UI state.
interface InputState {
	selected: Set<number>; // chosen option indices
	customValue: string; // "Something else" text ("" = none)
	customSelected: boolean;
	textValue: string;
	cursor: number; // highlighted row within this input
	textEdited: boolean;
	selectionEdited: boolean;
	pickerRoot?: TreeNode;
	pickerRows: TreeNode[];
	pickerSelected: number;
	pickerScroll: number;
	pickerLoading: boolean;
	pickerLoadToken: number;
	fileStatToken: number;
	fileStat?: FileStatCache;
}

// What the shared editor/tree picker is currently capturing.
type EditTarget =
	| { kind: "text" | "custom" | "picker"; inputIdx: number }
	| { kind: "notes" }
	| null;

const PICKER_ROW_CAP = 10;
const MAX_ANSWER_CHARS = 16 * 1024;

function isInputType(value: unknown): value is InputType {
	return value === "text" || value === "radio" || value === "multi" || value === "file";
}

function isFileKind(value: unknown): value is FileKind {
	return value === "file" || value === "directory" || value === "any";
}

function optionTitles(options: Option[]): string {
	return options.map((o) => `"${o.title}"`).join(", ");
}

/** Indices of options whose title or value equals `key` (used to resolve — and disambiguate — defaults). */
function matchOptionIndices(options: Option[], key: string): number[] {
	return options.flatMap((o, k) => (o.title === key || o.value === key ? [k] : []));
}

function typedPath(root: string, raw: string): { raw: string; abs: string; rel: string; display: string } {
	const clean = raw.trim().replace(/^@/, "");
	const abs = isAbsolute(clean) ? clean : resolve(root, clean);
	const rel = relative(root, abs).replace(/\\/g, "/");
	const display = rel && !rel.startsWith("..") && rel !== "" ? rel : abs;
	return { raw: clean, abs, rel, display };
}

function fileKindError(fileKind: FileKind, isDirectory: boolean): string | null {
	if (fileKind === "file" && isDirectory) return "Pick a file";
	if (fileKind === "directory" && !isDirectory) return "Pick a directory";
	return null;
}

function defaultSet(set: Set<number> | undefined): Set<number> {
	return new Set(set ?? []);
}

// Allowlists for strict validation — any other key on an input/option is rejected rather
// than silently ignored, so stale fields (e.g. a removed `confirmValue`/`granularity`) surface
// as an error instead of being dropped by normalizeInputs.
const ALLOWED_INPUT_KEYS = new Set([
	"type",
	"title",
	"id",
	"description",
	"options",
	"optional",
	"default",
	"defaults",
	"pattern",
	"patternHint",
	"fileKind",
]);
const ALLOWED_OPTION_KEYS = new Set(["title", "description", "value", "recommended"]);

/** Reject unknown/stale fields on the raw tool payload before it is normalized. */
export function validateRawInputs(raw: unknown): string | null {
	if (!Array.isArray(raw)) return "Error: inputs must be an array.";
	for (const item of raw) {
		if (typeof item !== "object" || item === null) return "Error: each input must be an object.";
		const rec = item as Record<string, unknown>;
		const title = typeof rec.title === "string" && rec.title ? rec.title : "(untitled)";
		for (const key of Object.keys(rec)) {
			if (!ALLOWED_INPUT_KEYS.has(key)) {
				return `Error: input "${title}" has unknown field "${key}". Allowed fields: ${[...ALLOWED_INPUT_KEYS].join(", ")}.`;
			}
		}
		if (rec.options !== undefined) {
			if (!Array.isArray(rec.options)) return `Error: input "${title}" has non-array options.`;
			for (const opt of rec.options) {
				if (typeof opt !== "object" || opt === null) return `Error: input "${title}" has a non-object option.`;
				for (const key of Object.keys(opt as Record<string, unknown>)) {
					if (!ALLOWED_OPTION_KEYS.has(key)) {
						return `Error: input "${title}" has an option with unknown field "${key}". Allowed: ${[...ALLOWED_OPTION_KEYS].join(", ")}.`;
					}
				}
			}
		}
	}
	return null;
}

/** Normalize schema input into the internal shape (options always an array). */
export function normalizeInputs(raw: RawInput[]): Input[] {
	return raw.map((i) => {
		const type = i.type as InputType;
		const fileKindProvided = i.fileKind !== undefined;
		const fileKind = isFileKind(i.fileKind) ? i.fileKind : "any";
		const defaultsProvided = i.defaults !== undefined;
		const defaultProvided = i.default !== undefined;
		const input: Input = {
			type,
			title: i.title.trim(),
			id: i.id?.trim() || undefined,
			description: i.description?.trim() || undefined,
			options: (i.options ?? []).map((o) => ({
				title: o.title.trim(),
				description: o.description?.trim() || undefined,
				value: o.value?.trim() || undefined,
				recommended: o.recommended === true || undefined,
			})),
			optional: i.optional === true,
			default: i.default,
			defaults: i.defaults,
			pattern: i.pattern,
			patternHint: i.patternHint,
			fileKind,
			defaultSelections: new Set<number>(),
			fileKindProvided,
			defaultsProvided,
			defaultProvided,
		};

		if (type === "text") {
			if (i.default !== undefined) input.defaultText = i.default;
		} else if (type === "radio") {
			if (i.default !== undefined) {
				const idxs = matchOptionIndices(input.options, i.default);
				if (idxs.length === 0) {
					input.defaultError = `Error: input "${input.title}" has default "${i.default}", but radio defaults must match an option title or value: ${optionTitles(input.options)}.`;
				} else if (idxs.length > 1) {
					input.defaultError = `Error: input "${input.title}" default "${i.default}" is ambiguous — it matches more than one option by title or value.`;
				} else {
					input.defaultSelections = new Set([idxs[0]]);
				}
			}
		} else if (type === "multi") {
			if (i.defaults !== undefined) {
				const selected = new Set<number>();
				for (const key of i.defaults) {
					const idxs = matchOptionIndices(input.options, key);
					if (idxs.length === 0) {
						input.defaultError = `Error: input "${input.title}" has default selection "${key}", but multi defaults must match an option title or value: ${optionTitles(input.options)}.`;
						break;
					}
					if (idxs.length > 1) {
						input.defaultError = `Error: input "${input.title}" default selection "${key}" is ambiguous — it matches more than one option by title or value.`;
						break;
					}
					selected.add(idxs[0]);
				}
				input.defaultSelections = selected;
			}
		} else if (type === "file") {
			if (i.default !== undefined) input.defaultText = i.default.trim();
		}

		return input;
	});
}

/** Returns an error message if the inputs can't be presented, else null. */
export function validateInputs(inputs: Input[]): string | null {
	if (inputs.length === 0) return "Error: no inputs provided.";
	if (inputs.length > 10) return "Error: at most 10 inputs can be shown in one ask_user panel.";
	for (const input of inputs) {
		if (!input.title.trim()) return "Error: every input must have a non-empty title.";
		if (input.id !== undefined && !input.id.trim()) return `Error: input "${input.title}" has an empty id.`;
		if (!isInputType(input.type)) return `Error: input "${input.title}" has unsupported type "${input.type}".`;
		if (input.options.length > 50) return `Error: input "${input.title}" has more than 50 options.`;
		if ((input.type === "radio" || input.type === "multi") && input.options.length === 0) {
			return `Error: input "${input.title}" is a ${input.type} list but has no options.`;
		}
		if (input.defaultError) return input.defaultError;

		if (input.pattern !== undefined && input.type !== "text") {
			return `Error: input "${input.title}" has pattern, but pattern is only valid for text inputs.`;
		}
		if (input.patternHint !== undefined && input.type !== "text") {
			return `Error: input "${input.title}" has patternHint, but patternHint is only valid for text inputs.`;
		}
		if (input.fileKindProvided && input.type !== "file") {
			return `Error: input "${input.title}" has fileKind, but fileKind is only valid for file inputs.`;
		}
		if (input.defaultsProvided && input.type !== "multi") {
			return `Error: input "${input.title}" has defaults, but defaults is only valid for multi inputs.`;
		}
		if (input.defaultProvided && input.type === "multi") {
			return `Error: input "${input.title}" has default, but multi inputs use defaults instead.`;
		}
		if (input.pattern !== undefined) {
			if (input.pattern.length > 512) return `Error: input "${input.title}" has a pattern longer than 512 characters.`;
			try {
				new RegExp(input.pattern);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return `Error: input "${input.title}" has invalid pattern: ${message}.`;
			}
		}
		if (input.type === "radio" || input.type === "multi") {
			const seenTitles = new Set<string>();
			const seenEffective = new Set<string>();
			for (const opt of input.options) {
				if (!opt.title.trim()) return `Error: input "${input.title}" has an option with an empty title.`;
				if (seenTitles.has(opt.title)) {
					return `Error: input "${input.title}" has duplicate option title "${opt.title}"; option titles must be unique.`;
				}
				seenTitles.add(opt.title);
				// The returned/selected value is `value ?? title`, so those must be distinct across
				// options — otherwise a selection or a default can't be attributed to one option.
				const effective = opt.value ?? opt.title;
				if (seenEffective.has(effective)) {
					return `Error: input "${input.title}" has options whose effective value (value ?? title) collide on "${effective}"; each option must resolve to a distinct value.`;
				}
				seenEffective.add(effective);
			}
		}
	}
	const seenIds = new Set<string>();
	for (const input of inputs) {
		if (input.id === undefined) continue;
		if (seenIds.has(input.id)) {
			return `Error: duplicate input id "${input.id}"; ids must be unique so answers can be correlated.`;
		}
		seenIds.add(input.id);
	}
	return null;
}

/** A readable summary of the answers for the model. */
export function summarizeAnswers(result: UserInputsResult): string {
	if (result.cancelled) return "User cancelled the inputs.";
	const lines = result.answers.map((a) => {
		const label = a.id ? `${a.title} [id: ${a.id}]` : a.title;
		if (a.skipped) return `- ${label}: (skipped — optional input, no answer)`;
		if (a.type === "file") {
			const path = a.path && a.path !== a.text ? ` (absolute path: ${a.path})` : "";
			return `- ${label}: ${a.text}${path}`;
		}
		if (a.type === "text") return `- ${label}: ${a.text}`;
		const picks = (a.selections ?? []).map((s) =>
			s.custom ? `${s.title} (something else)` : s.value !== s.title ? `${s.title} (value: ${s.value})` : s.title,
		);
		const chosen = picks.length ? picks.join(", ") : "(none)";
		return `- ${label}: ${chosen}`;
	});
	const body = `User answered:\n${lines.join("\n")}`;
	return result.note ? `${body}\n\nNotes: ${result.note}` : body;
}

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

		const states: InputState[] = inputs.map((input) => ({
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
		}));

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

		// ----- geometry helpers -----

		function optionRows(idx: number): number {
			return inputs[idx].options.length;
		}
		function somethingElseRow(idx: number): number {
			return optionRows(idx);
		}
		// Rows the input's own content occupies (before the trailing "Next" button).
		// text: 1 (edit). file: 2 (browse, type). radio/multi: options + "Something else".
		function contentRows(idx: number): number {
			const inp = inputs[idx];
			if (inp.type === "text") return 1;
			if (inp.type === "file") return 2;
			return optionRows(idx) + 1;
		}
		// Every input ends with a focusable "Next →" (or "Review →") button row.
		function nextButtonRow(idx: number): number {
			return contentRows(idx);
		}
		function rowCount(idx: number): number {
			return contentRows(idx) + 1;
		}

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
			return hasResponse(idx) && validationError(idx) === null;
		}

		function canSubmit(): boolean {
			return inputs.every((inp, i) => {
				if (inp.optional && !hasResponse(i)) return true;
				return isAnswered(i);
			});
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
				ensurePickerLoaded(target.inputIdx);
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

		// ----- file picker / validation helpers -----

		function rebuildPickerRows(idx: number) {
			const s = states[idx];
			s.pickerRows = s.pickerRoot ? flatten(s.pickerRoot) : [];
			const max = Math.max(0, s.pickerRows.length - 1);
			s.pickerSelected = Math.max(0, Math.min(max, s.pickerSelected));
			if (s.pickerSelected < s.pickerScroll) s.pickerScroll = s.pickerSelected;
			if (s.pickerSelected >= s.pickerScroll + PICKER_ROW_CAP) {
				s.pickerScroll = s.pickerSelected - PICKER_ROW_CAP + 1;
			}
			s.pickerScroll = Math.max(0, Math.min(Math.max(0, s.pickerRows.length - PICKER_ROW_CAP), s.pickerScroll));
		}

		function ensurePickerLoaded(idx: number) {
			const s = states[idx];
			if (!s.pickerRoot) {
				s.pickerRoot = createRoot(rootDir);
				rebuildPickerRows(idx);
			}
			if (s.pickerRoot.loaded || s.pickerLoading) return;
			const token = ++s.pickerLoadToken;
			s.pickerLoading = true;
			void loadChildren(rootDir, s.pickerRoot).then(() => {
				if (token !== s.pickerLoadToken) return;
				s.pickerLoading = false;
				rebuildPickerRows(idx);
				refresh();
			});
		}

		function selectedPickerNode(idx: number): TreeNode | undefined {
			const s = states[idx];
			return s.pickerRows[s.pickerSelected];
		}

		function movePicker(idx: number, delta: number) {
			const s = states[idx];
			const max = Math.max(0, s.pickerRows.length - 1);
			s.pickerSelected = Math.max(0, Math.min(max, s.pickerSelected + delta));
			if (s.pickerSelected < s.pickerScroll) s.pickerScroll = s.pickerSelected;
			if (s.pickerSelected >= s.pickerScroll + PICKER_ROW_CAP) {
				s.pickerScroll = s.pickerSelected - PICKER_ROW_CAP + 1;
			}
			refresh();
		}

		function pickNode(idx: number, node: TreeNode) {
			const s = states[idx];
			s.textValue = node.rel || node.abs;
			s.textEdited = true;
			s.fileStat = undefined;
			void checkFilePath(idx);
			closeEditor();
		}

		async function expandPickerNode(idx: number, node: TreeNode) {
			if (!node.isDir) return;
			if (!node.loaded) {
				const s = states[idx];
				const token = ++s.pickerLoadToken;
				s.pickerLoading = true;
				refresh();
				await loadChildren(rootDir, node);
				if (token !== s.pickerLoadToken) return;
				s.pickerLoading = false;
			}
			node.expanded = true;
			rebuildPickerRows(idx);
			refresh();
		}

		function collapseOrParentPickerNode(idx: number, node: TreeNode) {
			const s = states[idx];
			if (node.isDir && node.expanded) {
				node.expanded = false;
				rebuildPickerRows(idx);
				refresh();
				return;
			}
			if (node.parent) {
				const parentIdx = s.pickerRows.indexOf(node.parent);
				if (parentIdx >= 0) {
					s.pickerSelected = parentIdx;
					rebuildPickerRows(idx);
					refresh();
				}
			}
		}

		function handlePickerInput(data: string, idx: number): boolean {
			ensurePickerLoaded(idx);
			if (matchesKey(data, Key.escape)) {
				closeEditor();
				return true;
			}
			if (matchesKey(data, Key.up)) {
				movePicker(idx, -1);
				return true;
			}
			if (matchesKey(data, Key.down)) {
				movePicker(idx, 1);
				return true;
			}
			const node = selectedPickerNode(idx);
			if (!node) return true;
			if (matchesKey(data, Key.right)) {
				void expandPickerNode(idx, node);
				return true;
			}
			if (matchesKey(data, Key.left)) {
				collapseOrParentPickerNode(idx, node);
				return true;
			}
			if (matchesKey(data, Key.enter)) {
				pickNode(idx, node);
				return true;
			}
			return true;
		}

		function checkFilePath(idx: number): FileStatCache | undefined {
			const inp = inputs[idx];
			const s = states[idx];
			if (inp.type !== "file") return undefined;
			const raw = s.textValue.trim();
			if (!raw) return undefined;
			if (s.fileStat?.raw === raw) return s.fileStat;
			const pathInfo = typedPath(rootDir, raw);
			const token = ++s.fileStatToken;
			s.fileStat = { raw, abs: pathInfo.abs, status: "checking" };
			void stat(pathInfo.abs).then(
				(info) => {
					if (token !== s.fileStatToken) return;
					const kindError = fileKindError(inp.fileKind, info.isDirectory());
					s.fileStat = kindError
						? { raw, abs: pathInfo.abs, status: "wrong-kind", message: kindError }
						: { raw, abs: pathInfo.abs, status: "ok" };
					refresh();
				},
				() => {
					if (token !== s.fileStatToken) return;
					// Nonexistent paths are valid: callers may be asking where to create
					// a new file or directory. fileKind is enforced only when the path
					// already exists and its kind can be inspected.
					s.fileStat = { raw, abs: pathInfo.abs, status: "ok" };
					refresh();
				},
			);
			return s.fileStat;
		}

		function validationError(idx: number): string | null {
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
				const cache = checkFilePath(idx);
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
			if (s.cursor === nextButtonRow(idx)) {
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
				s.selectionEdited = true;
				refresh();
				return;
			}
			if (row === somethingElseRow(idx)) {
				// If a custom value already exists, a bare toggle is more useful than reopening the editor.
				if (s.customValue) {
					s.customSelected = !s.customSelected;
					s.selectionEdited = true;
					if (s.customSelected && inp.type === "radio") s.selected.clear();
					refresh();
				} else {
					openEditor({ kind: "custom", inputIdx: idx });
				}
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
				if (matchesKey(data, Key.up)) {
					submitCursor = Math.max(0, submitCursor - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					submitCursor = Math.min(1, submitCursor + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
					if (submitCursor === 0) {
						openEditor({ kind: "notes" });
					} else if (canSubmit()) {
						done({ answers: collectAnswers(), cancelled: false, note: notes || undefined });
					}
					return;
				}
				if (matchesKey(data, Key.escape)) {
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
			return inputs.map((inp, idx): InputAnswer => {
				const s = states[idx];
				let answer: InputAnswer;
				if (inp.optional && !hasResponse(idx)) {
					answer = { type: inp.type, title: inp.title, skipped: true };
				} else if (inp.type === "text") {
					answer = { type: inp.type, title: inp.title, text: s.textValue || "(no response)" };
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

		// ----- rendering -----

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
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
				const invalid = hasResponse(i) && validationError(i) !== null;
				const box = valid ? "■" : skippedOptional ? "◌" : "□";
				const color = valid ? "success" : skippedOptional ? "dim" : invalid ? "warning" : "muted";
				const label = ` ${box} ${inputs[i].title} `;
				tabs.push(`${active ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(color, label)} `);
			}
			const submitText = " ✓ Submit ";
			tabs.push(
				`${
					currentTab === submitTab
						? theme.bg("selectedBg", theme.fg("text", submitText))
						: theme.fg(canSubmit() ? "success" : "dim", submitText)
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
					? "↑↓ move · →/← expand/collapse · Enter pick · Esc close"
					: "Enter to save • Esc to go back"
				: currentTab === submitTab
					? "↑↓ move • Enter choose • Tab/←→ switch • Esc cancel"
					: "↑↓ move • Space/Enter choose • Tab/←→ switch • Esc cancel";
			addWrappedWithPrefix(" ", theme.fg("dim", help));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			const terminalRows = Math.max(5, tui.terminal.rows);
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

			cachedWidth = width;
			cachedLines = fitted;
			return fitted;

			// --- nested renderers (capture addWrappedWithPrefix / lines) ---

			function typeTag(inp: Input): string {
				if (inp.type === "text") return "text";
				if (inp.type === "radio") return "pick one";
				if (inp.type === "multi") return "pick any";
				if (inp.type === "file") return inp.fileKind === "any" ? "path" : inp.fileKind;
				return inp.type;
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
							add(editPrefix, theme.fg(editColor, "Edit ✎"));
						} else {
							add(editPrefix, theme.fg(editColor, "Type your answer ✎"));
						}
					}
					renderInlineError(idx, add);
					// Keep Edit and Next/Review adjacent (no gap) so they read as a switchable pair.
					renderNextButton(idx, add, false);
					return;
				}

				if (inp.type === "file") {
					renderFileInput(idx, rw, add);
					renderInlineError(idx, add);
					renderNextButton(idx, add);
					return;
				}

				// List options (radio / multi).
				for (let i = 0; i < inp.options.length; i++) {
					const opt = inp.options[i];
					const cursor = s.cursor === i;
					const chosen = s.selected.has(i);
					const mark = inp.type === "multi" ? (chosen ? "[x]" : "[ ]") : chosen ? "(●)" : "( )";
					const prefix = cursor ? theme.fg("accent", "> ") : "  ";
					const color = cursor ? "accent" : "text";
					const suffix = optionSuffix(!s.selectionEdited && !!inp.defaultSelections?.has(i), opt.recommended === true);
					add(prefix, `${theme.fg(chosen ? "success" : "dim", mark)} ${theme.fg(color, opt.title)}${suffix}`);
					if (opt.description) add("       ", theme.fg("muted", opt.description));
				}

				// "Something else" row.
				{
					const rowIdx = somethingElseRow(idx);
					const cursor = s.cursor === rowIdx;
					const chosen = s.customSelected;
					const mark = inp.type === "multi" ? (chosen ? "[x]" : "[ ]") : chosen ? "(●)" : "( )";
					const prefix = cursor ? theme.fg("accent", "> ") : "  ";
					const label = s.customValue ? `Something else: ${s.customValue}` : "Something else…";
					add(prefix, `${theme.fg(chosen ? "success" : "dim", mark)} ${theme.fg(cursor ? "accent" : "text", label)}`);
					if (editing && editing.kind === "custom" && editing.inputIdx === idx) {
						add("   ", theme.fg("muted", "Type your answer:"));
						for (const line of editor.render(Math.max(1, rw - 4))) lines.push(`   ${line}`);
					}
				}

				renderInlineError(idx, add);
				renderNextButton(idx, add);
			}

			function renderFileInput(idx: number, rw: number, add: (prefix: string, text: string) => void) {
				const s = states[idx];
				const pickerOpen = editing?.kind === "picker" && editing.inputIdx === idx;
				const browsePrefix = s.cursor === 0 || pickerOpen ? theme.fg("accent", "> ") : "  ";
				add(browsePrefix, theme.fg(pickerOpen || s.cursor === 0 ? "accent" : "text", `${pickerOpen ? "▾" : "▸"} Browse…`));
				if (pickerOpen) renderPicker(idx, rw, add);

				const typePrefix = s.cursor === 1 ? theme.fg("accent", "> ") : "  ";
				const typeLabel = s.textValue ? "✎ Path" : "✎ Type a path…";
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

			function renderInlineError(idx: number, add: (prefix: string, text: string) => void) {
				const err = validationError(idx);
				if (err) {
					lines.push("");
					add(" ", theme.fg("warning", `✗ ${err}`));
				}
			}

			function renderNextButton(idx: number, add: (prefix: string, text: string) => void, spaced = true) {
				const cursor = states[idx].cursor === nextButtonRow(idx);
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
				const noteLabel = notes ? "Notes ✎" : "Add notes… ✎";
				add(notePrefix, theme.fg(noteCursor ? "accent" : "dim", noteLabel));
				if (notes && !(editing && editing.kind === "notes")) {
					add("     ", theme.fg("muted", notes));
				}
				if (editing && editing.kind === "notes") {
					add("   ", theme.fg("muted", "Your notes:"));
					for (const line of editor.render(Math.max(1, renderWidth - 4))) lines.push(`   ${line}`);
				}
				lines.push("");

				// Submit button (submitCursor row 1).
				const submitFocused = submitCursor === 1;
				const canGo = canSubmit();
				const submitPrefix = submitFocused ? theme.fg("accent", "> ") : "  ";
				const submitColor = submitFocused ? "accent" : canGo ? "success" : "dim";
				add(submitPrefix, theme.fg(submitColor, "Submit ✓"));

				if (!canGo) {
					const missing = inputs
						.filter((inp, i) => !(inp.optional && !hasResponse(i)) && !hasResponse(i))
						.map((inp) => inp.title);
					const fixes = inputs.filter((_, i) => hasResponse(i) && validationError(i) !== null).map((inp) => inp.title);
					if (missing.length > 0) add(" ", theme.fg("warning", `Still unanswered: ${missing.join(", ")}`));
					if (fixes.length > 0) add(" ", theme.fg("warning", `Fix: ${fixes.join(", ")}`));
				}
			}
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
