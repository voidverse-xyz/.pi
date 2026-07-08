/**
 * Session-scoped "subagent persistence" — a per-session toggle (set from /agents)
 * that changes how the delegation tool runs an agent:
 *
 *   - OFF (default): each `delegate {agent, task}` runs a fresh `--no-session` child,
 *     as it always has — the agent starts blank every call.
 *   - ON: single-mode delegation to a given agent runs in a PERSISTENT child session
 *     keyed by that agent's name, linked to this (hub) session via parentSession. The
 *     first call creates it; later calls to the SAME agent resume it, so the agent keeps
 *     the context of everything it did for you before. You revisit the same subagent to
 *     do related follow-up work instead of re-explaining from scratch.
 *
 * Persistence applies to SINGLE-mode delegation only. Parallel/chain stay ephemeral
 * (`--no-session`): they are fan-out/pipeline patterns, not a durable collaborator, and
 * keeping them ephemeral also avoids two children writing one session file at once.
 *
 * The toggle is stored on the session (a custom entry, like the active-agent switch), so
 * it survives /reload and resume. switcher.ts owns the command + persistence; this module
 * owns the in-process flag and the session-file plumbing shared with delegate.ts.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { CURRENT_SESSION_VERSION, type ExtensionContext, type SessionHeader, SessionManager } from "@earendil-works/pi-coding-agent";

/** Session entry customType holding the persistence toggle (restored on session_start). */
export const PERSISTENCE_ENTRY = "subagent-persistence";
const CUSTOM_TYPE = "subagents:persistent-session";

// In-process flag. switcher.ts sets it (from the command, and from session_start restore);
// delegate.ts reads it. Top-level only — nested children never enable persistence.
let enabled = false;
export function isPersistenceEnabled(): boolean {
	return enabled;
}
export function setPersistenceEnabled(value: boolean): void {
	enabled = value;
}

export interface HubSession {
	cwd: string;
	sessionDir: string;
	sessionFile?: string;
	sessionId: string;
}

export function hubFromCtx(ctx: ExtensionContext): HubSession {
	return {
		cwd: ctx.sessionManager.getCwd() || ctx.cwd,
		sessionDir: ctx.sessionManager.getSessionDir(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		sessionId: ctx.sessionManager.getSessionId(),
	};
}

/** A session-id-safe slug for an agent name (starts/ends alphanumeric). */
function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "agent";
}

function hubTag(hubId: string): string {
	const clean = hubId.replace(/[^A-Za-z0-9]/g, "");
	return (clean || "hub").slice(0, 8);
}

/** Deterministic session id for a given hub + agent, so the same agent always maps to one session. */
export function persistentSessionId(hubId: string, agentName: string): string {
	return `sub-${hubTag(hubId)}-${slugify(agentName)}`;
}

function displayName(agentName: string): string {
	return `subagent: ${agentName}`;
}

// Serialize find-or-create + run per (hub, agent) so two concurrent single-mode calls to
// the same agent never both create the file or append to it at once. Different agents run
// concurrently. Keyed by the deterministic session id.
const locks = new Map<string, Promise<unknown>>();
export function withAgentLock<T>(hub: HubSession, agentName: string, fn: () => Promise<T>): Promise<T> {
	const key = persistentSessionId(hub.sessionId, agentName);
	const prev = locks.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	locks.set(
		key,
		next.catch(() => {}),
	);
	return next;
}

/**
 * Find this hub's persistent session for `agentName`, creating it if absent. Returns the
 * session file path (absolute) and whether it was just created.
 *
 * The initial file is written directly (header with parentSession + a session_info name +
 * a marker custom entry) because SessionManager does not flush an assistant-less session to
 * disk, yet the child `pi --session <file>` needs the file to exist first. Only documented
 * entry shapes + the exported CURRENT_SESSION_VERSION are used. The child then opens this
 * non-empty file (flushed=true) and appends its turns; the next run resumes with full context.
 *
 * Call inside withAgentLock() so concurrent same-agent calls don't race on creation.
 */
export async function resolvePersistentSessionFile(hub: HubSession, agentName: string): Promise<{ file: string; created: boolean }> {
	const id = persistentSessionId(hub.sessionId, agentName);
	const sessions = await SessionManager.list(hub.cwd, hub.sessionDir);
	const existing = sessions.find((s) => s.id === id);
	if (existing) return { file: existing.path, created: false };

	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp,
		cwd: resolvePath(hub.cwd),
		parentSession: hub.sessionFile,
	};
	const infoId = randomUUID().slice(0, 8);
	const markId = randomUUID().slice(0, 8);
	const infoEntry = { type: "session_info", id: infoId, parentId: null, timestamp, name: displayName(agentName) };
	const markEntry = {
		type: "custom",
		customType: CUSTOM_TYPE,
		data: { agent: agentName, hubFile: hub.sessionFile, createdAt: timestamp },
		id: markId,
		parentId: infoId,
		timestamp,
	};

	const dir = resolvePath(hub.sessionDir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const file = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	writeFileSync(file, [header, infoEntry, markEntry].map((e) => JSON.stringify(e)).join("\n") + "\n", { encoding: "utf-8" });
	return { file, created: true };
}
