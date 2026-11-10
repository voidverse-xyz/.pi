import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SEGMENT_SPLIT_RE, type Category } from "./categories.ts";

export const AUDIT_PATH = join(getAgentDir(), "safety-audit.jsonl");
const MAX_AUDIT_BYTES = 1024 * 1024;
const RETAIN_LINES = 1000;

export interface AuditEntry {
	ts: string;
	/** Executable names only; arguments are intentionally never persisted. */
	command: string;
	commandHash: string;
	category: Category | "read-only";
	mode: string;
	decision: "auto-allowed" | "approved" | "denied";
	source: "user" | "auto";
}

function summarizeCommand(command: string): { command: string; commandHash: string } {
	const commandHash = createHash("sha256").update(command).digest("hex").slice(0, 16);
	const heads = command
		.split(SEGMENT_SPLIT_RE)
		.map((segment) => segment.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:['"]?[^\s/'"]+\/)*['"]?([^\s'"]+)/)?.[1])
		.filter((value): value is string => Boolean(value))
		.slice(0, 8);
	return { command: heads.length ? heads.join(" | ") : "(unparsed)", commandHash };
}

function rotateIfNeeded(): void {
	if (!existsSync(AUDIT_PATH) || statSync(AUDIT_PATH).size < MAX_AUDIT_BYTES) return;
	const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean).slice(-RETAIN_LINES);
	const temp = `${AUDIT_PATH}.tmp-${process.pid}`;
	writeFileSync(temp, `${lines.join("\n")}\n`, { mode: 0o600 });
	renameSync(temp, AUDIT_PATH);
}

export function auditLog(entry: Omit<AuditEntry, "ts" | "command" | "commandHash"> & { rawCommand: string }): void {
	try {
		mkdirSync(dirname(AUDIT_PATH), { recursive: true });
		if (existsSync(AUDIT_PATH) && lstatSync(AUDIT_PATH).isSymbolicLink()) return;
		rotateIfNeeded();
		const { rawCommand, ...rest } = entry;
		appendFileSync(
			AUDIT_PATH,
			`${JSON.stringify({ ts: new Date().toISOString(), ...summarizeCommand(rawCommand), ...rest })}\n`,
			{ mode: 0o600 },
		);
		chmodSync(AUDIT_PATH, 0o600);
	} catch {
		// Auditing is best-effort and must never alter tool-call behavior.
	}
}

export function readRecentEntries(limit: number): AuditEntry[] {
	try {
		if (existsSync(AUDIT_PATH) && lstatSync(AUDIT_PATH).isSymbolicLink()) return [];
		const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean).slice(-Math.max(0, limit));
		return lines.flatMap((line) => {
			try {
				const value = JSON.parse(line) as AuditEntry;
				return value && typeof value.command === "string" ? [value] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}
