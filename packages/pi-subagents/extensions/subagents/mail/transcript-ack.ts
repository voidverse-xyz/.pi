import { readFileSync } from "node:fs";
import { persistedMailIds } from "./wake-pump.ts";

/**
 * SessionManager updates its in-memory entries before writing, and delays a new
 * file until its first assistant message. Only complete on-disk entries prove
 * delivery survived either a failed append or a shutdown before the first reply.
 */
export function readPersistedMailIds(sessionFile: string | undefined, customType: string): Set<string> {
	if (!sessionFile) return new Set();
	try {
		const text = readFileSync(sessionFile, "utf8");
		const entries: unknown[] = [];
		const lines = text.split("\n");
		lines.pop(); // a partial trailing write is not acknowledgement
		for (const line of lines) {
			try {
				entries.push(JSON.parse(line));
			} catch {
				/* malformed entries prove nothing */
			}
		}
		return persistedMailIds(entries, customType);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		// Unknown persistence state must not permit a duplicate injection.
		throw error;
	}
}
