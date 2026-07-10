/**
 * store/layout.ts — the SINGLE path authority (D23 structural rule 2).
 *
 * Every disk path the extension ever touches is derived here and nowhere else:
 * "the directory is the truth" (D3/D5/D13) only holds if no other module invents
 * paths. All other modules take a `Layout` (or the pure helpers below) and never
 * call join() on state paths themselves.
 *
 * On-disk shape (D3/D5/D13, 02-envelope-contract):
 *
 *   ~/.pi/agent/sessions/<cwd-slug>/          # Pi's own per-project session dir
 *     <timestamp>_<uuid>.jsonl                # main agent sessions (untouched)
 *     subagents/
 *       registry.json                         # roster (store/registry.ts)
 *       teams.json                            # membership (store/teams.ts)
 *       .main/mailbox/                        # main agent's mailbox (+ .done/)
 *       .archive/<type>/<id>/                 # retired agents, N-day GC
 *       <type>/<id>/                          # one dir per agent instance
 *         <timestamp>_<uuid>.jsonl            # REAL Pi session format (resumable)
 *         mailbox/                            # inbound envelopes, one file each
 *         mailbox/.done/                      # processed mail (audit, GC'd)
 *         files/                              # non-session artifacts
 *
 * Type-definition discovery dirs (D6) also live here — they are paths.
 *
 * <cwd-slug> and the session filename are computed EXACTLY the way Pi does
 * (verified against @earendil-works/pi-agent-core dist/harness/session/
 * jsonl-repo.js `encodeCwd` and `createSessionFilePath`), so our subagents/
 * subtree sits beside Pi's own sessions and subagent JSONL files are openable
 * by Pi itself.
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
 * e.g. 2026-07-06T22-32-38-193Z_019f398f-e031-71c5-99dd-a9c81af42b22.jsonl
 */
export function sessionFileName(timestamp: Date | string, sessionId: string): string {
	const iso = typeof timestamp === "string" ? timestamp : timestamp.toISOString();
	return `${iso.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

// ---------------------------------------------------------------------------
// Mailbox-relative paths (pure helpers)
//
// Mailbox internals are keyed off a mailbox dir (agent or .main) rather than
// (type, id) so mail/mailbox.ts works identically for both. They live here —
// the single path authority — so mailbox.ts never invents paths.
// ---------------------------------------------------------------------------

/** <mailboxDir>/.done — processed envelopes (audit, N-day GC). */
export function mailboxDoneDirOf(mailboxDir: string): string {
	return join(mailboxDir, ".done");
}

/**
 * <mailboxDir>/.delivering — envelopes whose digest was handed to the HOST
 * for injection but whose durable append to the main session JSONL is not yet
 * verified (the main-mailbox at-least-once gap). Each envelope file has a
 * sibling meta (deliveringMetaOf) recording the target session file; the next
 * reconciliation either finalizes to .done (digest found in the JSONL) or
 * requeues as pending (crash lost it). Only the MAIN mailbox uses this —
 * subagent mailboxes markDone directly after their runtime-owned append.
 */
export function mailboxDeliveringDirOf(mailboxDir: string): string {
	return join(mailboxDir, ".delivering");
}

/**
 * <deliveringEnvelopeFile>.meta — JSON `{ sessionFile, recordedAt }` naming
 * the main session JSONL the digest for this envelope was injected into.
 * Written BEFORE the envelope moves into .delivering/ (a crash between the
 * two leaves the envelope pending — at-least-once, never lost).
 */
export function deliveringMetaOf(envelopeFile: string): string {
	return `${envelopeFile}.meta`;
}

/**
 * <envelopeFile>.attempt — delivery-attempt marker (at-least-once): stamped
 * before the receiving turn runs, removed on markDone. An envelope whose
 * marker already exists at read time is a RE-delivery (crash between delivery
 * and the session append) and the wake digest labels it as such.
 */
export function attemptMarkerOf(envelopeFile: string): string {
	return `${envelopeFile}.attempt`;
}

/**
 * <mailboxDir>/.sent-questions.json — the sender-side question index
 * (envelopeId → question text). The wake digest quotes each answer's original
 * question via correlationId lookup (D14); the question envelope itself lives
 * in the RECIPIENT's mailbox, so the asker keeps its own copy here.
 */
export function sentQuestionsFileOf(mailboxDir: string): string {
	return join(mailboxDir, ".sent-questions.json");
}

/**
 * <mailboxDir>/.roster.json — the roster view (teams + teammates) this agent
 * was last shown (Phase 4, D18). The runtime diffs it against teams.json at
 * wake and delivers the changes as roster-change digest lines.
 */
export function rosterSnapshotFileOf(mailboxDir: string): string {
	return join(mailboxDir, ".roster.json");
}

/**
 * <mailboxDir>/.collect-requests.json — outstanding subagent_collect requests
 * (envelopeId → schema). A report envelope whose correlationId matches is a
 * collect result; its payload.data is validated against the stored schema on
 * arrival (03-tool-surface).
 */
export function collectRequestsFileOf(mailboxDir: string): string {
	return join(mailboxDir, ".collect-requests.json");
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LayoutOptions {
	/** Override $HOME (tests). Defaults to os.homedir(). */
	home?: string;
}

/** Every path the extension uses, for one project cwd. */
export interface Layout {
	/** The project cwd this layout is for (as given). */
	readonly cwd: string;
	/** ~/.pi/agent */
	readonly agentDir: string;
	/** ~/.pi/agent/sessions */
	readonly sessionsRoot: string;
	/** ~/.pi/agent/sessions/<cwd-slug> — Pi's own dir for this project. */
	readonly projectSessionDir: string;
	/** <projectSessionDir>/subagents — root of everything we own. */
	readonly subagentsRoot: string;
	/** <subagentsRoot>/registry.json */
	readonly registryFile: string;
	/** <subagentsRoot>/teams.json */
	readonly teamsFile: string;
	/** <subagentsRoot>/.main/mailbox — the main agent's mailbox. */
	readonly mainMailboxDir: string;
	/** <subagentsRoot>/.main/mailbox/.done */
	readonly mainMailboxDoneDir: string;
	/** <subagentsRoot>/.main/mailbox/.delivering — host-append pending verification. */
	readonly mainMailboxDeliveringDir: string;
	/** <subagentsRoot>/.main/escalations — pending/resolved escalation records (Phase 5, D10/D22). */
	readonly escalationsDir: string;
	/** <subagentsRoot>/.archive */
	readonly archiveRoot: string;

	/** <subagentsRoot>/<type>/<id> — an agent instance's dir. */
	agentInstanceDir(type: string, id: string): string;
	/** <agent>/mailbox */
	mailboxDir(type: string, id: string): string;
	/** <agent>/mailbox/.done */
	mailboxDoneDir(type: string, id: string): string;
	/** <agent>/files */
	filesDir(type: string, id: string): string;
	/** <agent>/<timestamp>_<uuid>.jsonl — Pi-native session file. */
	sessionFilePath(type: string, id: string, timestamp: Date | string, sessionId: string): string;
	/** An envelope's file inside a mailbox dir: <mailboxDir>/<msg-id>.json */
	envelopeFile(mailboxDir: string, envelopeId: string): string;
	/** <archiveRoot>/<type>/<id> — where retire moves an agent dir (D13). */
	archiveDir(type: string, id: string): string;
	/** <escalationsDir>/<escalationId>.json — one escalation record (Phase 5). */
	escalationFile(escalationId: string): string;

	/** ~/.pi/agent/subagents — global type-definition library (D6). */
	readonly globalTypeDefsDir: string;
	/** <cwd>/.pi/subagents — repo-shipped type definitions (D6; wins on conflict). */
	readonly projectTypeDefsDir: string;
	/** A type definition file inside either discovery dir. */
	typeDefFile(dir: string, typeName: string): string;

	/**
	 * ~/.pi/agent/subagents.json — global extension settings (Phase 7, D21
	 * "extension settings (global, per-project override)"). Sits BESIDE the
	 * subagents/ type-def dir, mirroring the pi-plan-commit config convention
	 * (`<agentDir>/<name>.json`).
	 *
	 * INVARIANT (relied on by sandbox/paths.ts): each settings file is exactly
	 * its type-def dir + ".json" (`<typeDefsDir>.json`). The settings files
	 * carry the D21 rails, so they are part of the D20 implicit denial set —
	 * paths.ts derives them from the type-def-dir systemDenyPrefixes via this
	 * sibling rule. Change one side only with the other in view.
	 */
	readonly globalSettingsFile: string;
	/** <cwd>/.pi/subagents.json — per-project overrides, field by field. */
	readonly projectSettingsFile: string;
}

/**
 * <typeDefsDir>.json — the settings-file sibling of a type-definition dir
 * (the Layout invariant above, in function form). sandbox/paths.ts uses this
 * to extend each type-def systemDenyPrefix to its D21 settings file.
 */
export function settingsFileSiblingOf(typeDefsDir: string): string {
	return `${typeDefsDir}.json`;
}

/** Build the full path layout for a project cwd. */
export function createLayout(cwd: string, options: LayoutOptions = {}): Layout {
	const home = options.home ?? homedir();
	const agentDir = join(home, ".pi", "agent");
	const sessionsRoot = join(agentDir, "sessions");
	const projectSessionDir = join(sessionsRoot, cwdSlug(cwd));
	const subagentsRoot = join(projectSessionDir, "subagents");
	const archiveRoot = join(subagentsRoot, ".archive");
	const mainMailboxDir = join(subagentsRoot, ".main", "mailbox");
	const escalationsDir = join(subagentsRoot, ".main", "escalations");

	const agentInstanceDir = (type: string, id: string): string => join(subagentsRoot, type, id);
	const mailboxDir = (type: string, id: string): string => join(agentInstanceDir(type, id), "mailbox");

	return {
		cwd,
		agentDir,
		sessionsRoot,
		projectSessionDir,
		subagentsRoot,
		registryFile: join(subagentsRoot, "registry.json"),
		teamsFile: join(subagentsRoot, "teams.json"),
		mainMailboxDir,
		mainMailboxDoneDir: join(mainMailboxDir, ".done"),
		mainMailboxDeliveringDir: mailboxDeliveringDirOf(mainMailboxDir),
		escalationsDir,
		archiveRoot,

		agentInstanceDir,
		mailboxDir,
		mailboxDoneDir: (type, id) => join(mailboxDir(type, id), ".done"),
		filesDir: (type, id) => join(agentInstanceDir(type, id), "files"),
		sessionFilePath: (type, id, timestamp, sessionId) =>
			join(agentInstanceDir(type, id), sessionFileName(timestamp, sessionId)),
		envelopeFile: (dir, envelopeId) => join(dir, `${envelopeId}.json`),
		archiveDir: (type, id) => join(archiveRoot, type, id),
		escalationFile: (escalationId) => join(escalationsDir, `${escalationId}.json`),

		globalTypeDefsDir: join(agentDir, "subagents"),
		projectTypeDefsDir: join(cwd, ".pi", "subagents"),
		typeDefFile: (dir, typeName) => join(dir, `${typeName}.md`),

		// Constructed THROUGH the sibling invariant (see the interface docs):
		// settings file === type-def dir + ".json".
		globalSettingsFile: settingsFileSiblingOf(join(agentDir, "subagents")),
		projectSettingsFile: settingsFileSiblingOf(join(cwd, ".pi", "subagents")),
	};
}
