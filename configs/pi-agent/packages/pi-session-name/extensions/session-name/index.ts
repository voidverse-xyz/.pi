/**
 * Session naming.
 *
 * Shows setSessionName/getSessionName to give sessions friendly names
 * that appear in the session selector instead of the first message.
 *
 * Usage:
 *   /session-rename [name]  - set or show session name
 *   /session-rename --clear - remove the custom session name
 *
 * Auto-naming: when a session has no name, the first qualifying user
 * prompt names it automatically (heuristic only, no model call): first
 * non-empty line, markdown noise stripped, whitespace collapsed,
 * truncated to ~48 chars. A name is never overwritten once set — user
 * renames always win, and auto-naming fires at most once per unnamed
 * session. Clearing via --clear leaves the session unnamed, so the next
 * qualifying prompt will auto-name it again (that stateless rule is the
 * whole mechanism: "auto-name only while unnamed"); set an explicit name
 * if you want to pin one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Maximum length of an auto-derived session name. */
const AUTO_NAME_MAX = 48;

/**
 * Derive a session name from prompt text: first non-empty line, markdown
 * markers stripped, whitespace collapsed, truncated at a word boundary.
 * Returns undefined when nothing usable remains.
 */
function deriveAutoName(text: string): string | undefined {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return undefined;

	let name = firstLine
		.replace(/^#{1,6}\s+/, "") // heading marker
		.replace(/^(?:[>*+-]\s+)+/, "") // blockquote / bullet markers
		.replace(/^\d+[.)]\s+/, "") // ordered-list marker
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images -> label
		.replace(/(\*\*|__|~~|\*)/g, "") // emphasis markers (single _ kept: identifiers)
		.replace(/`+/g, "") // backticks
		.replace(/\s+/g, " ")
		.trim();
	if (!name) return undefined;

	if (name.length > AUTO_NAME_MAX) {
		// Reserve one character for the ellipsis so the documented maximum is
		// actually respected (the old implementation produced 49 characters).
		const cut = name.slice(0, AUTO_NAME_MAX - 1);
		const space = cut.lastIndexOf(" ");
		name = (space > AUTO_NAME_MAX / 2 ? cut.slice(0, space) : cut).trimEnd() + "…";
	}
	return name;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("session-rename", {
		description: "Set, show, or clear session name (usage: /session-rename [new name | --clear])",
		handler: async (args, ctx) => {
			const name = args.trim();

			if (name === "--clear") {
				pi.setSessionName("");
				ctx.ui.notify("Session name cleared (next prompt may auto-name it again)", "info");
			} else if (name) {
				pi.setSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} else {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});

	// Auto-name unnamed sessions from the first qualifying user prompt.
	// Once a name exists (user-set or auto), this never fires again, so
	// user renames are never overwritten and messages never re-rename.
	pi.on("input", (event) => {
		if (pi.getSessionName()) return;
		if (event.source === "extension") return; // extension-injected text is not a user prompt
		const trimmed = event.text.trimStart();
		if (trimmed.startsWith("/") || trimmed.startsWith("!")) return; // commands / shell passthrough
		const name = deriveAutoName(event.text);
		if (name) pi.setSessionName(name);
	});
}
