/**
 * journal/layout.ts — the SINGLE path authority for pi-workflow. PURE.
 *
 * On-disk shape (local fs):
 *
 *   ~/.pi/agent/sessions/<cwd-slug>/workflows/       # per-project run store
 *     <runId>/
 *       journal.jsonl                                # append-only run journal
 *       agents/<seq>/                                # one dir per agent() call
 *         <timestamp>_<uuid>.jsonl                   # REAL Pi session transcript
 *         output.json                                # sidecar for oversized outputs
 *
 * Runs are deliberately session-INDEPENDENT (unlike pi-subagents' per-sessionId
 * scoping): resume-by-runId must work across main sessions and restarts.
 *
 * Workflow libraries (saved scripts):
 *   ~/.pi/agent/workflows/<name>.js                  # global
 *   <cwd>/.pi/workflows/<name>.js                    # project (wins; trust-gated)
 *
 * Pure module: path math only — no fs access, no clock, no entropy. runId
 * minting takes its date and entropy as inputs.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pi's cwd → session-dir-name encoding, byte-for-byte (copied from
 * pi-subagents store/layout.ts):
 *   `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 */
export function cwdSlug(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}_[0-9a-f]{6}$/;

/** `<compact-ISO>_<6hex>`, e.g. 20260716T093015_a1b2c3. Inputs supplied by the host. */
export function mintRunId(now: Date, entropyHex6: string): string {
	const iso = now.toISOString().replace(/[-:]/g, "").slice(0, 15); // YYYYMMDDTHHMMSS
	const id = `${iso}_${entropyHex6}`;
	if (!RUN_ID_RE.test(id)) throw new Error(`Minted an invalid runId ${JSON.stringify(id)} (entropy must be 6 lowercase hex chars).`);
	return id;
}

export function isValidRunId(runId: string): boolean {
	return RUN_ID_RE.test(runId);
}

export interface WorkflowLayout {
	/** The project cwd this layout is for (as given). */
	readonly cwd: string;
	/** ~/.pi/agent */
	readonly agentDir: string;
	/** ~/.pi/agent/sessions/<cwd-slug>/workflows — all runs for this project. */
	readonly workflowsStateRoot: string;
	/** ~/.pi/agent/workflows — global saved-workflow library. */
	readonly globalWorkflowsDir: string;
	/** <cwd>/.pi/workflows — project saved-workflow library (wins; trust-gated). */
	readonly projectWorkflowsDir: string;
	/** ~/.pi/agent/workflows.json — extension settings ({maxConcurrent}). */
	readonly settingsFile: string;

	/** <workflowsStateRoot>/<runId> */
	runDir(runId: string): string;
	/** <runDir>/journal.jsonl */
	journalFile(runId: string): string;
	/** <runDir>/agents/<seq> — an agent call's session dir. */
	agentSeqDir(runId: string, seq: number): string;
	/** <agentSeqDir>/output.json — sidecar for oversized journal outputs. */
	outputSidecarFile(runId: string, seq: number): string;
	/** <libraryDir>/<name>.js — a saved workflow script. */
	workflowFile(dir: string, name: string): string;
}

export interface WorkflowLayoutOptions {
	/** Override $HOME (tests). Defaults to os.homedir(). */
	home?: string;
	/** Override the run-store root directly (tests / ephemeral). */
	stateRoot?: string;
}

export function createWorkflowLayout(cwd: string, options: WorkflowLayoutOptions = {}): WorkflowLayout {
	const home = options.home ?? homedir();
	const agentDir = join(home, ".pi", "agent");
	const workflowsStateRoot = options.stateRoot ?? join(agentDir, "sessions", cwdSlug(cwd), "workflows");
	const runDir = (runId: string): string => {
		if (!isValidRunId(runId)) throw new Error(`Invalid runId ${JSON.stringify(runId)}.`);
		return join(workflowsStateRoot, runId);
	};
	const agentSeqDir = (runId: string, seq: number): string => {
		if (!Number.isInteger(seq) || seq < 0) throw new Error(`Invalid agent seq ${JSON.stringify(seq)}.`);
		return join(runDir(runId), "agents", String(seq));
	};

	return {
		cwd,
		agentDir,
		workflowsStateRoot,
		globalWorkflowsDir: join(agentDir, "workflows"),
		projectWorkflowsDir: join(cwd, ".pi", "workflows"),
		settingsFile: join(agentDir, "workflows.json"),

		runDir,
		journalFile: (runId) => join(runDir(runId), "journal.jsonl"),
		agentSeqDir,
		outputSidecarFile: (runId, seq) => join(agentSeqDir(runId, seq), "output.json"),
		workflowFile: (dir, name) => join(dir, `${name}.js`),
	};
}
