/**
 * /browse — a native Pi TUI file & directory tree browser.
 *
 * Left pane: a lazy tree rooted at the working directory (dirs expand/collapse).
 * Right pane: a preview — file contents (with a movable line cursor and range
 * selection) or a directory listing.
 *
 * Add-to-chat (a): appends an @-mention into the input editor — `@file`, `@dir/`,
 * or `@file:12-40` for a selected line range — without sending, so you can gather
 * several references and then type your prompt.
 *
 * User-level: enable by adding this package's path to ~/.pi/agent/settings.json.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createBrowsePanel } from "./panel.ts";

export default function browseExtension(pi: ExtensionAPI): void {
	const command = {
		description: "Browse the file/dir tree; preview files and add @-references to chat",
		handler: async (_args: string, ctx: ExtensionCommandContext) => runBrowse(ctx),
	};

	pi.registerCommand("browse", command);
}

async function runBrowse(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/browse requires interactive TUI mode", "error");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			createBrowsePanel({ cwd: ctx.cwd, ctx, tui, theme, keybindings, onDone: done }),
		{
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
}
