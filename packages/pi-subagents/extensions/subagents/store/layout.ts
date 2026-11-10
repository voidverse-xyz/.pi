/**
 * store/layout.ts — the SINGLE path authority.
 *
 * Every disk path the extension touches is derived here and nowhere else. No
 * other module calls join() on a state path; they take a `Layout` or the pure
 * helpers below.
 *
 * On-disk shape: flat, session-scoped, on local fs.
 *
 *   ~/.pi/agent/sessions/<cwd-slug>/                # Pi's per-project dir
 *     <timestamp>_<uuid>.jsonl                      # main sessions (untouched)
 *     subagents/<sessionId>/                        # ONE owning main session
 *       scope.json  .host-owner.json                # ownership + host lease
 *       registry.json
 *       .main/mailbox/  (.done/ + .corrupt/)
 *       .main/open-tasks.json                       # anchor index for await-all
 *       .archive/<type>/<id>/
 *       <type>/<id>/
 *         <timestamp>_<uuid>.jsonl                  # REAL Pi session format
 *         def.md                                    # ad-hoc constitution (adhoc/* only)
 *         mailbox/  (.done/ + .corrupt/)
 *
 * `<sessionId>` is globally unique, so no cwd-digest is needed — distinct
 * projects/sessions can never collide. Type-definition discovery dirs also live
 * here — they are paths.
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
 * wake digest labels it as such. Used uniformly for agent AND main mailboxes.
 */
export function attemptMarkerOf(envelopeFile: string): string {
	return `${envelopeFile}.attempt`;
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
	/** Override $HOME-derived agent directory (tests). */
	home?: string;
	/** Override Pi's effective agent directory directly (tests / embedding). */
	agentDir?: string;
	/** Override the subagents state root directly (tests / ephemeral). */
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
	/** Exclusive live-host owner marker (single host lease). */
	readonly hostOwnerFile: string;
	/** <subagentsRoot>/registry.json */
	readonly registryFile: string;
	/** <subagentsRoot>/.main/mailbox — the main agent's mailbox. */
	readonly mainMailboxDir: string;
	/** <subagentsRoot>/.main/open-tasks.json — the anchor index for await-all. */
	readonly openTasksFile: string;
	/** <subagentsRoot>/.archive */
	readonly archiveRoot: string;

	/** <subagentsRoot>/<type>/<id> — an agent instance's dir. */
	agentInstanceDir(type: string, id: string): string;
	/** <agent>/mailbox */
	mailboxDir(type: string, id: string): string;
	/** <agent>/def.md — the synthesized constitution of an ad-hoc instance. */
	adhocDefFile(type: string, id: string): string;
	/** <archiveRoot>/<type>/<id> — where retire moves an agent dir. */
	archiveDir(type: string, id: string): string;

	/** ~/.pi/agent/subagents — global type-definition library. */
	readonly globalTypeDefsDir: string;
	/** <cwd>/.pi/subagents — repo-shipped type definitions (wins on conflict). */
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
	const agentDir = options.agentDir ?? join(options.home ?? homedir(), ".pi", "agent");
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
		openTasksFile: join(subagentsRoot, ".main", "open-tasks.json"),
		archiveRoot,

		agentInstanceDir,
		mailboxDir,
		adhocDefFile: (type, id) => join(agentInstanceDir(type, id), "def.md"),
		archiveDir: (type, id) => join(archiveRoot, type, id),

		globalTypeDefsDir,
		projectTypeDefsDir,
		typeDefFile: (dir, typeName) => join(dir, `${typeName}.md`),

		globalSettingsFile: settingsFileSiblingOf(globalTypeDefsDir),
		projectSettingsFile: settingsFileSiblingOf(projectTypeDefsDir),
	};
}
