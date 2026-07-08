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
 * The panel UI, normalization, and answer summary live in ask.ts. When a headless
 * subagent calls ask_user it has no local TUI, so this tool forwards the request via
 * the optional `ipc` extension (over pi.events, no import) and the parent runs the panel
 * — naming the asking subagent so the user knows the question isn't from the main agent.
 * If `ipc` isn't installed the tool returns a graceful error instead.
 *
 * Install as a package: packages/pi-ask-user/extensions/ask-user/index.ts
 * Reload: /reload
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type Input,
	normalizeInputs,
	type RawInput,
	showUserInputs,
	summarizeAnswers,
	type UserInputsResult,
	validateInputs,
	validateRawInputs,
} from "./ask.ts";

// ---------------------------------------------------------------------------
// Optional ipc capability (no import — pure runtime rendezvous over pi.events).
//
// A headless subagent has no local TUI, so it forwards the question up to its parent.
// The transport lives in the standalone `ipc` extension; we reach it by emitting an
// `ipc:client` probe carrying a `claim` callback. If `ipc` is installed AND this process
// has a parent channel, it claims synchronously and does the fd round-trip; otherwise
// nothing claims and we return a graceful error. No import means dropping `ipc` can't
// break this extension's load.
// ---------------------------------------------------------------------------

type ClaimFn = (params: unknown, meta: { method: string; from: string[] }) => Promise<unknown> | unknown;
type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

// Captured at session_start so the parent-side ipc:serve handler can render the panel on
// this process's TUI when a headless child forwards a user.ask up to us.
let currentCtx: ExtensionContext | undefined;

function busCall<T>(pi: ExtensionAPI, channel: string, method: string, params: unknown): Promise<IpcResult<T>> {
	let claimed: ClaimFn | null = null;
	pi.events.emit(channel, {
		method,
		claim: (fn: ClaimFn) => {
			claimed = fn;
		},
	});
	if (!claimed) return Promise.resolve({ ok: false, error: "no ipc provider" });
	return Promise.resolve()
		.then(() => (claimed as ClaimFn)(params, { method, from: [] }))
		.then(
			(value) => ({ ok: true, value: value as T }) as IpcResult<T>,
			(err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as IpcResult<T>,
		);
}

// ---------------------------------------------------------------------------
// Schema — what the agent fills in.
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	title: Type.String({ description: "Short label for this option" }),
	description: Type.Optional(Type.String({ description: "Optional detail shown beneath the option" })),
	value: Type.Optional(
		Type.String({ description: "Optional stable value returned when this option is selected, instead of its display title." }),
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
			description: "File inputs only: restrict the path to files, directories, or either. Defaults to 'any'.",
		}),
	),
}, { additionalProperties: false });

const UserInputsParams = Type.Object(
	{
		inputs: Type.Array(InputSchema, { description: "One or more inputs to ask the user, shown as tabs" }),
	},
	{ additionalProperties: false },
);

function errorResult(message: string): { content: { type: "text"; text: string }[]; details: UserInputsResult } {
	// cancelled:false — this is a failure to present the tool, not a user cancellation, so the
	// renderer shows the error rather than "Cancelled".
	return { content: [{ type: "text", text: message }], details: { answers: [], cancelled: false, error: message } };
}

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
			"text, radio, multi, or file. Inputs may be optional, have defaults, and include validation.",
		promptSnippet: "ask_user — ask the user text / single-choice / multi-choice / typed questions and get their answers",
		promptGuidelines: [
			"When you need information only the user can provide, call ask_user instead of guessing or asking in prose.",
			"Give every ask_user input a clear title and description, use optional for nice-to-have answers, and provide default/defaults when a best guess exists.",
			"Prefer typed ask_user inputs (file, radio, multi) over free text when the answer shape is known; for a number use text with a pattern like '^-?\\d+$'.",
			"For a yes/no confirmation, use a required radio with two options rather than free text.",
			"Set a stable `id` on each input (and `options[].value`) when you will process answers programmatically — answers echo the id and the selected option's value.",
		],
		parameters: UserInputsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rawErr = validateRawInputs(params.inputs);
			if (rawErr) return errorResult(rawErr);
			const inputs = normalizeInputs(params.inputs as RawInput[]);
			const err = validateInputs(inputs);
			if (err) return errorResult(err);

			let result: UserInputsResult;
			if (ctx.mode === "tui") {
				// The calling agent has the terminal TUI — show the rich custom panel directly
				// (from is empty: it's this agent).
				result = await showUserInputs(ctx, inputs, [], ctx.cwd);
			} else {
				// No local terminal panel (ctx.ui.custom is tui-only). First try to forward to a
				// parent session's TUI via the optional `ipc` extension — the headless-subagent
				// case. The parent stamps our identity onto the request's `from`, so the user sees
				// which subagent asked. Send raw inputs so non-serializable normalized defaults
				// (Set/RegExp) are rebuilt on the presenting side.
				const res = await busCall<UserInputsResult>(pi, "ipc:client", "user.ask", { inputs: params.inputs, cwd: ctx.cwd });
				if (!res.ok) {
					// No terminal here and no parent session to forward to — there is no user to
					// answer. Tell the model so it stops waiting and proceeds on its own.
					return errorResult(
						`Error: no user is available to answer ask_user (${ctx.mode} mode, no reachable interactive session). Proceed without asking — make reasonable assumptions and state them.`,
					);
				}
				result = res.value;
			}

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
			if (details.error) {
				return new Text(theme.fg("error", details.error), 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const answers = Array.isArray(details.answers) ? details.answers : [];
			const lines = answers.map((a) => {
				const idTag = a.id ? theme.fg("dim", ` [${a.id}]`) : "";
				if (a.skipped) return `${theme.fg("dim", "○ ")}${theme.fg("accent", a.title)}${idTag}: ${theme.fg("dim", "(skipped)")}`;
				const head = `${theme.fg("success", "✓ ")}${theme.fg("accent", a.title)}${idTag}: `;
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
				lines.push(`${theme.fg("dim", "✎ ")}${theme.fg("accent", "Notes")}: ${theme.fg("text", details.note)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// Parent side: when a headless child forwards a "user.ask" up through the `ipc`
	// extension, ipc probes `ipc:serve` for a capability that can render it. Claim it only
	// when this process has an interactive TUI (otherwise ipc forwards further up). The
	// claim is synchronous so the probe sees it; `meta.from` names the asking subagent.
	pi.events.on("ipc:serve", (data) => {
		const { method, claim } = data as { method: string; claim: (fn: ClaimFn) => void };
		if (method !== "user.ask" || currentCtx?.mode !== "tui") return;
		claim(async (params, meta) => {
			const request = params as { inputs?: RawInput[]; cwd?: string };
			const rawErr = validateRawInputs(request.inputs ?? []);
			if (rawErr) throw new Error(rawErr);
			const inputs = normalizeInputs(request.inputs ?? []);
			const err = validateInputs(inputs);
			if (err) throw new Error(err);
			const root = typeof request.cwd === "string" && request.cwd ? request.cwd : (currentCtx as ExtensionContext).cwd;
			return showUserInputs(currentCtx as ExtensionContext, inputs, meta.from, root);
		});
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
	});

	pi.on("session_shutdown", () => {
		currentCtx = undefined;
	});
}
