/**
 * /clear alias for /new.
 *
 * Pi renamed the old /clear command to /new. This package keeps the
 * muscle-memory command available by creating a new session through the
 * extension command API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Alias for /new: start a new session",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /clear", "warning");
				return;
			}

			await ctx.newSession({
				withSession: async (sessionCtx) => {
					sessionCtx.ui.notify("New session started", "info");
				},
			});
		},
	});
}
