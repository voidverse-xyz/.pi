/**
 * User Inputs — an LLM-callable tool for asking the user structured questions.
 *
 * Registered via pi.registerTool as `user_inputs`, so the *agent* invokes it
 * whenever it has a question or wants to ask the user something, and the user
 * answers inside a native Pi TUI panel. (This has to be a tool, not a skill or a
 * plain slash command: a skill is only markdown instructions, and a command can't
 * be called by the model mid-turn. Modeled on the bundled `question.ts` /
 * `questionnaire.ts` examples.)
 *
 * One call can bundle several inputs, each of one of three types:
 *   - "text"  — a free-text answer.
 *   - "radio" — pick exactly one of a list of options.
 *   - "multi" — pick any number of a list of options.
 *
 * The panel UI, normalization, and answer summary live in ask.ts, shared with the
 * subagents delegation tool: when a headless subagent calls user_inputs it has no
 * local TUI, so this tool forwards the request over the IPC channel (see
 * subagents/ipc.ts) and the parent runs the panel — naming the asking subagent so
 * the user knows the question isn't from the main agent.
 *
 * Install: ~/.pi/agent/extensions/user-inputs/index.ts
 * Reload: /reload
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hasIpcChannel, ipcRequest } from "../subagents/ipc.ts";
import {
	type Input,
	normalizeInputs,
	showUserInputs,
	summarizeAnswers,
	type UserInputsResult,
	validateInputs,
} from "./ask.ts";

// ---------------------------------------------------------------------------
// Schema — what the agent fills in.
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	title: Type.String({ description: "Short label for this option" }),
	description: Type.Optional(Type.String({ description: "Optional detail shown beneath the option" })),
});

const InputSchema = Type.Object({
	type: StringEnum(["text", "radio", "multi"] as const, {
		description:
			"'text' for a free-text answer, 'radio' to pick exactly one option, 'multi' to pick any number of options",
	}),
	title: Type.String({ description: "The question or field title shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional context shown beneath the title" })),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description: "Choices for 'radio'/'multi' inputs. Ignored for 'text'. A 'Something else…' choice is always added.",
		}),
	),
});

const UserInputsParams = Type.Object({
	inputs: Type.Array(InputSchema, { description: "One or more inputs to ask the user, shown as tabs" }),
});

function errorResult(message: string): { content: { type: "text"; text: string }[]; details: UserInputsResult } {
	return { content: [{ type: "text", text: message }], details: { answers: [], cancelled: true } };
}

// ---------------------------------------------------------------------------
// Extension.
// ---------------------------------------------------------------------------

export default function userInputs(pi: ExtensionAPI) {
	pi.registerTool({
		name: "user_inputs",
		label: "User Inputs",
		description:
			"Ask the user one or more questions and wait for their answers. Use this whenever you have a question, " +
			"need to clarify requirements, want a preference, or must confirm a decision before proceeding. Each input " +
			"is 'text' (free text), 'radio' (pick one), or 'multi' (pick several). List inputs always include a " +
			"'Something else…' escape hatch and let the user attach a note.",
		promptSnippet: "user_inputs — ask the user text / single-choice / multi-choice questions and get their answers",
		promptGuidelines: [
			"When you need information only the user can provide, call user_inputs instead of guessing or asking in prose.",
			"Give every input a clear title and a description, and give list options descriptive titles.",
			"Prefer 'radio'/'multi' with concrete options when the space of answers is known; the user can still pick 'Something else…' or add a note.",
		],
		parameters: UserInputsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const inputs = normalizeInputs(params.inputs);
			const err = validateInputs(inputs);
			if (err) return errorResult(err);

			let result: UserInputsResult;
			if (ctx.mode === "tui") {
				// The calling agent has the TUI — ask directly (from is empty: it's this agent).
				result = await showUserInputs(ctx, inputs, []);
			} else if (hasIpcChannel()) {
				// Headless subagent — forward to the parent's TUI. The parent stamps our
				// identity onto the request's `from`, so the user sees which subagent asked.
				const res = await ipcRequest<UserInputsResult>("user.ask", { inputs });
				if (!res.ok) return errorResult(`Error: user_inputs unavailable (${res.error}).`);
				result = res.value;
			} else {
				return errorResult("Error: user_inputs needs interactive mode (UI unavailable).");
			}

			return { content: [{ type: "text", text: summarizeAnswers(result) }], details: result };
		},

		renderCall(args, theme, _context) {
			const inputs = Array.isArray(args.inputs) ? (args.inputs as Input[]) : [];
			let text = theme.fg("toolTitle", theme.bold("user_inputs "));
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
			const lines = details.answers.map((a) => {
				const head = `${theme.fg("success", "✓ ")}${theme.fg("accent", a.title)}: `;
				if (a.type === "text") return head + theme.fg("text", a.text ?? "");
				const picks = (a.selections ?? []).map((s) => (s.custom ? `${s.title} (else)` : s.title)).join(", ");
				const note = a.note ? theme.fg("dim", `  — ${a.note}`) : "";
				return head + theme.fg("text", picks || "(none)") + note;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
