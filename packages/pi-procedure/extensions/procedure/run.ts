/**
 * run.ts — the ProcedureRun orchestrator: vm script ⇄ agent runner ⇄ journal.
 *
 * One run at a time per host session (enforced by the tool). Lifecycle:
 *   create()  — extract meta, mint runId, load the resume cache
 *   execute() — journal meta line, compile, run the script, journal the end
 *   stop()    — sets the stopped flag; running sessions are aborted by the
 *               runner's watcher; pending/future agent() calls reject
 *               ProcedureStopped, which unwinds through the combinators.
 *               The grace period abandons a script that swallows the stop
 *               error; in-flight agent sessions are separately aborted by the
 *               runner's stop watcher.
 *
 * execute() never rejects for script problems — it resolves an outcome with
 * status completed | stopped | failed. Only programmer errors escape.
 */

import { randomBytes } from "node:crypto";
import {
	hashAgentCall,
	hydrateAgentOutput,
	Journal,
	readJournal,
	ReplayCache,
	sha256,
	canonicalJSON,
	type JournalMetaLine,
} from "./journal/journal.ts";
import { mintRunId, type ProcedureLayout } from "./journal/layout.ts";
import type { AgentActivity, AgentCall, AgentRunResult, AgentRunState, RunnerPorts } from "./runner/agent-runner.ts";
import type { Scheduler } from "./runner/scheduler.ts";
import type { ConfirmFn } from "./sandbox/safety-bridge.ts";
import type { SandboxPorts } from "./sandbox/tools-filter.ts";
import { compileScript } from "./script/compile.ts";
import { extractMeta, type ProcedureMeta } from "./script/meta.ts";
import { AgentFailure, makeCombinators, ProcedureStopped } from "./script/semantics.ts";
import { truncateFlat } from "./text.ts";

const STOP_GRACE_MS = 5_000;
const PREVIEW_MAX = 200;

export type RunStatus = "running" | "completed" | "stopped" | "failed";

export interface AgentRow {
	seq: number;
	label: string;
	phase: string;
	state: AgentRunState;
	activity?: AgentActivity;
	error?: string;
	cached?: boolean;
	model?: string;
	elapsedMs?: number;
}

export interface RunSnapshot {
	runId: string;
	name: string;
	status: RunStatus;
	currentPhase: string;
	phases: string[];
	rows: AgentRow[];
	logs: string[];
}

export interface RunOutcome {
	runId: string;
	status: Exclude<RunStatus, "running">;
	result?: unknown;
	error?: string;
	summary: {
		agents: Array<{ seq: number; label: string; phase: string; status: "ok" | "error" | "cached"; elapsedMs: number }>;
		phases: string[];
		logTail: string[];
	};
	runDir: string;
}

export interface ProcedureRunOptions {
	source: string;
	/** Name override for inline scripts without meta. */
	fallbackName?: string;
	args: unknown;
	resumeFromRunId?: string;
	layout: ProcedureLayout;
	scheduler: Scheduler;
	confirm: ConfirmFn;
	systemDeny: SandboxPorts["systemDeny"];
	systemDenyCommand: SandboxPorts["systemDenyCommand"];
	defaultModel: RunnerPorts["defaultModel"];
	modelRuntime?: RunnerPorts["modelRuntime"];
	resolveModel: RunnerPorts["resolveModel"];
	/** Fired on every snapshot-visible change (widget + onUpdate throttling). */
	onChange?: () => void;
	/**
	 * The agent runner (runner/agent-runner.ts runAgent, or a fake in tests).
	 * Injected so this module never imports the pi SDK — the wiring in
	 * index.ts supplies the real one.
	 */
	runAgentImpl: RunAgentFn;
	/** Injectable for tests. */
	now?: () => Date;
	entropyHex6?: () => string;
}

export type RunAgentFn = (call: AgentCall, ports: RunnerPorts) => Promise<AgentRunResult>;

interface AgentOpts {
	label?: string;
	phase?: string;
	schema?: unknown;
	model?: string;
	thinking?: string;
	tools?: string[];
}

export class ProcedureRun {
	readonly runId: string;
	readonly name: string;
	readonly meta: ProcedureMeta | null;

	private readonly options: ProcedureRunOptions;
	private readonly body: string;
	private readonly journal: Journal;
	private readonly cache: ReplayCache | null;
	private readonly resumedMeta: JournalMetaLine | null;

	private status: RunStatus = "running";
	private stopped = false;
	private stopGraceFired: (() => void) | null = null;
	private nextSeq = 0;
	private currentPhase = "";
	private readonly rows = new Map<number, AgentRow>();
	private readonly logs: string[] = [];
	private loggedDivergence = false;

	private constructor(options: ProcedureRunOptions, meta: ProcedureMeta | null, body: string) {
		this.options = options;
		this.meta = meta;
		this.body = body;
		this.name = meta?.name ?? options.fallbackName ?? "inline";
		const now = options.now ?? (() => new Date());
		const entropy = options.entropyHex6 ?? (() => randomBytes(3).toString("hex"));
		this.runId = mintRunId(now(), entropy());
		this.journal = new Journal(options.layout.journalFile(this.runId));

		if (options.resumeFromRunId) {
			const lines = readJournal(options.layout.journalFile(options.resumeFromRunId));
			if (lines.length === 0) {
				throw new Error(`resumeFromRunId ${options.resumeFromRunId}: no journal found (wrong id, or a different project cwd).`);
			}
			this.cache = new ReplayCache(lines);
			this.resumedMeta = (lines.find((l) => l.type === "meta") as JournalMetaLine | undefined) ?? null;
		} else {
			this.cache = null;
			this.resumedMeta = null;
		}
	}

	/** Parse meta and build a run. Throws on malformed meta or a bad resume id. */
	static create(options: ProcedureRunOptions): ProcedureRun {
		const { meta, body } = extractMeta(options.source);
		return new ProcedureRun(options, meta, body);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		const timer = setTimeout(() => this.stopGraceFired?.(), STOP_GRACE_MS);
		(timer as { unref?: () => void }).unref?.();
		this.emitChange();
	}

	get isStopped(): boolean {
		return this.stopped;
	}

	snapshot(): RunSnapshot {
		return {
			runId: this.runId,
			name: this.name,
			status: this.status,
			currentPhase: this.currentPhase,
			phases: this.meta?.phases ?? [],
			rows: [...this.rows.values()].sort((a, b) => a.seq - b.seq),
			logs: [...this.logs],
		};
	}

	private emitChange(): void {
		this.options.onChange?.();
	}

	private log(text: string): void {
		this.logs.push(text);
		this.journal.append({ type: "log", text });
		this.emitChange();
	}

	private makeRunnerPorts(): RunnerPorts {
		const { options } = this;
		return {
			cwd: options.layout.cwd,
			agentDir: options.layout.agentDir,
			procedureName: this.name,
			sessionDirFor: (seq) => options.layout.agentSeqDir(this.runId, seq),
			scheduler: options.scheduler,
			systemDeny: options.systemDeny,
			systemDenyCommand: options.systemDenyCommand,
			confirm: options.confirm,
			defaultModel: options.defaultModel,
			...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
			resolveModel: options.resolveModel,
			onActivity: (seq, activity) => {
				const row = this.rows.get(seq);
				if (row) {
					if (activity) row.activity = activity;
					else delete row.activity;
					this.emitChange();
				}
			},
			onState: (seq, state) => {
				const row = this.rows.get(seq);
				if (row && row.state !== "cached") {
					row.state = state;
					this.emitChange();
				}
			},
			isStopped: () => this.stopped,
		};
	}

	private makeAgentGlobal(): (prompt: string, opts?: unknown) => Promise<unknown> {
		const ports = this.makeRunnerPorts();
		return async (prompt: string, rawOpts?: unknown): Promise<unknown> => {
			if (this.stopped) throw new ProcedureStopped();
			if (rawOpts !== undefined && (typeof rawOpts !== "object" || rawOpts === null || Array.isArray(rawOpts))) {
				throw new AgentFailure("agent() opts must be an object.");
			}
			const opts = (rawOpts ?? {}) as AgentOpts;
			const seq = this.nextSeq++;
			const call: AgentCall = {
				seq,
				prompt: String(prompt),
				label: typeof opts.label === "string" && opts.label.trim() ? opts.label : `agent-${seq}`,
				phase: typeof opts.phase === "string" && opts.phase.trim() ? opts.phase : this.currentPhase,
				...(opts.schema !== undefined ? { schema: opts.schema } : {}),
				...(typeof opts.model === "string" ? { model: opts.model } : {}),
				...(typeof opts.thinking === "string" ? { thinking: opts.thinking } : {}),
				...(Array.isArray(opts.tools) ? { tools: opts.tools.map(String) } : {}),
			};
			const hash = hashAgentCall({
				prompt: call.prompt,
				schema: call.schema,
				model: call.model,
				thinking: call.thinking,
				tools: call.tools,
				phase: call.phase,
			});
			const row: AgentRow = { seq, label: call.label, phase: call.phase, state: "queued", ...(call.model ? { model: call.model } : {}) };
			this.rows.set(seq, row);
			this.emitChange();

			const sidecar = this.options.layout.outputSidecarFile(this.runId, seq);
			const cached = this.cache?.take(hash) ?? null;
			if (cached) {
				const output = hydrateAgentOutput(cached);
				row.state = "cached";
				row.cached = true;
				this.journal.appendAgent(
					{
						type: "agent",
						seq,
						hash,
						label: call.label,
						phase: call.phase,
						status: "ok",
						output,
						promptPreview: truncateFlat(call.prompt, PREVIEW_MAX),
						elapsedMs: 0,
						cached: true,
					},
					sidecar,
				);
				this.emitChange();
				return output;
			}
			if (this.cache && this.cache.diverged && !this.loggedDivergence) {
				this.loggedDivergence = true;
				this.log(`resume: diverged at agent #${seq} ("${call.label}") — running live from here.`);
			}

			const startedAt = Date.now();
			try {
				const { output, elapsedMs } = await this.options.runAgentImpl(call, ports);
				row.elapsedMs = elapsedMs;
				this.journal.appendAgent(
					{
						type: "agent",
						seq,
						hash,
						label: call.label,
						phase: call.phase,
						status: "ok",
						output,
						promptPreview: truncateFlat(call.prompt, PREVIEW_MAX),
						elapsedMs,
					},
					sidecar,
				);
				return output;
			} catch (error) {
				if (error instanceof ProcedureStopped) throw error;
				const message = error instanceof Error ? error.message : String(error);
				row.error = message;
				row.elapsedMs = Date.now() - startedAt;
				this.journal.appendAgent(
					{
						type: "agent",
						seq,
						hash,
						label: call.label,
						phase: call.phase,
						status: "error",
						error: message,
						promptPreview: truncateFlat(call.prompt, PREVIEW_MAX),
						elapsedMs: row.elapsedMs,
					},
					sidecar,
				);
				this.emitChange();
				throw error instanceof AgentFailure ? error : new AgentFailure(message);
			}
		};
	}

	private buildOutcome(status: Exclude<RunStatus, "running">, result?: unknown, error?: string): RunOutcome {
		const agents = [...this.rows.values()]
			.sort((a, b) => a.seq - b.seq)
			.map((row) => ({
				seq: row.seq,
				label: row.label,
				phase: row.phase,
				status: (row.cached ? "cached" : row.error ? "error" : "ok") as "ok" | "error" | "cached",
				elapsedMs: row.elapsedMs ?? 0,
			}));
		return {
			runId: this.runId,
			status,
			...(result !== undefined ? { result } : {}),
			...(error !== undefined ? { error } : {}),
			summary: {
				agents,
				phases: this.meta?.phases ?? [],
				logTail: this.logs.slice(-10),
			},
			runDir: this.options.layout.runDir(this.runId),
		};
	}

	async execute(): Promise<RunOutcome> {
		const { options } = this;
		const createdAt = (options.now ?? (() => new Date()))().toISOString();
		const scriptHash = sha256(options.source);
		const argsHash = sha256(canonicalJSON(options.args ?? null));
		this.journal.start({
			runId: this.runId,
			name: this.name,
			scriptHash,
			argsHash,
			createdAt,
			...(options.resumeFromRunId ? { resumedFrom: options.resumeFromRunId } : {}),
		});
		if (this.resumedMeta && (this.resumedMeta.scriptHash !== scriptHash || this.resumedMeta.argsHash !== argsHash)) {
			this.log("resume: the script or args changed since the resumed run — cached calls still replay until the first divergence.");
		}

		let runScript: () => Promise<unknown>;
		try {
			const { parallel, pipeline } = makeCombinators();
			runScript = compileScript(
				this.body,
				{
					agent: this.makeAgentGlobal(),
					parallel,
					pipeline,
					phase: (title: string) => {
						this.currentPhase = String(title);
						this.emitChange();
					},
					log: (message: string) => this.log(String(message)),
					args: options.args,
				},
				`${this.name}.js`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.status = "failed";
			const outcome = this.buildOutcome("failed", undefined, `script error: ${message}`);
			this.journal.append({ type: "end", status: "failed", error: message });
			this.emitChange();
			return outcome;
		}

		const STOP_SENTINEL = Symbol("procedure-stop-grace");
		const grace = new Promise<typeof STOP_SENTINEL>((resolve) => {
			this.stopGraceFired = () => resolve(STOP_SENTINEL);
		});

		let outcome: RunOutcome;
		try {
			const settled = await Promise.race([runScript(), grace]);
			if (settled === STOP_SENTINEL) {
				this.status = "stopped";
				outcome = this.buildOutcome("stopped", undefined, "stopped; the script did not unwind within the grace period and was abandoned");
			} else {
				// The value was constructed inside the vm realm — JSON-roundtrip it
				// into host objects (it is serialized for the model/journal anyway).
				const result = settled === undefined ? undefined : (JSON.parse(JSON.stringify(settled)) as unknown);
				if (this.stopped) {
					this.status = "stopped";
					outcome = this.buildOutcome("stopped", result);
				} else {
					this.status = "completed";
					outcome = this.buildOutcome("completed", result);
				}
			}
		} catch (error) {
			if (error instanceof ProcedureStopped || this.stopped) {
				this.status = "stopped";
				outcome = this.buildOutcome("stopped");
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.status = "failed";
				outcome = this.buildOutcome("failed", undefined, message);
			}
		}

		this.journal.append({
			type: "end",
			status: outcome.status,
			...(outcome.result !== undefined ? { result: outcome.result } : {}),
			...(outcome.error !== undefined ? { error: outcome.error } : {}),
		});
		this.emitChange();
		return outcome;
	}
}
