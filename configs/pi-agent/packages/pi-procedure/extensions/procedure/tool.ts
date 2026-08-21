/**
 * tool.ts — the LLM-callable `procedure` tool.
 *
 * Exactly one of script | name | scriptPath selects the source. One run at a
 * time per host session. Progress streams to the transcript via onUpdate
 * (throttled); the tree widget (TUI) renders the same snapshot live. The tool
 * result is the run outcome: {runId, status, result, summary, runDir}.
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { jsonResult } from "./results.ts";
import type { RunOutcome, ProcedureRun } from "./run.ts";

export const PROCEDURE_TOOL = "procedure";
const UPDATE_THROTTLE_MS = 500;

export interface SourceRequest {
	script?: string;
	name?: string;
	scriptPath?: string;
}

export interface ProcedureToolHost {
	/** Resolve the script source (inline / saved name / path). Throws with a useful message. */
	resolveSource(request: SourceRequest, ctx: ExtensionContext): { source: string; fallbackName?: string };
	/** Build a run wired to layout/scheduler/confirm/models. Throws on meta or resume errors. */
	createRun(
		input: { source: string; fallbackName?: string; args: unknown; resumeFromRunId?: string },
		ctx: ExtensionContext,
		onChange: () => void,
	): ProcedureRun;
	/** The single active run (brake + /procedures target). */
	active: { run: ProcedureRun | null };
	/** The last finished run's id, surfaced for resume. */
	lastRunId: { value: string | null };
	/** Widget refresh hook (TUI only; may be a no-op). */
	onRunChanged(ctx: ExtensionContext): void;
}

const ProcedureParams = Type.Object(
	{
		script: Type.Optional(
			Type.String({
				description: "Inline JavaScript starting with a literal `export const meta = {name, description, phases}`.",
			}),
		),
		name: Type.Optional(Type.String({ description: "Saved procedure name." })),
		scriptPath: Type.Optional(Type.String({ description: "Absolute or cwd-relative procedure .js path." })),
		args: Type.Optional(Type.Any({ description: "JSON exposed as global `args`." })),
		resumeFromRunId: Type.Optional(
			Type.String({
				description: "Prior runId; reuses unchanged agent() results until the first changed call.",
			}),
		),
	},
	{ additionalProperties: false },
);

function progressText(run: ProcedureRun): string {
	const snap = run.snapshot();
	const lines = [`procedure ${snap.name} [${snap.runId}] — ${snap.status}${snap.currentPhase ? ` · phase ${snap.currentPhase}` : ""}`];
	for (const row of snap.rows) {
		lines.push(`  ${row.label}${row.cached ? " (cached)" : ""}${row.activity?.summary ? ` · ${row.activity.summary}` : ""}${row.error ? ` — ${row.error}` : ""}`);
	}
	for (const log of snap.logs.slice(-2)) lines.push(`  log: ${log}`);
	return lines.join("\n");
}

export function createProcedureTool(host: ProcedureToolHost): ToolDefinition {
	const tool = {
		name: PROCEDURE_TOOL,
		label: "Procedure",
		description:
			"Run one deterministic fan-out procedure from inline JavaScript, a saved name, or a .js path (exactly one). " +
			"Use for parallel reviews, migrations, judge panels, or multi-angle research. Only one run may be active; " +
			"resume by runId to reuse unchanged agent() results.",
		promptSnippet:
			"procedure — orchestrate subagents with a deterministic JS script (agent/parallel/pipeline/phase/log); resumable via runId",
		promptGuidelines: [
			"Procedure scripts are plain JavaScript run in an async context — use await directly; no TypeScript, require, process, fetch, or timers.",
			'Begin the script with `export const meta = {name, description, phases}` — a PURE literal (no variables or calls). Example: export const meta = {name: "review", description: "Review the diff", phases: ["Find", "Verify"]}.',
			"Globals: agent(prompt, opts?) spawns a one-shot subagent and resolves its final text (or, with opts.schema, a validated JSON object). " +
				"opts: {label, phase, schema (restricted JSON Schema: type/properties/required/additionalProperties/items/enum/const), model ('provider/id'), thinking, tools (subset of read/bash/edit/write/grep/find/ls)}.",
			"parallel(thunks) runs zero-arg functions concurrently; a failed thunk yields null (filter with .filter(Boolean)). " +
				"pipeline(items, ...stages) runs each item through all stages with no barrier between stages; a stage throw drops that item to null. Stages receive (prevResult, originalItem, index).",
			"phase(title) groups subsequent agents in the progress display; log(msg) emits a narrator line; args is the JSON value you passed in.",
			"Date.now(), zero-arg new Date(), and Math.random() throw inside scripts — they would break deterministic resume. Derive values from args or agent results.",
			"Prefer pipeline() over parallel-then-parallel; only use a barrier when a stage genuinely needs ALL prior results (dedup, early-exit).",
			"Concurrency is capped (default 4); excess agent() calls queue automatically — fan out freely.",
			"If a run is stopped or fails partway, the tool result includes the runId — re-invoke with resumeFromRunId to reuse the completed agents' outputs.",
		],
		parameters: ProcedureParams,

		async execute(
			_toolCallId: string,
			params: { script?: string; name?: string; scriptPath?: string; args?: unknown; resumeFromRunId?: string },
			signal: AbortSignal | undefined,
			onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const sources = [params.script, params.name, params.scriptPath].filter((s) => typeof s === "string" && s.trim() !== "");
			if (sources.length !== 1) {
				throw new Error("Pass exactly one of `script`, `name`, or `scriptPath`.");
			}
			if (host.active.run) {
				throw new Error(
					`A procedure is already running (${host.active.run.name} [${host.active.run.runId}]). Wait for it, or stop it with /procedures stop (alt+w).`,
				);
			}

			let run: ProcedureRun;
			let lastUpdate = 0;
			const onChange = (): void => {
				host.onRunChanged(ctx);
				if (!onUpdate || !run) return;
				const now = Date.now();
				if (now - lastUpdate < UPDATE_THROTTLE_MS) return;
				lastUpdate = now;
				onUpdate({ content: [{ type: "text", text: progressText(run) }], details: undefined });
			};

			try {
				const { source, fallbackName } = host.resolveSource(params, ctx);
				run = host.createRun(
					{
						source,
						...(fallbackName !== undefined ? { fallbackName } : {}),
						args: params.args,
						...(params.resumeFromRunId !== undefined ? { resumeFromRunId: params.resumeFromRunId } : {}),
					},
					ctx,
					onChange,
				);
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}

			host.active.run = run;
			const onAbort = (): void => run.stop();
			signal?.addEventListener("abort", onAbort);
			let outcome: RunOutcome;
			try {
				outcome = await run.execute();
			} finally {
				signal?.removeEventListener("abort", onAbort);
				host.active.run = null;
				host.lastRunId.value = run.runId;
				host.onRunChanged(ctx);
			}
			return jsonResult(outcome);
		},

		renderCall(args: Record<string, unknown>, theme: { fg(color: string, text: string): string; bold(text: string): string }) {
			let text = theme.fg("toolTitle", theme.bold("procedure "));
			if (typeof args.name === "string") text += theme.fg("text", args.name);
			else if (typeof args.scriptPath === "string") text += theme.fg("text", args.scriptPath);
			else text += theme.fg("muted", "(inline script)");
			if (typeof args.resumeFromRunId === "string") text += theme.fg("dim", ` · resume ${args.resumeFromRunId}`);
			return new Text(text, 0, 0);
		},
	};
	return tool as unknown as ToolDefinition;
}
