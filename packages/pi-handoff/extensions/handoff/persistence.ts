import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Persist a freshly seeded handoff without fabricating an assistant turn. */
export function persistHandoffSession(sessionManager: SessionManager): void {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionManager.isPersisted() || !sessionFile) return;

	// Pi defers new-session writes until an assistant reply. A handoff contains
	// only a custom message, so explicitly save its documented JSONL format.
	const entries = [sessionManager.getHeader(), ...sessionManager.getEntries()];
	const snapshot = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	if (existsSync(sessionFile)) {
		// Another startup extension may have already caused Pi to flush. Never
		// overwrite or adopt a file that does not contain this exact session.
		if (readFileSync(sessionFile, "utf8") !== snapshot) {
			throw new Error("Cannot persist handoff: the session file contains different data.");
		}
	} else {
		writeFileSync(sessionFile, snapshot, { flag: "wx", mode: 0o600 });
	}

	// Reopening through the public API marks the file as flushed, so later
	// messages append normally rather than trying to recreate it. This helper
	// is only for a fresh session whose active leaf is its final entry.
	sessionManager.setSessionFile(sessionFile);
}
