/**
 * store/layout.ts — the SINGLE path authority (D23 structural rule).
 *
 * Every disk path the extension touches is derived here and nowhere else. No
 * other module calls join() on a state path; they take a `Layout` or the pure
 * helpers below. (v1's "single authority" leaked — `.corrupt`/`.lock` names were
 * invented in other modules. v2 keeps them ALL here.)
 *
 * On-disk shape (D3'): flat, session-scoped, on local fs.
 *
 *   ~/.pi/agent/sessions/<cwd-slug>/                # Pi's per-project dir
 *     <timestamp>_<uuid>.jsonl                      # main sessions (untouched)
 *     subagents/<sessionId>/                        # ONE owning main session
 *       scope.json  .host-owner.json                # ownership + host lease
 *       registry.json
 *       .main/mailbox/  (.done/ + sender indexes)
 *       .archive/<type>/<id>/
 *       <type>/<id>/
 *         <timestamp>_<uuid>.jsonl                  # REAL Pi session format
 *         mailbox/  (.done/ + .corrupt/)  files/
 *
 * `<sessionId>` is globally unique, so no cwd-digest is needed — distinct
 * projects/sessions can never collide (v1 finding #6 gone by construction).
 * Type-definition discovery dirs (D6) also live here — they are paths.
 *
 * `<cwd-slug>` and the session filename are computed EXACTLY the way Pi does, so
 * our subtree sits beside Pi's own sessions and subagent JSONL files are
 * openable by Pi itself.
 *
 * Pure module: no fs access, no side effects — path math only.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Pure helpers (Pi-compatible naming)
// ---------------------------------------------------------------------------

/**
 * Pi's cwd → session-dir-name encoding, byte-for-byte:
 *   `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 * e.g. /home/john → --home-john--
 */
export function cwdSlug(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Pi's session filename: ISO timestamp with `:` and `.` replaced by `-`,
 * underscore, session uuid, `.jsonl`.
 */
export function sessionFileName(timestamp: Date | string, sessionId: string): string {
	const iso = typeof timestamp === "string" ? timestamp : timestamp.toISOString();
	return `${iso.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

// ---------------------------------------------------------------------------
// Mailbox-relative paths (pure helpers)
//
// Mailbox internals key off a mailbox dir (agent or .main) so mail/mailbox.ts
// works identically for both. They live here — the single path authority.
// ---------------------------------------------------------------------------

/** <mailboxDir>/.done — processed envelopes (audit, N-day GC). */
export function mailboxDoneDirOf(mailboxDir: string): string {
	return join(mailboxDir, ".done");
}

/** <mailboxDir>/.corrupt — quarantined unparseable/mismatched envelopes. */
export function mailboxCorruptDirOf(mailboxDir: string): string {
	return join(mailboxDir, ".corrupt");
}

/**
 * <envelopeFile>.attempt — delivery-attempt marker (at-least-once): stamped
 * before the receiving turn runs, removed on markDone. A marker present at read
 * time means a RE-delivery (crash between delivery and the durable append); the
 * wake digest labels it as such. Used uniformly for agent AND main mailboxes —
 * v2 drops v1's separate `.delivering`/JSONL-verify protocol.
 */
export function attemptMarkerOf(envelopeFile: string): string {
	return `${envelopeFile}.attempt`;
}

/** <mailboxDir>/.sent-questions.json — sender-side question index (id → text). */
export function sentQuestionsFileOf(mailboxDir: string): string {
	return join(mailboxDir, ".sent-questions.json");
}

/** <mailboxDir>/.collect-requests.json — outstanding collect requests (id → schema). */
export function collectRequestsFileOf(mailboxDir: string): string {
	return join(mailboxDir, ".collect-requests.json");
}

/** <mainMailboxDir>/.await-anchors.json — durable anchor→recipient-generation index (D26'). */
export function awaitAnchorsFileOf(mailboxDir: string): string {
	return join(mailboxDir, ".await-anchors.json");
}

/** <typeDefsDir>.json — the settings-file sibling of a type-def dir. */
export function settingsFileSiblingOf(typeDefsDir: string): string {
	return `${typeDefsDir}.json`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LayoutOptions {
	/** Stable owning main Pi session id (`ctx.sessionManager.getSessionId()`). */
	sessionId: string;
	/** Override $HOME (tests). Defaults to os.homedir(). */
	home?: string;
	/** Override the subagents root directly (tests / ephemeral). */
	subagentsRoot?: string;
}

/** Every path the extension uses, for one project and owning main session. */
export interface Layout {
	/** The project cwd this layout is for (as given). */
	readonly cwd: string;
	/** Stable owner of every mutable path in this layout. */
	readonly ownerSessionId: string;
	/** ~/.pi/agent */
	readonly agentDir: string;
	/** ~/.pi/agent/sessions */
	readonly sessionsRoot: string;
	/** ~/.pi/agent/sessions/<cwd-slug> — Pi's own dir for this project. */
	readonly projectSessionDir: string;
	/** <projectSessionDir>/subagents — parent of all session scopes for this project. */
	readonly projectSubagentsRoot: string;
	/** <projectSubagentsRoot>/<sessionId> — root of all mutable state for this conversation. */
	readonly subagentsRoot: string;
	/** Owner/scope metadata (cwd + ownerSessionId; fork non-inheritance check). */
	readonly scopeManifestFile: string;
	/** Exclusive live-host owner marker (single host lease, D7). */
	readonly hostOwnerFile: string;
	/** <subagentsRoot>/registry.json */
	readonly registryFile: string;
	/** <subagentsRoot>/.main/mailbox — the main agent's mailbox. */
	readonly mainMailboxDir: string;
	/** <subagentsRoot>/.archive */
	readonly archiveRoot: string;

	/** <subagentsRoot>/<type>/<id> — an agent instance's dir. */
	agentInstanceDir(type: string, id: string): string;
	/** <agent>/mailbox */
	mailboxDir(type: string, id: string): string;
	/** <agent>/files */
	filesDir(type: string, id: string): string;
	/** Durable current main-assignment anchor for final-report correlation. */
	assignmentAnchorFile(type: string, id: string): string;
	/** Durable retirement intent (manual or oneshot final), recovered at startup. */
	retireRequestedFile(type: string, id: string): string;
	/** <agent>/<timestamp>_<uuid>.jsonl — Pi-native session file. */
	sessionFilePath(type: string, id: string, timestamp: Date | string, sessionId: string): string;
	/** An envelope's file inside a mailbox dir: <mailboxDir>/<msg-id>.json */
	envelopeFile(mailboxDir: string, envelopeId: string): string;
	/** <archiveRoot>/<type>/<id> — where retire moves an agent dir (D13). */
	archiveDir(type: string, id: string): string;

	/** ~/.pi/agent/subagents — global type-definition library (D6). */
	readonly globalTypeDefsDir: string;
	/** <cwd>/.pi/subagents — repo-shipped type definitions (D6; wins on conflict). */
	readonly projectTypeDefsDir: string;
	/** A type definition file inside either discovery dir. */
	typeDefFile(dir: string, typeName: string): string;

	/** ~/.pi/agent/subagents.json — global extension settings. */
	readonly globalSettingsFile: string;
	/** <cwd>/.pi/subagents.json — per-project overrides. */
	readonly projectSettingsFile: string;
}

const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Build the full path layout for a project cwd and owning main session. */
export function createLayout(cwd: string, options: LayoutOptions): Layout {
	if (!SESSION_ID_RE.test(options.sessionId) || options.sessionId === "." || options.sessionId === "..") {
		throw new Error(`Invalid main session id ${JSON.stringify(options.sessionId)}.`);
	}
	const home = options.home ?? homedir();
	const agentDir = join(home, ".pi", "agent");
	const sessionsRoot = join(agentDir, "sessions");
	const projectSessionDir = join(sessionsRoot, cwdSlug(cwd));
	const projectSubagentsRoot = join(projectSessionDir, "subagents");
	const subagentsRoot = options.subagentsRoot ?? join(projectSubagentsRoot, options.sessionId);
	const archiveRoot = join(subagentsRoot, ".archive");
	const mainMailboxDir = join(subagentsRoot, ".main", "mailbox");

	const globalTypeDefsDir = join(agentDir, "subagents");
	const projectTypeDefsDir = join(cwd, ".pi", "subagents");

	const agentInstanceDir = (type: string, id: string): string => join(subagentsRoot, type, id);
	const mailboxDir = (type: string, id: string): string => join(agentInstanceDir(type, id), "mailbox");

	return {
		cwd,
		ownerSessionId: options.sessionId,
		agentDir,
		sessionsRoot,
		projectSessionDir,
		projectSubagentsRoot,
		subagentsRoot,
		scopeManifestFile: join(subagentsRoot, "scope.json"),
		hostOwnerFile: join(subagentsRoot, ".host-owner.json"),
		registryFile: join(subagentsRoot, "registry.json"),
		mainMailboxDir,
		archiveRoot,

		agentInstanceDir,
		mailboxDir,
		filesDir: (type, id) => join(agentInstanceDir(type, id), "files"),
		assignmentAnchorFile: (type, id) => join(agentInstanceDir(type, id), ".assignment-anchor"),
		retireRequestedFile: (type, id) => join(agentInstanceDir(type, id), ".retire-requested"),
		sessionFilePath: (type, id, timestamp, sessionId) =>
			join(agentInstanceDir(type, id), sessionFileName(timestamp, sessionId)),
		envelopeFile: (dir, envelopeId) => join(dir, `${envelopeId}.json`),
		archiveDir: (type, id) => join(archiveRoot, type, id),

		globalTypeDefsDir,
		projectTypeDefsDir,
		typeDefFile: (dir, typeName) => join(dir, `${typeName}.md`),

		globalSettingsFile: settingsFileSiblingOf(globalTypeDefsDir),
		projectSettingsFile: settingsFileSiblingOf(projectTypeDefsDir),
	};
}
