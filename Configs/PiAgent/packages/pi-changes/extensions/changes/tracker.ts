/**
 * Tracks the files the *main agent* changed this session via its `edit`/`write`
 * tools — git-free.
 *
 * Two halves:
 *  - Live capture (registerTracker): a `tool_call` handler snapshots each file's
 *    pre-image the first time the agent touches it (persisted as a `changes.baseline`
 *    session entry so it survives /reload and resume); a `tool_execution_end` handler
 *    commits the baseline + a `changes.touch` (post-hash, for drift detection).
 *  - Derivation (collectChangeset): folds the session branch into a per-file view,
 *    reconstructing history — including files edited *before* this extension was
 *    installed — from the session's own tool-call/tool-result entries.
 *
 * Nothing here needs git: diffs come from the SDK's generateUnifiedPatch, undo from
 * the captured baseline (see undo.ts).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBinary, readTextSnapshot } from "./fs-util.ts";

/** Files larger than this are tracked but not captured/undoable (session-file hygiene). */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export const BASELINE_TYPE = "changes.baseline";
export const TOUCH_TYPE = "changes.touch";
export const UNDONE_TYPE = "changes.undone";

interface BaselineData {
	v: number;
	path: string; // absolute
	existed: boolean;
	content: string | null;
	mode?: number;
	unrestorable?: boolean;
}
interface TouchData {
	v: number;
	path: string;
	tool: string;
	postHash: string;
}
interface UndoneData {
	v: number;
	path: string;
}

export type ChangeStatus = "created" | "modified" | "missing" | "reverted" | "baseline-unknown";

export interface RecordedEdit {
	oldText: string;
	newText: string;
}

export interface FileChange {
	abs: string;
	rel: string;
	status: ChangeStatus;
	/** Data source for labels and action availability. */
	source?: "session" | "git";
	/** Short source-specific state such as "staged + unstaged". */
	sourceLabel?: string;
	/** Precomputed diff supplied by the Git changes collector. */
	diffOverride?: string;
	/** Working directory to use for isolated review helpers. */
	reviewCwd?: string;
	/** Captured pre-agent state (undo target). Absent for baseline-unknown files. */
	baseline?: { existed: boolean; content: string | null; mode?: number; unrestorable: boolean };
	hasBaseline: boolean;
	/** Recorded per-call edits (oldest→newest) — used for baseline-unknown inverse-replay undo. */
	editCalls: RecordedEdit[];
	/** Number of recorded `write` calls (baseline-unknown diagnostics). */
	writeCalls: number;
	/** Per-call unified patches recorded by the edit tool (baseline-unknown diff fallback). */
	recordedPatches: string[];
	/** How many agent changes this file has seen (touch entries, else recorded calls). */
	changeCount: number;
	/** sha256 of the file right after the agent's last edit (drift detection). */
	lastPostHash: string | null;
	undone: boolean;
	/** Current on-disk content (null when missing / binary / too large). */
	current: string | null;
	currentExists: boolean;
	/** True when the file exists but couldn't be read as text (binary / oversized). */
	currentUnreadable: boolean;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Live capture ────────────────────────────────────────────────────────────

interface PendingCapture {
	abs: string;
	preExisted: boolean;
	preContent: string | null;
	preMode?: number;
	unrestorable: boolean;
}

export function registerTracker(pi: ExtensionAPI): void {
	// Pre-images keyed by toolCallId, awaiting their tool_execution_end.
	const pending = new Map<string, PendingCapture>();
	// Paths already baselined on the current branch (first-touch wins; sticky across undo).
	const baselined = new Set<string>();

	const reseed = (ctx: ExtensionContext) => {
		baselined.clear();
		pending.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === BASELINE_TYPE) {
				const d = entry.data as BaselineData | undefined;
				if (d?.path) baselined.add(d.path);
			}
		}
	};

	pi.on("session_start", (_event, ctx) => reseed(ctx));
	pi.on("session_tree", (_event, ctx) => reseed(ctx));
	pi.on("agent_end", () => pending.clear());

	// Fires BEFORE the tool mutates the file — capture the pre-image now.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string" || !rawPath) return;
		// Built-in file tools accept an @-prefixed mention path; mirror their
		// normalization so the baseline follows the file they actually mutate.
		const rel = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
		const abs = path.resolve(ctx.cwd, rel);

		let preExisted = false;
		let preContent: string | null = null;
		let preMode: number | undefined;
		let unrestorable = false;
		try {
			const stat = await fs.promises.lstat(abs);
			preExisted = true;
			preMode = stat.mode;
			// Restoring a symlink as a regular file would corrupt filesystem
			// structure, so record it but refuse automatic undo.
			if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CAPTURE_BYTES) {
				unrestorable = true;
			} else {
				const buf = await fs.promises.readFile(abs);
				if (isBinary(buf)) unrestorable = true;
				else preContent = buf.toString("utf8");
			}
		} catch {
			preExisted = false; // new file the agent is about to create
		}

		pending.set(event.toolCallId, {
			abs,
			preExisted,
			preContent,
			...(preMode !== undefined ? { preMode } : {}),
			unrestorable,
		});
	});

	// Fires after the tool ran — commit the capture only on success.
	pi.on("tool_execution_end", async (event) => {
		const cap = pending.get(event.toolCallId);
		if (!cap) return;
		pending.delete(event.toolCallId);
		if (event.isError) return;

		if (!baselined.has(cap.abs)) {
			baselined.add(cap.abs);
			const data: BaselineData = {
				v: 1,
				path: cap.abs,
				existed: cap.preExisted,
				content: cap.preContent,
				...(cap.preMode !== undefined ? { mode: cap.preMode } : {}),
			};
			if (cap.unrestorable) data.unrestorable = true;
			pi.appendEntry(BASELINE_TYPE, data);
		}

		let postHash = "";
		try {
			const stat = await fs.promises.stat(cap.abs);
			if (stat.isFile() && stat.size <= MAX_CAPTURE_BYTES) {
				const cur = await fs.promises.readFile(cap.abs);
				if (!isBinary(cur)) postHash = sha256(cur.toString("utf8"));
			}
		} catch {
			// Missing/unreadable post-image keeps an empty drift hash.
		}
		const touch: TouchData = { v: 1, path: cap.abs, tool: event.toolName, postHash };
		pi.appendEntry(TOUCH_TYPE, touch);
	});
}

// ── Derivation ────────────────────────────────────────────────────────────────

function blankChange(abs: string, cwd: string): FileChange {
	return {
		abs,
		rel: path.relative(cwd, abs) || abs,
		status: "modified",
		hasBaseline: false,
		editCalls: [],
		writeCalls: 0,
		recordedPatches: [],
		changeCount: 0,
		lastPostHash: null,
		undone: false,
		current: null,
		currentExists: false,
		currentUnreadable: false,
	};
}

/**
 * Fold the current session branch into a per-file changeset and classify each
 * file against the filesystem. Returns files in first-touch order.
 */
export function collectChangeset(ctx: ExtensionContext): FileChange[] {
	const cwd = ctx.cwd;
	const map = new Map<string, FileChange>();
	const get = (abs: string): FileChange => {
		let fc = map.get(abs);
		if (!fc) {
			fc = blankChange(abs, cwd);
			map.set(abs, fc);
		}
		return fc;
	};

	// Track recorded call counts separately so baseline-unknown files (no touch
	// entries) still show a change count.
	const recordedCalls = new Map<string, number>();
	const callById = new Map<string, { name: string; args: Record<string, unknown> }>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom") {
			if (entry.customType === BASELINE_TYPE) {
				const d = entry.data as BaselineData | undefined;
				if (!d?.path) continue;
				const fc = get(d.path);
				if (!fc.hasBaseline) {
					fc.hasBaseline = true;
					fc.baseline = {
						existed: d.existed,
						content: d.content,
						...(d.mode !== undefined ? { mode: d.mode } : {}),
						unrestorable: !!d.unrestorable,
					};
				}
			} else if (entry.customType === TOUCH_TYPE) {
				const d = entry.data as TouchData | undefined;
				if (!d?.path) continue;
				const fc = get(d.path);
				fc.changeCount++;
				fc.lastPostHash = d.postHash ?? null;
				fc.undone = false;
			} else if (entry.customType === UNDONE_TYPE) {
				const d = entry.data as UndoneData | undefined;
				if (!d?.path) continue;
				get(d.path).undone = true;
			}
			continue;
		}

		if (entry.type !== "message") continue;
		const m = entry.message as {
			role: string;
			content?: Array<{ type: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
			toolCallId?: string;
			toolName?: string;
			isError?: boolean;
			details?: { patch?: unknown };
		};

		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const part of m.content) {
				if (part.type === "toolCall" && (part.name === "edit" || part.name === "write") && part.id) {
					callById.set(part.id, { name: part.name, args: part.arguments ?? {} });
				}
			}
		} else if (m.role === "toolResult" && m.toolCallId) {
			const call = callById.get(m.toolCallId);
			if (!call) continue;
			callById.delete(m.toolCallId);
			if (m.isError) continue;
			const rawPath = call.args.path;
			if (typeof rawPath !== "string") continue;
			const relPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
			const abs = path.resolve(cwd, relPath);
			const fc = get(abs);
			recordedCalls.set(abs, (recordedCalls.get(abs) ?? 0) + 1);
			if (call.name === "edit") {
				const edits = Array.isArray(call.args.edits) ? call.args.edits : [];
				for (const e of edits) {
					if (e && typeof e.oldText === "string" && typeof e.newText === "string") {
						fc.editCalls.push({ oldText: e.oldText, newText: e.newText });
					}
				}
				const patch = m.details?.patch;
				if (typeof patch === "string" && patch.trim()) fc.recordedPatches.push(patch);
			} else {
				fc.writeCalls++;
			}
		}
	}

	// Classify each file against the current filesystem.
	for (const fc of map.values()) {
		const rec = recordedCalls.get(fc.abs) ?? 0;
		if (fc.changeCount === 0) fc.changeCount = rec;

		const read = readTextSnapshot(fc.abs, { maxBytes: MAX_CAPTURE_BYTES, missingOn: "stat-error" });
		fc.currentExists = read.exists;
		fc.current = read.text;
		fc.currentUnreadable = read.unreadable;

		if (!fc.hasBaseline) {
			fc.status = "baseline-unknown";
			continue;
		}
		const base = fc.baseline!;
		if (!base.existed) {
			// Agent created this file.
			if (!fc.currentExists) fc.status = fc.undone ? "reverted" : "missing";
			else fc.status = "created";
		} else {
			// File pre-existed the agent's first edit.
			if (!fc.currentExists) fc.status = "missing";
			else if (!fc.currentUnreadable && base.content !== null && fc.current === base.content)
				fc.status = "reverted";
			else fc.status = "modified";
		}
	}

	return [...map.values()];
}

/**
 * Raw unified-diff text for a file, git-free. Prefers a true baseline→current
 * diff; falls back to the agent's recorded per-call patches when the baseline
 * predates the extension.
 */
export function fileDiffText(fc: FileChange): string {
	if (fc.diffOverride !== undefined) return fc.diffOverride;
	if (fc.currentUnreadable) return "";
	if (fc.hasBaseline && fc.baseline && !fc.baseline.unrestorable) {
		const oldC = fc.baseline.content ?? "";
		const newC = fc.current ?? "";
		if (oldC === newC) return "";
		return generateUnifiedPatch(fc.rel, oldC, newC, 3);
	}
	if (fc.recordedPatches.length) return fc.recordedPatches.join("\n");
	return "";
}
