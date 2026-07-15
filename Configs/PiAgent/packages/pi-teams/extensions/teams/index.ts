/**
 * Subagents (v2) — extension entry.
 *
 * Design: ~/Agents/Documents/Configs/Subagent-Docs/ (D1'–D27'). v1 is archived
 * at packages/_archive/pi-agents-v1/.
 *
 * At session_start the core is acquired under a single host-scope lease (D7),
 * keyed by the owning main session id (D3/D25'). Non-persisted (temporary)
 * sessions cannot spawn subagents at all (D25'). Torn down on shutdown.
 *
 * Registration grows phase by phase. Phase 2: team_spawn / team_status.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCore, type SubagentsCore } from "./core.ts";
import { createLayout } from "./store/layout.ts";
import { claimHostScope, HostScopeLockedError, type HostScopeLease } from "./store/host-lease.ts";
import { SettingsLoader } from "./store/settings.ts";
import { makeSafetyConfirm } from "./sandbox/safety-bridge.ts";
import {
	createAwaitTool,
	createCollectTool,
	createInterruptTool,
	createRetireTool,
	createSendTool,
	createSpawnTool,
	createStatusTool,
	createSteerTool,
} from "./tools/main-agent.ts";
import { createWidgetController, widgetStatusText, type WidgetController } from "./tui/widget.ts";
import { createTreeWidget, type TreeWidgetController } from "./tui/tree-widget.ts";
import { createPicker, type PickerResult } from "./tui/picker.ts";
import { createViewer, type ViewerResult } from "./tui/viewer.ts";

const STATUS_KEY = "teams";

/**
 * sendMessage options for a main-mail wake injection (D24). BOTH matter and they
 * compose — the SDK picks exactly one branch by state:
 *   streaming → `followUp` queues the digest into the running turn (D11: mail never
 *               interrupts a turn; `triggerTurn` is ignored on this path).
 *   idle      → `triggerTurn` starts a new turn — the actual auto-wake.
 * Without `triggerTurn` the idle case silently fell through to SDK
 * `sendCustomMessage`'s last branch (append to state, no turn), so the digest sat in
 * the conversation until the user's next message dragged it in. That was the
 * auto-wake bug. Exported so test/e2e/phase9-auto-wake.mjs asserts the REAL shape
 * rather than a copy that could drift.
 */
export const WAKE_DELIVERY = { deliverAs: "followUp", triggerTurn: true } as const;

export default function (pi: ExtensionAPI): void {
	let core: SubagentsCore | null = null;
	let lease: HostScopeLease | null = null;
	let widget: WidgetController | null = null;
	let tree: TreeWidgetController | null = null;
	let overlayOpen = false;
	/** Set when subagents are unavailable this session (non-persisted, or lease held elsewhere). */
	let unavailableReason: string | null = null;

	const getCore = (_ctx: ExtensionContext): SubagentsCore => {
		if (core) return core;
		throw new Error(unavailableReason ?? "Subagents are not available in this session.");
	};

	pi.registerTool(createSpawnTool(getCore));
	pi.registerTool(createSendTool(getCore));
	pi.registerTool(createSteerTool(getCore));
	pi.registerTool(createCollectTool(getCore));
	pi.registerTool(createAwaitTool(getCore));
	pi.registerTool(createInterruptTool(getCore));
	pi.registerTool(createRetireTool(getCore));
	pi.registerTool(createStatusTool(getCore));

	// --- TUI (D22): /teams picker → full-screen viewer; ambient widget. ---
	const openViewer = async (ctx: ExtensionContext, startAddress: string): Promise<void> => {
		if (ctx.mode !== "tui" || overlayOpen || !core) return;
		let address: string | undefined = startAddress;
		while (address) {
			overlayOpen = true;
			let result: ViewerResult;
			try {
				const addr = address;
				result = await ctx.ui.custom<ViewerResult>(
					(tui, theme, _kb, done) => createViewer({ core: core!, tui, theme, address: addr, cwd: ctx.cwd, onDone: done }),
					{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
				);
			} finally {
				overlayOpen = false;
			}
			if (result.action === "back") break;
			// alt+j: next agent in address order; past the last → done.
			const roster = (await core.status()).sort((a, b) => a.address.localeCompare(b.address));
			const at = roster.findIndex((r) => r.address === address);
			address = roster[at + 1]?.address;
		}
	};

	const openPicker = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || overlayOpen || !core) return;
		overlayOpen = true;
		let result: PickerResult;
		try {
			result = await ctx.ui.custom<PickerResult>((tui, theme, _kb, done) => createPicker({ core: core!, tui, theme, onDone: done }));
		} finally {
			overlayOpen = false;
		}
		if (result.action === "view") await openViewer(ctx, result.address);
	};

	pi.registerCommand("teams", {
		description: "Open the teams roster (or /teams <type>/<id> to jump to a subagent).",
		handler: async (args, ctx) => {
			if (!core) {
				ctx.ui.notify(unavailableReason ?? "Teams are not available in this session.", "warning");
				return;
			}
			const target = args.trim();
			if (target) await openViewer(ctx, target);
			else await openPicker(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Fresh scope per session_start (reload/resume rebuilds it).
		await teardown();

		const sessionId = ctx.sessionManager.getSessionId();
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		if (!persisted) {
			unavailableReason = "Subagents require a persisted session (start or resume a saved session).";
			return;
		}

		const layout = createLayout(ctx.cwd, { sessionId });
		try {
			lease = claimHostScope(layout);
		} catch (error) {
			if (error instanceof HostScopeLockedError) {
				unavailableReason = `Another process (pid ${error.ownerPid}) owns this session's subagents.`;
				if (ctx.hasUI) ctx.ui.notify(unavailableReason, "warning");
				return;
			}
			throw error;
		}

		try {
		const { settings, warnings } = new SettingsLoader(layout.globalSettingsFile, layout.projectSettingsFile).load();
		if (ctx.hasUI) for (const warning of warnings) ctx.ui.notify(`pi-agents: ${warning}`, "warning");

		unavailableReason = null;
		core = createCore({
			layout,
			maxConcurrent: settings.maxConcurrent,
			maxHops: settings.maxHops,
			// Guarded subagent tool calls (bash/edit/write) confirm via pi-safety
			// over pi.events (D10a); fail-closed if pi-safety is absent.
			confirm: makeSafetyConfirm(pi),
			// settingsManager/authStorage are not on ExtensionContext — the SDK
			// defaults them; only modelRegistry is host-provided.
			...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
			projectTrusted: () => {
				try {
					return ctx.isProjectTrusted?.() === true;
				} catch {
					return false; // trust uncertainty fails closed (finding #7)
				}
			},
		});

		uiCtx = ctx;
		// A subagent that finishes/reports while the host is idle should wake it.
		core.onEvent((event) => {
			if (event.type === "turn-finished" || event.type === "agent-retired") deliverMainMail();
		});

		// Ambient widget: publish plain status text; pi-status-line styles it.
		if (ctx.mode === "tui") {
			const publish = (): void => {
				if (!widget) return;
				ctx.ui.setStatus(STATUS_KEY, widgetStatusText(widget.snapshot()));
			};
			widget = createWidgetController({ core, onChange: publish });
			publish();
			// The live "Running N team agents…" tree above the editor (Phase 8).
			tree = createTreeWidget(core, {
				setWidget: (key, content, opts) => ctx.ui.setWidget(key, content, opts),
				theme: ctx.ui.theme,
			});
		}
		} catch (error) {
			// Setup failed AFTER the lease was claimed — tear everything down so the
			// lease is released (otherwise it blocks resume in another process), and
			// report why subagents are unavailable this session (M3).
			await teardown();
			unavailableReason = `Subagents failed to initialize: ${error instanceof Error ? error.message : String(error)}`;
			if (ctx.hasUI) ctx.ui.notify(unavailableReason, "warning");
		}
	});

	// --- Main-mail auto-wake (D24): all mail wakes an idle host. ---
	let hostIdle = false;
	let uiCtx: ExtensionContext | null = null;

	const deliverMainMail = (): void => {
		if (!hostIdle || !core || !uiCtx) return;
		const drained = core.takeMainMailDigest();
		if (!drained) return;
		hostIdle = false; // the injected turn is no longer idle
		pi.sendMessage({ content: drained.digest, customType: "teams-mail", display: true, details: undefined }, WAKE_DELIVERY);
		// sendMessage is fire-and-forget (the SDK floats the promise and routes any
		// rejection to its own error channel), so there is nothing here to catch. The
		// durability handoff is the injection itself: the digest is appended to the
		// session transcript, which makes the mailbox copy redundant — so commit now.
		drained.commit();
	};

	pi.on("input", (_event, ctx) => {
		hostIdle = false;
		uiCtx = ctx;
	});
	pi.on("before_agent_start", () => {
		hostIdle = false;
	});
	pi.on("agent_settled", (_event, ctx) => {
		uiCtx = ctx ?? uiCtx;
		hostIdle = true;
		deliverMainMail(); // background work that finished during the turn
	});

	pi.on("session_shutdown", async () => {
		await teardown();
	});

	async function teardown(): Promise<void> {
		if (tree) {
			tree.dispose();
			tree = null;
		}
		if (widget) {
			widget.dispose();
			widget = null;
		}
		if (core) {
			try {
				await core.dispose();
			} catch {
				/* best effort */
			}
			core = null;
		}
		if (lease) {
			lease.release();
			lease = null;
		}
	}
}
