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
 *     teams/<sessionId>/                            # ONE owning main session
 *       scope.json  .host-owner.json                # ownership + host lease
 *       registry.json
 *       .main/mailbox/  (.done/ + sender indexes)
 *       .archive/<type>/<id>/
 *       <type>/<id>/
 *         <timestamp>_<uuid>.jsonl                  # REAL Pi session format
 *         mailbox/  (.done/ + .corrupt/)
 *
 * `<sessionId>` is globally unique, so no cwd-digest is needed — distinct
 * projects/sessions can never collide (v1 finding #6 gone by construction).
 * Type-definition discovery dirs (D6) also live here — they are paths.
 *
 * `<cwd-slug>` is computed EXACTLY the way Pi does, so our subtree sits beside
 * Pi's own sessions dir for the project.
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
 * e.g. /home/user → --home-user--
 */
export function cwdSlug(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
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

/** <mailboxDir>/<envelopeId>.json — an envelope's file (pending). */
export function envelopeFileOf(mailboxDir: string, envelopeId: string): string {
	return join(mailboxDir, `${envelopeId}.json`);
}

/** <mailboxDir>/.done/<envelopeId>.json — a processed envelope. */
export function doneEnvelopeFileOf(mailboxDir: string, envelopeId: string): string {
	return join(mailboxDoneDirOf(mailboxDir), `${envelopeId}.json`);
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

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LayoutOptions {
	/** Stable owning main Pi session id (`ctx.sessionManager.getSessionId()`). */
	sessionId: string;
	/** Override $HOME-derived agent directory (tests). */
	home?: string;
	/** Override Pi's effective agent directory directly (tests / embedding). */
	agentDir?: string;
	/** Override the teams state root directly (tests / ephemeral). */
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
	/** ~/.pi/agent/sessions/<cwd-slug>/teams — parent of all session scopes for this project. */
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
	/** <archiveRoot>/<type>/<id> — where retire moves an agent dir (D13). */
	archiveDir(type: string, id: string): string;

	/** ~/.pi/agent/subagents — shared global type-definition library (D6). */
	readonly globalTypeDefsDir: string;
	/** <cwd>/.pi/subagents — shared repo-shipped definitions (D6; wins on conflict). */
	readonly projectTypeDefsDir: string;
	/** A type definition file inside either discovery dir. */
	typeDefFile(dir: string, typeName: string): string;

	/** ~/.pi/agent/teams.json — global extension settings. */
	readonly globalSettingsFile: string;
	/** <cwd>/.pi/teams.json — per-project overrides. */
	readonly projectSettingsFile: string;
}

const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Build the full path layout for a project cwd and owning main session. */
export function createLayout(cwd: string, options: LayoutOptions): Layout {
	if (!SESSION_ID_RE.test(options.sessionId) || options.sessionId === "." || options.sessionId === "..") {
		throw new Error(`Invalid main session id ${JSON.stringify(options.sessionId)}.`);
	}
	const agentDir = options.agentDir ?? join(options.home ?? homedir(), ".pi", "agent");
	// ~/.pi/agent/sessions/<cwd-slug> — Pi's own per-project sessions dir; our
	// teams subtree sits beside Pi's main-session JSONLs inside it.
	const projectSessionDir = join(agentDir, "sessions", cwdSlug(cwd));
	const projectSubagentsRoot = join(projectSessionDir, "teams");
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
		projectSubagentsRoot,
		subagentsRoot,
		scopeManifestFile: join(subagentsRoot, "scope.json"),
		hostOwnerFile: join(subagentsRoot, ".host-owner.json"),
		registryFile: join(subagentsRoot, "registry.json"),
		mainMailboxDir,
		archiveRoot,

		agentInstanceDir,
		mailboxDir,
		archiveDir: (type, id) => join(archiveRoot, type, id),

		globalTypeDefsDir,
		projectTypeDefsDir,
		typeDefFile: (dir, typeName) => join(dir, `${typeName}.md`),

		globalSettingsFile: join(agentDir, "teams.json"),
		projectSettingsFile: join(cwd, ".pi", "teams.json"),
	};
}
