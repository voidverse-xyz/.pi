/**
 * Ask Parent — an LLM-callable tool that lets a subagent pause and ask its parent
 * agent a question instead of guessing when it hits a decision only the parent has
 * the context to make.
 *
 * PER-AGENT ALLOWANCE. The tool is registered only when delegate.ts sets PI_ASK_PARENT=1
 * on the spawned child — which it does only while that agent still has ask budget this
 * request. An agent's budget is its frontmatter `askLimit`, or the user-configurable
 * default (`/subagent asklimit`) when it sets none; 0 ⇒ never granted. The top-level
 * agent is never spawned with the flag, so it never sees the tool (a "summarize → ask →
 * exit" tool would only confuse a top-level agent that has no parent — it talks to the
 * human directly through user_inputs instead).
 *
 * The flow is "summarize → ask → exit", NOT a blocking mid-run round-trip. That is a
 * deliberate consequence of how delegation works: while a subagent runs, the PARENT
 * AGENT (the LLM) is frozen inside the `subagent` tool call — it cannot think, so it
 * cannot answer a live question. The only moment the parent LLM can answer is when its
 * turn resumes, i.e. after the child's tool call returns. So:
 *
 *   1. The subagent calls ask_parent({ summary, question }) and ends its turn.
 *   2. delegate.ts (the parent's code) sees this tool call in the child's output
 *      stream, captures {summary, question} from its arguments, and cleanly stops the
 *      child — surfacing the pause as the `subagent` tool result.
 *   3. The parent's turn resumes; the parent LLM reads the question + progress summary,
 *      answers it from its broader context, and delegates a continuation (to the same
 *      agent, another agent, or by finishing the work itself) carrying the goal, the
 *      summary, the question, and the answer.
 *
 * This tool needs no IPC channel: the pause travels as the subagent's own tool call,
 * which delegate.ts already parses from the child's stdout event stream. The parent
 * detecting the call is what makes the stop deterministic — this execute() body is a
 * belt-and-suspenders end-of-turn signal that usually returns after the child is gone.
 *
 * Install: ~/.pi/agent/extensions/ask-parent/index.ts
 * Reload: /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ASK_PARENT_ENV } from "../subagents/depth.ts";

const AskParentParams = Type.Object({
	summary: Type.String({
		description:
			"A self-contained summary of the progress you've made and the context needed to continue AFTER your question is answered. " +
			"Assume the continuation starts fresh with no memory of your work — include file paths, findings, and what remains.",
	}),
	question: Type.String({
		description: "The specific question or decision you need the parent agent to resolve before you can continue.",
	}),
});

/** Details attached to the tool result. delegate.ts reads the tool-call arguments, not this. */
interface AskParentDetails {
	paused: boolean;
	summary: string;
	question: string;
}

export default function askParent(pi: ExtensionAPI) {
	// Opt-in per agent: delegate.ts sets PI_ASK_PARENT=1 only on a spawned child whose
	// agent granted ask_parent (askLimit ≥ 1) and still has budget this request. Absent
	// ⇒ don't register — so the top-level agent and capped/opted-out agents never see it.
	if (process.env[ASK_PARENT_ENV] !== "1") return;

	pi.registerTool({
		name: "ask_parent",
		label: "Ask Parent",
		description:
			"Pause and ask your parent agent a question when you hit a decision only it has the context to make. " +
			"Provide a `summary` of your progress and the specific `question`. Calling this ENDS your run: the parent " +
			"answers and delegates a continuation carrying your summary, the question, and its answer. Use this instead " +
			"of guessing on ambiguous scope, conflicting requirements, or a choice that depends on the broader goal.",
		promptSnippet: "ask_parent — pause and ask your parent agent a question, then hand back a progress summary",
		promptGuidelines: [
			"Call ask_parent only when genuinely blocked by a decision above your scope — ambiguous requirements, a choice that hinges on the overall goal, or conflicting constraints. Do not use it for things you can determine yourself.",
			"Always give a `summary` complete enough that a fresh agent could resume from it: the continuation does NOT inherit your context.",
			"After calling ask_parent, STOP. Do not call other tools or keep working — your run ends and the parent takes over.",
		],
		parameters: AskParentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const summary = (params.summary ?? "").trim();
			const question = (params.question ?? "").trim();
			if (!question) {
				return {
					content: [{ type: "text", text: "ask_parent needs a non-empty 'question'." }],
					details: { paused: false, summary, question } satisfies AskParentDetails,
					isError: true,
				};
			}

			// The parent watches this process's output stream: it captures the question +
			// summary from the tool-call arguments and stops this run, then answers and
			// delegates a continuation. Nothing to do but end the turn — and the parent will
			// typically have stopped this child before this even returns.
			return {
				content: [
					{
						type: "text",
						text:
							"Paused. Your question and progress summary were handed to the parent agent. " +
							"End your turn now — do not call more tools or keep working. The parent will answer " +
							"and delegate a continuation.",
					},
				],
				details: { paused: true, summary, question } satisfies AskParentDetails,
			};
		},

		renderCall(args, theme, _context) {
			const question = typeof args.question === "string" ? args.question : "";
			const preview = question.length > 70 ? `${question.slice(0, 70)}…` : question;
			let text = theme.fg("toolTitle", theme.bold("ask_parent "));
			text += theme.fg("warning", "⏸ ");
			text += theme.fg("dim", preview || "(no question)");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskParentDetails | undefined;
			if (details?.paused) {
				const q = details.question || "(no question)";
				return new Text(`${theme.fg("warning", "⏸ Paused — asked parent: ")}${theme.fg("text", q)}`, 0, 0);
			}
			const t = result.content[0];
			return new Text(t?.type === "text" ? t.text : "", 0, 0);
		},
	});
}
