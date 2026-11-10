/**
 * journal/journal.ts — the append-only run journal and the resume cache.
 *
 * journal.jsonl, one JSON object per line:
 *   {type:"meta", v:1, runId, name, scriptHash, argsHash, createdAt, resumedFrom?}
 *   {type:"agent", seq, hash, label, phase, status:"ok"|"error",
 *    output?|outputFile?, error?, promptPreview, elapsedMs, cached?}
 *   {type:"log", text}
 *   {type:"end", status, result?}
 *
 * `hash` is sha256 of the canonical JSON of {prompt, schema, model, thinking,
 * tools} — label/phase are cosmetic and excluded. Parallel agents complete out
 * of seq order; readers sort where order matters.
 *
 * Resume cache: hash-keyed FIFO multiset of the prior run's OK entries (more
 * robust than a strict seq prefix — parallel branches may complete in a
 * different order across runs without spuriously diverging). The first lookup
 * miss sets `diverged` permanently; everything after runs live. Errored
 * entries are never cached, so a previously failed call re-runs.
 *
 * Outputs whose JSON exceeds MAX_INLINE_OUTPUT go to a sidecar file
 * (agents/<seq>/output.json) referenced by `outputFile`.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_INLINE_OUTPUT = 256 * 1024;

export interface JournalMetaLine {
	type: "meta";
	v: 1;
	runId: string;
	name: string;
	scriptHash: string;
	argsHash: string;
	createdAt: string;
	resumedFrom?: string;
}

export interface JournalAgentLine {
	type: "agent";
	seq: number;
	hash: string;
	label: string;
	phase: string;
	status: "ok" | "error";
	output?: unknown;
	/** Sidecar path when the output was too large to inline. */
	outputFile?: string;
	error?: string;
	promptPreview: string;
	elapsedMs: number;
	cached?: true;
}

export interface JournalLogLine {
	type: "log";
	text: string;
}

export interface JournalEndLine {
	type: "end";
	status: "completed" | "stopped" | "failed";
	result?: unknown;
	error?: string;
}

export type JournalLine = JournalMetaLine | JournalAgentLine | JournalLogLine | JournalEndLine;

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function canonicalJSON(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const parts = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
	return `{${parts.join(",")}}`;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface AgentCallKey {
	prompt: string;
	schema?: unknown;
	model?: string | undefined;
	thinking?: string | undefined;
	tools?: string[] | undefined;
	phase?: string | undefined;
}

/**
 * The identity of an agent() call for caching. label excluded (cosmetic);
 * phase included so structurally-identical calls in different phases are not
 * interchangeable on resume.
 */
export function hashAgentCall(key: AgentCallKey): string {
	return sha256(
		canonicalJSON({
			prompt: key.prompt,
			schema: key.schema ?? null,
			model: key.model ?? null,
			thinking: key.thinking ?? null,
			tools: key.tools ?? null,
			phase: key.phase ?? null,
		}),
	);
}

export class Journal {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	start(meta: Omit<JournalMetaLine, "type" | "v">): void {
		mkdirSync(dirname(this.file), { recursive: true });
		this.append({ type: "meta", v: 1, ...meta });
	}

	append(line: JournalLine): void {
		appendFileSync(this.file, `${JSON.stringify(line)}\n`, "utf8");
	}

	/** Append an agent entry, spilling oversized outputs to the sidecar file. */
	appendAgent(entry: JournalAgentLine, sidecarFile: string): void {
		if (entry.output !== undefined) {
			const inline = JSON.stringify(entry.output) ?? "null";
			if (inline.length > MAX_INLINE_OUTPUT) {
				mkdirSync(dirname(sidecarFile), { recursive: true });
				writeFileSync(sidecarFile, inline, "utf8");
				this.append({ ...entry, output: undefined, outputFile: sidecarFile });
				return;
			}
		}
		this.append(entry);
	}
}

/** Read a journal; unparseable lines are skipped (torn writes on crash). */
export function readJournal(file: string): JournalLine[] {
	if (!existsSync(file)) return [];
	const lines: JournalLine[] = [];
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		if (!raw.trim()) continue;
		try {
			const parsed = JSON.parse(raw) as JournalLine;
			if (parsed && typeof parsed === "object" && typeof parsed.type === "string") lines.push(parsed);
		} catch {
			// torn/corrupt line — skip
		}
	}
	return lines;
}

/** Load an agent entry's output, reading the sidecar when spilled. */
export function hydrateAgentOutput(line: JournalAgentLine): unknown {
	if (line.outputFile) return JSON.parse(readFileSync(line.outputFile, "utf8"));
	return line.output;
}

export class ReplayCache {
	private readonly byHash = new Map<string, JournalAgentLine[]>();
	private divergedFlag = false;

	constructor(lines: JournalLine[]) {
		const entries = lines
			.filter((l): l is JournalAgentLine => l.type === "agent" && l.status === "ok")
			.sort((a, b) => a.seq - b.seq);
		for (const entry of entries) {
			const bucket = this.byHash.get(entry.hash);
			if (bucket) bucket.push(entry);
			else this.byHash.set(entry.hash, [entry]);
		}
	}

	get diverged(): boolean {
		return this.divergedFlag;
	}

	get size(): number {
		let n = 0;
		for (const bucket of this.byHash.values()) n += bucket.length;
		return n;
	}

	/** Take the cached entry for a call hash; the first miss diverges forever. */
	take(hash: string): JournalAgentLine | null {
		if (this.divergedFlag) return null;
		const bucket = this.byHash.get(hash);
		const entry = bucket?.shift();
		if (!entry) {
			this.divergedFlag = true;
			return null;
		}
		return entry;
	}
}
