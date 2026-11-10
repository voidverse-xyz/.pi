/**
 * The pure schema layer of the ask_user tool: input/answer types, raw-payload
 * validation, normalization, and the model-facing answer summary. Side-effect
 * free — the interactive TUI panel lives in ask.ts.
 */

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
