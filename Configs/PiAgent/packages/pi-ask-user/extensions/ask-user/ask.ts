/**
 * The ask-user ask flow, factored out of index.ts so it can run in two places:
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

export type InputType = "text" | "radio" | "multi" | "number" | "boolean" | "datetime" | "file";
export type DateTimeGranularity = "date" | "time" | "datetime";
export type FileKind = "file" | "directory" | "any";

export interface Option {
	title: string;
	description?: string;
}

export interface Input {
	type: InputType;
	title: string;
	description?: string;
	options: Option[];
	optional?: boolean;
	default?: string;
	defaults?: string[];
	pattern?: string;
	patternHint?: string;
	minSelections?: number;
	maxSelections?: number;
	min?: number;
	max?: number;
	confirmValue?: string;
	granularity: DateTimeGranularity;
	fileKind: FileKind;
	defaultText?: string;
	defaultSelections?: Set<number>;
	noCustom?: boolean;
	defaultError?: string;
	defaultProvided?: boolean;
	defaultsProvided?: boolean;
	granularityProvided?: boolean;
	fileKindProvided?: boolean;
}

export interface InputAnswer {
	type: InputType;
	title: string;
	/** Present for text-like inputs and human-readable list/boolean/file answers. */
	text?: string;
	/** Present for "radio"/"multi" inputs. `custom` flags the "Something else" answer. */
	selections?: { title: string; custom: boolean }[];
	/** Optional free-text note attached to list-like inputs. */
	note?: string;
	/** Typed value for number/boolean inputs. */
	value?: number | boolean;
	/** Absolute path for file inputs. */
	path?: string;
	/** True when an optional input was intentionally left unanswered. */
	skipped?: boolean;
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
	optional?: boolean;
	default?: string;
	defaults?: string[];
	pattern?: string;
	patternHint?: string;
	minSelections?: number;
	maxSelections?: number;
	min?: number;
	max?: number;
	confirmValue?: string;
	granularity?: DateTimeGranularity;
	fileKind?: FileKind;
}

interface FileStatCache {
	raw: string;
	abs: string;
	status: "checking" | "ok" | "missing" | "wrong-kind";
	message?: string;
}

// Per-input mutable UI state.
interface InputState {
	selected: Set<number>; // chosen option indices
	customValue: string; // "Something else" text ("" = none)
	customSelected: boolean;
	note: string;
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
type EditTarget = { kind: "text" | "custom" | "note" | "picker"; inputIdx: number } | null;

const PICKER_ROW_CAP = 10;

function isInputType(value: unknown): value is InputType {
	return (
		value === "text" ||
		value === "radio" ||
		value === "multi" ||
		value === "number" ||
		value === "boolean" ||
		value === "datetime" ||
		value === "file"
	);
}

function isGranularity(value: unknown): value is DateTimeGranularity {
	return value === "date" || value === "time" || value === "datetime";
}

function isFileKind(value: unknown): value is FileKind {
	return value === "file" || value === "directory" || value === "any";
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function formatNow(granularity: DateTimeGranularity): string {
	const d = new Date();
	const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
	const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	if (granularity === "date") return date;
	if (granularity === "time") return time;
	return `${date} ${time}`;
}

function daysInMonth(year: number, month: number): number {
	return new Date(year, month, 0).getDate();
}

function validDateParts(year: number, month: number, day: number): boolean {
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function normalizeDateTimeText(value: string, granularity: DateTimeGranularity): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.toLowerCase() === "now") return formatNow(granularity);

	if (granularity === "date") {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
		if (!m) return null;
		const year = Number(m[1]);
		const month = Number(m[2]);
		const day = Number(m[3]);
		if (!validDateParts(year, month, day)) return null;
		return `${m[1]}-${m[2]}-${m[3]}`;
	}

	if (granularity === "time") {
		const m = /^(\d{2}):(\d{2})$/.exec(trimmed);
		if (!m) return null;
		const hour = Number(m[1]);
		const minute = Number(m[2]);
		if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
		return `${m[1]}:${m[2]}`;
	}

	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(
		trimmed,
	);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	if (!validDateParts(year, month, day) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	if (Number.isNaN(Date.parse(trimmed.replace(" ", "T")))) return null;
	return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

function datetimeHint(granularity: DateTimeGranularity): string {
	if (granularity === "date") return "Use format YYYY-MM-DD";
	if (granularity === "time") return "Use format HH:MM";
	return "Use format YYYY-MM-DD HH:MM";
}

function parseBooleanDefault(value: string): boolean | null {
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return null;
}

function optionTitles(options: Option[]): string {
	return options.map((o) => `"${o.title}"`).join(", ");
}

function rangeLabel(min: number | undefined, max: number | undefined): string {
	if (min !== undefined && max !== undefined) return `${min}–${max}`;
	if (min !== undefined) return `≥ ${min}`;
	if (max !== undefined) return `≤ ${max}`;
	return "";
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

/** Normalize schema input into the internal shape (options always an array). */
export function normalizeInputs(raw: RawInput[]): Input[] {
	return raw.map((i) => {
		const type = (isInputType(i.type) ? i.type : i.type) as InputType;
		const granularityProvided = i.granularity !== undefined;
		const fileKindProvided = i.fileKind !== undefined;
		const granularity = isGranularity(i.granularity) ? i.granularity : "datetime";
		const fileKind = isFileKind(i.fileKind) ? i.fileKind : "any";
		const defaultsProvided = i.defaults !== undefined;
		const defaultProvided = i.default !== undefined;
		const input: Input = {
			type,
			title: i.title,
			description: i.description,
			options: (i.options ?? []).map((o) => ({ title: o.title, description: o.description })),
			optional: i.optional === true,
			default: i.default,
			defaults: i.defaults,
			pattern: i.pattern,
			patternHint: i.patternHint,
			minSelections: i.minSelections,
			maxSelections: i.maxSelections,
			min: i.min,
			max: i.max,
			confirmValue: i.confirmValue,
			granularity,
			fileKind,
			defaultSelections: new Set<number>(),
			granularityProvided,
			fileKindProvided,
			defaultsProvided,
			defaultProvided,
		};

		if (type === "boolean") {
			input.options = [{ title: "Yes" }, { title: "No" }];
			input.noCustom = true;
		}

		if (type === "text") {
			// Confirmation fields intentionally ignore defaults: zero-keystroke confirmation
			// should not be possible.
			if (i.default !== undefined && input.confirmValue === undefined) input.defaultText = i.default;
		} else if (type === "radio") {
			if (i.default !== undefined) {
				const idx = input.options.findIndex((o) => o.title === i.default);
				if (idx === -1) {
					input.defaultError = `Error: input "${input.title}" has default "${i.default}", but radio defaults must match one of: ${optionTitles(input.options)}.`;
				} else {
					input.defaultSelections = new Set([idx]);
				}
			}
		} else if (type === "multi") {
			if (i.defaults !== undefined) {
				const selected = new Set<number>();
				for (const title of i.defaults) {
					const idx = input.options.findIndex((o) => o.title === title);
					if (idx === -1) {
						input.defaultError = `Error: input "${input.title}" has default selection "${title}", but multi defaults must match option titles: ${optionTitles(input.options)}.`;
						break;
					}
					selected.add(idx);
				}
				input.defaultSelections = selected;
			}
		} else if (type === "number") {
			if (i.default !== undefined) {
				const n = Number(i.default.trim());
				if (!Number.isFinite(n)) {
					input.defaultError = `Error: input "${input.title}" has default "${i.default}", but number defaults must be numeric.`;
				} else {
					input.defaultText = i.default.trim();
				}
			}
		} else if (type === "boolean") {
			if (i.default !== undefined) {
				const b = parseBooleanDefault(i.default);
				if (b === null) {
					input.defaultError = `Error: input "${input.title}" has default "${i.default}", but boolean defaults must be "true" or "false".`;
				} else {
					input.defaultSelections = new Set([b ? 0 : 1]);
				}
			}
		} else if (type === "datetime") {
			if (i.default !== undefined) {
				const normalized = normalizeDateTimeText(i.default, granularity);
				if (!normalized) {
					input.defaultError = `Error: input "${input.title}" has default "${i.default}", but datetime defaults must use ${datetimeHint(granularity).replace("Use format ", "")} or "now".`;
				} else {
					input.defaultText = normalized;
				}
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
	for (const input of inputs) {
		if (!isInputType(input.type)) return `Error: input "${input.title}" has unsupported type "${input.type}".`;
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
		if (input.confirmValue !== undefined && input.type !== "text") {
			return `Error: input "${input.title}" has confirmValue, but confirmValue is only valid for text inputs.`;
		}
		if ((input.min !== undefined || input.max !== undefined) && input.type !== "number") {
			return `Error: input "${input.title}" has min/max, but min/max are only valid for number inputs.`;
		}
		if ((input.minSelections !== undefined || input.maxSelections !== undefined) && input.type !== "multi") {
			return `Error: input "${input.title}" has minSelections/maxSelections, but those are only valid for multi inputs.`;
		}
		if (input.granularityProvided && input.type !== "datetime") {
			return `Error: input "${input.title}" has granularity, but granularity is only valid for datetime inputs.`;
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
			try {
				new RegExp(input.pattern);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return `Error: input "${input.title}" has invalid pattern: ${message}.`;
			}
		}
		if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
			return `Error: input "${input.title}" has min greater than max.`;
		}
		if (
			input.minSelections !== undefined &&
			input.maxSelections !== undefined &&
			input.minSelections > input.maxSelections
		) {
			return `Error: input "${input.title}" has minSelections greater than maxSelections.`;
		}
		if (input.minSelections !== undefined && input.minSelections > input.options.length + 1) {
			return `Error: input "${input.title}" requires at least ${input.minSelections} selections, but only ${input.options.length + 1} choices are available.`;
		}
		if (input.minSelections !== undefined && input.minSelections < 0) {
			return `Error: input "${input.title}" has negative minSelections.`;
		}
		if (input.maxSelections !== undefined && input.maxSelections < 0) {
			return `Error: input "${input.title}" has negative maxSelections.`;
		}
		if (input.optional && input.confirmValue !== undefined) {
			return `Error: input "${input.title}" cannot be optional and use confirmValue; confirmation fields must be required.`;
		}
		if (input.optional && input.minSelections !== undefined) {
			return `Error: input "${input.title}" cannot be optional and use minSelections; make it required or remove minSelections.`;
		}
	}
	return null;
}

/** A readable summary of the answers for the model. */
export function summarizeAnswers(result: UserInputsResult): string {
	if (result.cancelled) return "User cancelled the inputs.";
	const lines = result.answers.map((a) => {
		if (a.skipped) return `- ${a.title}: (skipped — optional input, no answer)`;
		if (a.type === "number") return `- ${a.title}: ${a.text}${typeof a.value === "number" ? ` (value: ${a.value})` : ""}`;
		if (a.type === "boolean") {
			const note = a.note ? ` [note: ${a.note}]` : "";
			return `- ${a.title}: ${a.text}${typeof a.value === "boolean" ? ` (value: ${a.value})` : ""}${note}`;
		}
		if (a.type === "datetime") return `- ${a.title}: ${a.text}`;
		if (a.type === "file") {
			const path = a.path && a.path !== a.text ? ` (absolute path: ${a.path})` : "";
			const note = a.note ? ` [note: ${a.note}]` : "";
			return `- ${a.title}: ${a.text}${path}${note}`;
		}
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
export function showUserInputs(
	ctx: ExtensionContext,
	inputs: Input[],
	from: string[],
	rootDir = ctx.cwd,
): Promise<UserInputsResult> {
	return ctx.ui.custom<UserInputsResult>((tui, theme, _kb, done) => {
		const totalTabs = inputs.length + 1; // inputs + Submit
		const submitTab = inputs.length;
		let currentTab = 0;
		let cachedLines: string[] | undefined;
		let editing: EditTarget = null;

		const states: InputState[] = inputs.map((input) => ({
			selected: defaultSet(input.defaultSelections),
			customValue: "",
			customSelected: false,
			note: "",
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
			return inputs[idx].noCustom ? -1 : optionRows(idx);
		}
		function noteRow(idx: number): number {
			const inp = inputs[idx];
			if (inp.type === "file") return 2;
			return inp.noCustom ? optionRows(idx) : optionRows(idx) + 1;
		}
		function rowCount(idx: number): number {
			const inp = inputs[idx];
			if (inp.type === "text" || inp.type === "number" || inp.type === "datetime") return 1;
			if (inp.type === "file") return 3;
			return optionRows(idx) + (inp.noCustom ? 1 : 2);
		}

		function selectionCount(idx: number): number {
			const s = states[idx];
			return s.selected.size + (s.customSelected && s.customValue ? 1 : 0);
		}

		function hasResponse(idx: number): boolean {
			const inp = inputs[idx];
			const s = states[idx];
			if (inp.type === "text" || inp.type === "number" || inp.type === "datetime" || inp.type === "file") {
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
			cachedLines = undefined;
			tui.requestRender();
		}

		// ----- editing -----

		function openEditor(target: Exclude<EditTarget, null>) {
			editing = target;
			const s = states[target.inputIdx];
			if (target.kind === "picker") {
				ensurePickerLoaded(target.inputIdx);
				refresh();
				return;
			}
			editor.setText(target.kind === "text" ? s.textValue : target.kind === "custom" ? s.customValue : s.note);
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
			const s = states[editing.inputIdx];
			if (editing.kind === "text") {
				s.textValue = trimmed;
				s.textEdited = true;
				s.fileStat = undefined;
				if (inputs[editing.inputIdx].type === "datetime") {
					const normalized = normalizeDateTimeText(trimmed, inputs[editing.inputIdx].granularity);
					if (normalized) s.textValue = normalized;
				}
			} else if (editing.kind === "note") {
				s.note = trimmed;
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
					s.fileStat = { raw, abs: pathInfo.abs, status: "missing", message: "Path does not exist" };
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
				if (inp.confirmValue !== undefined && text !== inp.confirmValue) return `Type exactly: ${inp.confirmValue}`;
				const pattern = compiledPatterns[idx];
				if (pattern && !pattern.test(text)) return inp.patternHint ?? `Must match: ${inp.pattern}`;
				return null;
			}

			if (inp.type === "multi") {
				const picks = selectionCount(idx);
				if (inp.minSelections !== undefined && picks < inp.minSelections) return `Pick at least ${inp.minSelections}`;
				if (inp.maxSelections !== undefined && picks > inp.maxSelections) return `Pick at most ${inp.maxSelections}`;
				return null;
			}

			if (inp.type === "number") {
				const n = Number(s.textValue.trim());
				if (!Number.isFinite(n)) return "Enter a number";
				if (inp.min !== undefined && n < inp.min) return `Must be ≥ ${inp.min}`;
				if (inp.max !== undefined && n > inp.max) return `Must be ≤ ${inp.max}`;
				return null;
			}

			if (inp.type === "datetime") {
				return normalizeDateTimeText(s.textValue, inp.granularity) ? null : datetimeHint(inp.granularity);
			}

			if (inp.type === "file") {
				const cache = checkFilePath(idx);
				if (!cache || cache.status === "checking") return "Checking path…";
				if (cache.status === "missing") return cache.message ?? "Path does not exist";
				if (cache.status === "wrong-kind") return cache.message ?? "Pick a file/directory";
				return null;
			}

			return null;
		}

		// ----- activation of a highlighted row -----

		function activateRow(idx: number) {
			const inp = inputs[idx];
			const s = states[idx];
			if (inp.type === "text" || inp.type === "number" || inp.type === "datetime") {
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
					return;
				}
				if (s.cursor === noteRow(idx)) openEditor({ kind: "note", inputIdx: idx });
				return;
			}

			const row = s.cursor;
			if (row < optionRows(idx)) {
				if (inp.type === "radio" || inp.type === "boolean") {
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
				return;
			}
			if (row === noteRow(idx)) {
				openEditor({ kind: "note", inputIdx: idx });
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

			// Submit tab.
			if (currentTab === submitTab) {
				if (matchesKey(data, Key.enter) && canSubmit()) {
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
				if (inp.optional && !hasResponse(idx)) {
					return { type: inp.type, title: inp.title, skipped: true };
				}
				if (inp.type === "text") {
					return { type: inp.type, title: inp.title, text: s.textValue || "(no response)" };
				}
				if (inp.type === "number") {
					const n = Number(s.textValue.trim());
					return { type: inp.type, title: inp.title, text: s.textValue, value: n };
				}
				if (inp.type === "datetime") {
					const normalized = normalizeDateTimeText(s.textValue, inp.granularity) ?? s.textValue;
					return { type: inp.type, title: inp.title, text: normalized };
				}
				if (inp.type === "file") {
					const pathInfo = typedPath(rootDir, s.textValue);
					const answer: InputAnswer = {
						type: inp.type,
						title: inp.title,
						text: pathInfo.display,
						path: pathInfo.abs,
					};
					if (s.note) answer.note = s.note;
					return answer;
				}
				if (inp.type === "boolean") {
					const picked = s.selected.has(0);
					const answer: InputAnswer = {
						type: inp.type,
						title: inp.title,
						text: picked ? "Yes" : "No",
						value: picked,
					};
					if (s.note) answer.note = s.note;
					return answer;
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
				addWrappedWithPrefix(" ", theme.fg("warning", from.join(" → ")) + theme.fg("dim", " is asking:"));
				lines.push("");
			}

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

			if (currentTab === submitTab) {
				renderSubmit(addWrappedWithPrefix);
			} else {
				renderInput(currentTab, renderWidth, addWrappedWithPrefix);
			}

			lines.push("");
			const help = editing
				? editing.kind === "picker"
					? "↑↓ move · →/← expand/collapse · Enter pick · Esc close"
					: "Enter to save • Esc to go back"
				: currentTab === submitTab
					? "Tab/←→ switch • Enter submit • Esc cancel"
					: "↑↓ move • Space/Enter choose • Tab/←→ switch • Esc cancel";
			addWrappedWithPrefix(" ", theme.fg("dim", help));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;

			// --- nested renderers (capture addWrappedWithPrefix / lines) ---

			function typeTag(inp: Input): string {
				if (inp.type === "text") return "text";
				if (inp.type === "radio") return "pick one";
				if (inp.type === "multi") {
					const parts: string[] = ["pick any"];
					if (inp.minSelections !== undefined) parts.push(`min ${inp.minSelections}`);
					if (inp.maxSelections !== undefined) parts.push(`max ${inp.maxSelections}`);
					return parts.join(", ");
				}
				if (inp.type === "number") {
					const r = rangeLabel(inp.min, inp.max);
					return r ? `number, ${r}` : "number";
				}
				if (inp.type === "boolean") return "yes/no";
				if (inp.type === "datetime") return `${inp.granularity}, ${datetimeHint(inp.granularity).replace("Use format ", "")}`;
				if (inp.type === "file") return inp.fileKind === "any" ? "path" : inp.fileKind;
				return inp.type;
			}

			function defaultSuffix(show: boolean): string {
				return show ? theme.fg("dim", " (default)") : "";
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

				if (inp.type === "text" || inp.type === "number" || inp.type === "datetime") {
					if (editing && editing.kind === "text" && editing.inputIdx === idx) {
						add(" ", theme.fg("muted", inp.type === "text" ? "Your answer:" : "Value:"));
						for (const line of editor.render(Math.max(1, rw - 2))) lines.push(` ${line}`);
					} else {
						const prefix = theme.fg("accent", "> ");
						const action = s.textValue ? "✎ Edit value" : "✎ Type your answer";
						add(prefix, theme.fg("accent", action));
						if (s.textValue) add("     ", theme.fg("text", s.textValue) + defaultSuffix(!s.textEdited && !!inp.defaultText));
					}
					renderInlineError(idx, add);
					return;
				}

				if (inp.type === "file") {
					renderFileInput(idx, rw, add);
					renderInlineError(idx, add);
					return;
				}

				// List/boolean options.
				for (let i = 0; i < inp.options.length; i++) {
					const opt = inp.options[i];
					const cursor = s.cursor === i;
					const chosen = s.selected.has(i);
					const mark = inp.type === "multi" ? (chosen ? "[x]" : "[ ]") : chosen ? "(●)" : "( )";
					const prefix = cursor ? theme.fg("accent", "> ") : "  ";
					const color = cursor ? "accent" : "text";
					const suffix = defaultSuffix(!s.selectionEdited && !!inp.defaultSelections?.has(i));
					add(prefix, `${theme.fg(chosen ? "success" : "dim", mark)} ${theme.fg(color, opt.title)}${suffix}`);
					if (opt.description) add("       ", theme.fg("muted", opt.description));
				}

				// "Something else" row.
				if (!inp.noCustom) {
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

				// "Add a note" row — padded from the choices above it.
				lines.push("");
				renderNoteRow(idx, rw, add);
				renderInlineError(idx, add);
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
					add("     ", theme.fg("text", s.textValue) + defaultSuffix(!s.textEdited && !!inputs[idx].defaultText));
				}

				lines.push("");
				renderNoteRow(idx, rw, add);
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

			function renderNoteRow(idx: number, rw: number, add: (prefix: string, text: string) => void) {
				const s = states[idx];
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

			function renderInlineError(idx: number, add: (prefix: string, text: string) => void) {
				const err = validationError(idx);
				if (err) {
					lines.push("");
					add(" ", theme.fg("warning", `✗ ${err}`));
				}
			}

			function answerPreview(idx: number): string {
				const inp = inputs[idx];
				const s = states[idx];
				if (inp.optional && !hasResponse(idx)) return theme.fg("dim", "(skipped — optional)");
				if (inp.type === "text" || inp.type === "number" || inp.type === "datetime" || inp.type === "file") {
					return s.textValue || theme.fg("warning", "(unanswered)");
				}
				if (inp.type === "boolean") {
					if (s.selected.has(0)) return "Yes";
					if (s.selected.has(1)) return "No";
					return theme.fg("warning", "(unanswered)");
				}
				const picks: string[] = [];
				for (let j = 0; j < inp.options.length; j++) {
					if (s.selected.has(j)) picks.push(inp.options[j].title);
				}
				if (s.customSelected && s.customValue) picks.push(`${s.customValue} (else)`);
				let value = picks.length ? picks.join(", ") : theme.fg("warning", "(unanswered)");
				if (s.note) value += theme.fg("dim", `  — note: ${s.note}`);
				return value;
			}

			function renderSubmit(add: (prefix: string, text: string) => void) {
				add(" ", theme.fg("accent", theme.bold("Review & submit")));
				lines.push("");
				for (let i = 0; i < inputs.length; i++) {
					const inp = inputs[i];
					add(" ", `${theme.fg("muted", `${inp.title}: `)}${theme.fg("text", answerPreview(i))}`);
				}
				lines.push("");
				if (canSubmit()) {
					add(" ", theme.fg("success", "Press Enter to submit"));
				} else {
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
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}
