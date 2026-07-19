/**
 * Ask User — an LLM-callable tool for asking the user structured questions.
 *
 * Registered via pi.registerTool as `ask_user`, so the *agent* invokes it
 * whenever it has a question or wants to ask the user something, and the user
 * answers inside a native Pi TUI panel. (This has to be a tool, not a skill or a
 * plain slash command: a skill is only markdown instructions, and a command can't
 * be called by the model mid-turn. Modeled on the bundled `question.ts` /
 * `questionnaire.ts` examples.)
 *
 * One call can bundle several inputs, each of these types:
 *   - "text"  — a free-text answer.
 *   - "radio" — pick exactly one of a list of options.
 *   - "multi" — pick any number of a list of options.
 *   - "file"  — pick or type a file/directory path.
 *
 * The panel UI, normalization, and answer summary live in ask.ts. The tool requires
 * the interactive TUI; headless agents receive a clear tool error and must proceed
 * with reasonable assumptions instead of depending on the archived IPC transport.
 *
 * Install as a package: packages/pi-questions/extensions/questions/index.ts
 * Reload: /reload
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { showUserInputs } from "./ask.ts";
import { ICON_EDIT } from "./icons.ts";
import {
	type Input,
	normalizeInputs,
	type RawInput,
	summarizeAnswers,
	type UserInputsResult,
	validateInputs,
	validateRawInputs,
} from "./schema.ts";

// Result-renderer-only glyphs; these intentionally differ from the panel's
// tab icons in icons.ts (see the note there).
const ICON_SKIPPED = ""; // nf-fa-circle_o
const ICON_SUCCESS = ""; // nf-fa-check_circle

// ---------------------------------------------------------------------------
// Schema — what the agent fills in.
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	title: Type.String({ description: "Short label for this option" }),
	description: Type.Optional(Type.String({ description: "Optional detail shown beneath the option" })),
	value: Type.Optional(
		Type.String({ description: "Optional stable value returned when this option is selected, instead of its display title." }),
	),
	recommended: Type.Optional(
		Type.Boolean({ description: "If true, visually marks this option as recommended without selecting it." }),
	),
}, { additionalProperties: false });

const InputSchema = Type.Object({
	type: StringEnum(["text", "radio", "multi", "file"] as const, {
		description:
			"'text' for a free-text answer, 'radio' to pick exactly one option, 'multi' to pick any number of options, " +
			"and 'file' to pick or type a path",
	}),
	title: Type.String({ description: "The question or field title shown to the user" }),
	id: Type.Optional(
		Type.String({
			description:
				"Optional stable identifier echoed back in this input's answer. Set it (and unique per call) to correlate answers programmatically instead of matching on title.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional context shown beneath the title" })),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			maxItems: 50,
			description:
				"Choices for 'radio'/'multi' inputs. Ignored for other input types. Radio/multi inputs always include a 'Something else…' choice.",
		}),
	),
	optional: Type.Optional(Type.Boolean({ description: "If true, the user may skip this input; skipped optionals are reported explicitly." })),
	default: Type.Optional(
		Type.String({
			description:
				"Default value. For text/file: the value/path; radio: an option's title or value. Do not use for multi inputs.",
		}),
	),
	defaults: Type.Optional(
		Type.Array(Type.String({ description: "An option's title or value, selected by default" }), {
			description: "Default selected options for multi inputs (match each by option title or value).",
		}),
	),
	pattern: Type.Optional(Type.String({ description: "Text inputs only: JavaScript regular expression the answer must match." })),
	patternHint: Type.Optional(Type.String({ description: "Text inputs only: human-readable hint shown when pattern validation fails." })),
	fileKind: Type.Optional(
		StringEnum(["file", "directory", "any"] as const, {
			description:
				"File inputs only: restrict existing paths to files, directories, or either. Nonexistent paths are allowed. Defaults to 'any'.",
		}),
	),
}, { additionalProperties: false });

const UserInputsParams = Type.Object(
	{
		inputs: Type.Array(InputSchema, {
			minItems: 1,
			maxItems: 10,
			description: "One to ten inputs to ask the user, shown as tabs",
		}),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Extension.
// ---------------------------------------------------------------------------

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more questions and wait for their answers. Use this whenever you have a question, " +
			"need to clarify requirements, want a preference, or must confirm a decision before proceeding. Inputs can be " +
			"text, radio, multi, or file. Inputs may be optional, have defaults or recommended choices, and include validation.",
		promptSnippet: "ask_user — ask the user text / single-choice / multi-choice / typed questions and get their answers",
		promptGuidelines: [
			"When you need information only the user can provide, call ask_user instead of guessing or asking in prose.",
			"Give every ask_user input a clear title and description, and use optional for nice-to-have answers.",
			"In ask_user, mark a suggested radio or multi choice with options[].recommended; this labels the choice without selecting it. Use default/defaults only when the answer should actually be preselected.",
			"Prefer typed ask_user inputs (file, radio, multi) over free text when the answer shape is known; for a number use text with a pattern like '^-?\\d+$'.",
			"For a yes/no confirmation, use a required radio with two options rather than free text.",
			"Set a stable `id` on each input (and `options[].value`) when you will process answers programmatically — answers echo the id and the selected option's value.",
		],
		parameters: UserInputsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rawErr = validateRawInputs(params.inputs);
			if (rawErr) throw new Error(rawErr);
			const inputs = normalizeInputs(params.inputs as RawInput[]);
			const err = validateInputs(inputs);
			if (err) throw new Error(err);
			if (ctx.mode !== "tui") {
				throw new Error(
					`No user is available to answer ask_user in ${ctx.mode} mode. Proceed with reasonable assumptions and state them.`,
				);
			}

			const result = await showUserInputs(ctx, inputs, ctx.cwd);
			return { content: [{ type: "text", text: summarizeAnswers(result) }], details: result };
		},

		renderCall(args, theme, _context) {
			const inputs = Array.isArray(args.inputs) ? (args.inputs as Input[]) : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", `${inputs.length} input${inputs.length !== 1 ? "s" : ""}`);
			const titles = inputs.map((i) => i.title).filter(Boolean).join(", ");
			if (titles) text += theme.fg("dim", ` (${titles})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as UserInputsResult | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const answers = Array.isArray(details.answers) ? details.answers : [];
			const lines = answers.map((a) => {
				const idTag = a.id ? theme.fg("dim", ` [${a.id}]`) : "";
				if (a.skipped) return `${theme.fg("dim", `${ICON_SKIPPED} `)}${theme.fg("accent", a.title)}${idTag}: ${theme.fg("dim", "(skipped)")}`;
				const head = `${theme.fg("success", `${ICON_SUCCESS} `)}${theme.fg("accent", a.title)}${idTag}: `;
				if (a.type === "text") {
					return head + theme.fg("text", a.text ?? "");
				}
				if (a.type === "file") {
					const path = a.path && a.text && a.path !== a.text ? theme.fg("dim", `  (${a.path})`) : "";
					return head + theme.fg("text", a.text ?? a.path ?? "") + path;
				}
				const picks = (a.selections ?? []).map((s) => (s.custom ? `${s.title} (else)` : s.title)).join(", ");
				return head + theme.fg("text", picks || "(none)");
			});
			if (details.note) {
				lines.push(`${theme.fg("dim", `${ICON_EDIT} `)}${theme.fg("accent", "Notes")}: ${theme.fg("text", details.note)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

}
