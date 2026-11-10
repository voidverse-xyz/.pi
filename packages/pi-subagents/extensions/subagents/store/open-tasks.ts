/**
 * store/open-tasks.ts — the anchor index for await-all.
 *
 * Every task-bearing envelope from main (a spawn `task` or a subagent_send)
 * records an entry here, keyed by the envelope id (= the await anchor). An
 * entry is closed when a terminal envelope explicitly names its anchor. The
 * runtime stamps each final report/error with the exact task snapshot drained
 * into that turn, so mail held for a later turn cannot be closed early.
 * Retirement still closes every task for the retired address.
 *
 * Self-healing: entries are pruned on read when their anchor id is malformed.
 * Entries for retired agents are closed by the runtime's retire path; a crash
 * between mailbox commit and close is repaired lazily by closeAllFor on the
 * next final-report consumption or retire.
 *
 * Single writer (host lease); crash-atomic via atomicWriteJson.
 */

import { readFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { atomicWriteJson } from "./atomic.ts";
import { ENVELOPE_ID_RE } from "../mail/envelope.ts";
import { ellipsize } from "../text.ts";

export interface OpenTask {
	/** The agent address `<type>/<id>` the task was sent to. */
	to: string;
	/** First ~120 chars of the task text (human-readable await labels). */
	snippet: string;
	/** ISO timestamp when the task envelope was delivered. */
	openedAt: string;
}

export type OpenTasks = Record<string, OpenTask>;

const SNIPPET_MAX = 120;

export function taskSnippet(text: string): string {
	return ellipsize(text.replace(/\s+/g, " ").trim(), SNIPPET_MAX);
}

/** Read the index; missing → empty. A corrupt file is moved aside, never clobbered. */
export function readOpenTasks(path: string): OpenTasks {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		try {
			renameSync(path, `${path}.corrupt-${randomBytes(4).toString("hex")}`);
		} catch {
			/* best effort */
		}
		return {};
	}
	const out: OpenTasks = {};
	for (const [anchorId, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!ENVELOPE_ID_RE.test(anchorId)) continue;
		if (typeof value !== "object" || value === null) continue;
		const v = value as Record<string, unknown>;
		if (typeof v.to !== "string" || typeof v.openedAt !== "string") continue;
		out[anchorId] = { to: v.to, snippet: typeof v.snippet === "string" ? v.snippet : "", openedAt: v.openedAt };
	}
	return out;
}

/** Record a newly-opened task anchor. */
export function recordOpenTask(path: string, anchorId: string, task: OpenTask): void {
	const map = readOpenTasks(path);
	map[anchorId] = { ...task, snippet: taskSnippet(task.snippet) };
	atomicWriteJson(path, map);
}

/** Close one anchor (no-op if absent). */
export function closeOpenTask(path: string, anchorId: string): void {
	const map = readOpenTasks(path);
	if (anchorId in map) {
		delete map[anchorId];
		atomicWriteJson(path, map);
	}
}

/** Close every open task addressed to `to` (retirement and legacy recovery). */
export function closeAllFor(path: string, to: string): string[] {
	const map = readOpenTasks(path);
	const closed = Object.entries(map)
		.filter(([, task]) => task.to === to)
		.map(([anchorId]) => anchorId);
	if (closed.length > 0) {
		for (const anchorId of closed) delete map[anchorId];
		atomicWriteJson(path, map);
	}
	return closed;
}
