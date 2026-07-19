/**
 * Shared filesystem snapshot helpers used by the session tracker and the Git
 * collector. Both need "read this file as text, bounded, or explain why not".
 */

import * as fs from "node:fs";
import { capDisplayLines } from "./display.ts";

/** A NUL byte in the first 8KB is the usual "binary" heuristic. */
export function isBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

export interface TextSnapshot {
	exists: boolean;
	/** File content as UTF-8 (null when missing / binary / too large). */
	text: string | null;
	/** True when the file exists but couldn't be read as text. */
	unreadable: boolean;
}

export interface ReadTextOptions {
	/** Files larger than this are reported as existing but unreadable. */
	maxBytes: number;
	/** Cap the returned text to this many lines, appending the marker. */
	capLines?: { maxLines: number; marker: string };
	/** Use lstat so symlinks count as unreadable instead of being followed. */
	noFollow?: boolean;
	/**
	 * When a file counts as missing:
	 *  - "stat-error": any stat failure → missing; read failures → unreadable
	 *    (session-tracker semantics).
	 *  - "enoent": ENOENT from stat or read → missing; other errors → unreadable
	 *    (git working-tree semantics).
	 */
	missingOn: "stat-error" | "enoent";
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Read a file as bounded text, reporting existence and text-readability. */
export function readTextSnapshot(abs: string, opts: ReadTextOptions): TextSnapshot {
	let stat: fs.Stats;
	try {
		stat = opts.noFollow ? fs.lstatSync(abs) : fs.statSync(abs);
	} catch (error) {
		if (opts.missingOn === "stat-error" || isEnoent(error)) {
			return { exists: false, text: null, unreadable: false };
		}
		return { exists: true, text: null, unreadable: true };
	}
	if (!stat.isFile() || stat.size > opts.maxBytes) return { exists: true, text: null, unreadable: true };
	try {
		const buf = fs.readFileSync(abs);
		if (isBinary(buf)) return { exists: true, text: null, unreadable: true };
		let text = buf.toString("utf8");
		if (opts.capLines) text = capDisplayLines(text, opts.capLines.maxLines, opts.capLines.marker);
		return { exists: true, text, unreadable: false };
	} catch (error) {
		if (opts.missingOn === "enoent" && isEnoent(error)) {
			return { exists: false, text: null, unreadable: false };
		}
		return { exists: true, text: null, unreadable: true };
	}
}
