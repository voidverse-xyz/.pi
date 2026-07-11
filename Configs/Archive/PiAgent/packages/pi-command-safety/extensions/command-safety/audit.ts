/**
 * Audit log for command-safety decisions.
 *
 * Every decision the extension makes about an agent `bash` command — auto-allowed
 * read-only builtin, auto-allowed because the current mode doesn't gate its
 * category, user-approved, user-denied, or blocked headless with no one to ask —
 * is appended as one JSON line to `<agent-dir>/command-safety-audit.jsonl`
 * (~/.pi/agent/command-safety-audit.jsonl, the real home like the mode config).
 *
 * Entry shape: { ts, command, category, mode, decision, source, forwarded }
 *   - decision: "auto-allowed" | "approved" | "denied"
 *   - source:   "user" (a human confirmed/declined) | "auto" (no human involved)
 *   - forwarded: true when the confirmation round-tripped from a headless
 *     subagent up to the parent's TUI via the optional `ipc` extension.
 *
 * Writes are strictly best-effort: any failure is swallowed so auditing can
 * never break command execution. The file grows unbounded — no rotation yet.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Category } from "./categories.ts";

export const AUDIT_PATH = join(getAgentDir(), "command-safety-audit.jsonl");

export interface AuditEntry {
	/** ISO timestamp of the decision. */
	ts: string;
	/** The full command line the agent tried to run. */
	command: string;
	/** Classified category, or "read-only" for known read-only builtins. */
	category: Category | "read-only";
	/** Safety mode ("off" | "on" | "max") in effect when the decision was made. */
	mode: string;
	/** What happened to the command. */
	decision: "auto-allowed" | "approved" | "denied";
	/** Whether a human made the call ("user") or it never reached one ("auto"). */
	source: "user" | "auto";
	/** True when the confirmation came from a headless subagent via the ipc extension. */
	forwarded: boolean;
}

/** Append one decision to the audit log. Never throws — failures are swallowed. */
export function auditLog(entry: Omit<AuditEntry, "ts">): void {
	try {
		const dir = dirname(AUDIT_PATH);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(AUDIT_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch {
		// Best effort: auditing must never break command execution.
	}
}

/** Read the last `limit` entries, oldest first. Missing/corrupt data → fewer entries. */
export function readRecentEntries(limit: number): AuditEntry[] {
	try {
		const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter((l) => l.trim() !== "");
		const entries: AuditEntry[] = [];
		for (const line of lines.slice(-limit)) {
			try {
				entries.push(JSON.parse(line) as AuditEntry);
			} catch {
				// Skip corrupt lines rather than failing the whole read.
			}
		}
		return entries;
	} catch {
		return [];
	}
}
