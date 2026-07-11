/**
 * Install this package's theme JSONs into pi's user themes directory
 * (`~/.pi/agent/themes`, or $PI_CODING_AGENT_DIR/themes). pi auto-loads that
 * directory at startup — BEFORE it restores the persisted theme — so a theme
 * we persisted last run resolves cleanly with no "theme not found" boot error.
 * Idempotent: only writes when missing or changed. resources_discover still
 * covers the very first run before the copy exists.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function installThemes(themeFiles: string[]): void {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR
			? process.env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/)/, os.homedir())
			: path.join(os.homedir(), ".pi", "agent");
		const dest = path.join(agentDir, "themes");
		fs.mkdirSync(dest, { recursive: true });
		for (const src of themeFiles) {
			const target = path.join(dest, path.basename(src));
			const next = fs.readFileSync(src, "utf-8");
			let current: string | null = null;
			try { current = fs.readFileSync(target, "utf-8"); } catch { /* missing */ }
			if (current !== next) fs.writeFileSync(target, next);
		}
	} catch {
		// Non-fatal: resources_discover + the setTheme retry still apply the theme.
	}
}
