import {
	SessionManager,
	SessionSelectorComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type SelectorResult =
	| { action: "resume"; sessionPath: string }
	| { action: "cancel" }
	| { action: "shutdown" };

export default function (pi: ExtensionAPI) {
	pi.registerCommand("sessions", {
		description: "Alias for /resume: browse and resume a session",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /sessions", "warning");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/sessions is available in interactive mode", "warning");
				return;
			}

			const sessionManager = ctx.sessionManager as typeof ctx.sessionManager &
				Pick<SessionManager, "usesDefaultSessionDir">;

			const selection = await ctx.ui.custom<SelectorResult>((tui, _theme, keybindings, done) => {
				const selector = new SessionSelectorComponent(
					(onProgress) =>
						SessionManager.list(
							sessionManager.getCwd(),
							sessionManager.getSessionDir(),
							onProgress,
						),
					(onProgress) =>
						sessionManager.usesDefaultSessionDir()
							? SessionManager.listAll(onProgress)
							: SessionManager.listAll(sessionManager.getSessionDir(), onProgress),
					(sessionPath) => done({ action: "resume", sessionPath }),
					() => done({ action: "cancel" }),
					() => done({ action: "shutdown" }),
					() => tui.requestRender(),
					{
						renameSession: async (sessionPath, nextName) => {
							const name = (nextName ?? "").trim();
							if (!name) return;

							SessionManager.open(sessionPath).appendSessionInfo(name);
						},
						showRenameHint: true,
						keybindings,
					},
					sessionManager.getSessionFile(),
				);

				return selector;
			});

			if (!selection || selection.action === "cancel") return;
			if (selection.action === "shutdown") {
				ctx.shutdown();
				return;
			}

			try {
				const result = await ctx.switchSession(selection.sessionPath, {
					withSession: async (sessionCtx) => {
						sessionCtx.ui.notify("Resumed session", "info");
					},
				});
				if (result.cancelled) {
					ctx.ui.notify("Resume cancelled", "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to resume session: ${message}`, "error");
			}
		},
	});
}
