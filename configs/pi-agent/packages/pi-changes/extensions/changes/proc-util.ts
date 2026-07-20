/**
 * Shared child-process helpers for the two spawners (git collector, ask
 * subagent): process-group signalling and bounded stderr capture.
 */

import type { ChildProcess } from "node:child_process";

/** Keep this many trailing characters of child stderr for diagnostics. */
export const STDERR_CAP = 64 * 1024;

/**
 * Signal a detached child's whole process group where supported, falling back
 * to signalling just the child.
 */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try { child.kill(signal); } catch { /* already gone */ }
	}
}

/**
 * Append to a rolling diagnostic buffer, keeping only the most recent `cap`
 * characters so a noisy child can't grow memory without bound.
 */
export function appendCapped(buffer: string, chunk: string, cap: number = STDERR_CAP): string {
	return (buffer + chunk).slice(-cap);
}
