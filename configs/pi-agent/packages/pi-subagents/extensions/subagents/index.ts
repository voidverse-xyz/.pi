/**
 * pi-subagents — extension entry.
 *
 * Plan: configs/pi-agent/docs/agents/plans/pi-agent/pi-subagents/pi-subagents.md. Runs ALONGSIDE
 * pi-teams: subagent_* tools are background fan-out workers (hub-and-spoke, no
 * peer mail, no nesting); team_* remains the collaborative persistent team.
 *
 * At session_start the core is acquired under a single host-scope lease keyed
 * by the owning main session id. Non-persisted (temporary) sessions cannot
 * spawn subagents at all. Torn down on shutdown.
 *
 * Registers the seven subagent_* tools, the /subagents command (picker/viewer/
 * stop), the stop-all shortcut, the unified tree/status widget, and the
 * main-mail auto-wake pump.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCore, type SubagentsCore } from "./core.ts";
import { gcArchive, gcDoneMail } from "./store/archive.ts";
import { createLayout } from "./store/layout.ts";
import { createWakePump } from "./mail/wake-pump.ts";
import { claimHostScope, HostScopeLockedError, type HostScopeLease } from "./store/host-lease.ts";
import { loadSettings } from "./store/settings.ts";
import { makeSafetyConfirm } from "./sandbox/safety-bridge.ts";
import {
	createAwaitTool,
	createCancelTool,
	createRetireTool,
	createSendTool,
	createSpawnTool,
	createStatusTool,
	createSteerTool,
} from "./tools/main-agent.ts";
import { createTreeWidget, STOP_KEY, type TreeWidgetController } from "./tui/tree-widget.ts";
import { createPicker, type PickerResult } from "./tui/picker.ts";
import { createViewer, type ViewerResult } from "./tui/viewer.ts";

/**
 * sendMessage options for a main-mail wake injection. BOTH matter and they
 * compose — the SDK picks exactly one branch by state:
 *   streaming → `followUp` queues the digest into the running turn (mail never
 *               interrupts a turn; `triggerTurn` is ignored on this path).
 *   idle      → `triggerTurn` starts a new turn — the actual auto-wake.
 * Exported so the e2e suite asserts the REAL shape rather than a copy that
 * could drift.
 */
export const WAKE_DELIVERY = { deliverAs: "followUp", triggerTurn: true } as const;

export default function (pi: ExtensionAPI): void {
	let core: SubagentsCore | null = null;
	let lease: HostScopeLease | null = null;
	let tree: TreeWidgetController | null = null;
	let overlayOpen = false;
	/** Set when subagents are unavailable this session (non-persisted, or lease held elsewhere). */
	let unavailableReason: string | null = null;
	/** The latest ExtensionContext, captured at session_start/input/settle for the wake pump. */
	let uiCtx: ExtensionContext | null = null;

	const unavailable = (): string => unavailableReason ?? "Subagents are not available in this session.";

	const getCore = (): SubagentsCore => {
		if (core) return core;
		throw new Error(unavailable());
	};

	// --- Main-mail auto-wake: all mail wakes an idle host. ---
	// The POLICY lives in mail/wake-pump.ts (pure, unit-tested). This is only the
	// port binding: core for the digest, pi.sendMessage for the injection. Keep it
	// that way — logic added here is logic the suite cannot reach.
	const pump = createWakePump({
		takeDigest: () => (core && uiCtx ? core.takeMainMailDigest() : null),
		inject: (digest) => {
			// sendMessage is fire-and-forget (returns void; the SDK floats the promise
			// and routes any rejection to its own error channel), so there is nothing to
			// catch here — synchronous acceptance is the commit boundary (wake-pump.ts).
			pi.sendMessage({ content: digest, customType: "subagents-mail", display: true, details: undefined }, WAKE_DELIVERY);
		},
	});

	pi.registerTool(createSpawnTool(getCore));
	pi.registerTool(createSendTool(getCore));
	pi.registerTool(createSteerTool(getCore));
	pi.registerTool(createAwaitTool(getCore));
	pi.registerTool(createCancelTool(getCore));
	pi.registerTool(createRetireTool(getCore));
	pi.registerTool(createStatusTool(getCore));

	// --- TUI: /subagents picker → full-screen viewer; ambient widget. ---
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
			if (at < 0) break; // viewed agent left the roster (retired) — exit, don't wrap to roster[0]
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

	/**
	 * The human brake: cancel every working agent. Non-destructive by design — a
	 * cancelled agent stays alive with memory intact, goes dormant, and its
	 * triggering mail stays PENDING (never auto-retried), so stopping is
	 * recoverable: send it anything and it resumes from that mail.
	 *
	 * Deliberately human-only (a command + a keybind, no stop-all tool): the LLM
	 * already has per-agent subagent_cancel, and a fleet-wide brake exists for the
	 * human to reclaim control — including from a fleet the LLM is driving.
	 */
	const stopAllAgents = async (ctx: ExtensionContext): Promise<void> => {
		if (!core) {
			ctx.ui.notify(unavailable(), "warning");
			return;
		}
		const { stopped, failed } = await core.cancelAllWorking();
		if (stopped.length === 0 && failed.length === 0) {
			ctx.ui.notify("No subagents are working.", "info");
			return;
		}
		ctx.ui.notify(
			`Stopped ${stopped.length} subagent${stopped.length === 1 ? "" : "s"}${failed.length > 0 ? ` (${failed.length} failed)` : ""}: ${stopped.join(", ")}. Their mail stays pending — message an agent to resume it.`,
			failed.length > 0 ? "warning" : "info",
		);
	};

	pi.registerCommand("subagents", {
		description: "Subagents roster. /subagents <type>/<id> jump · /subagents stop.",
		handler: async (args, ctx) => {
			if (!core) {
				ctx.ui.notify(unavailable(), "warning");
				return;
			}
			const target = args.trim();
			if (target === "stop") return stopAllAgents(ctx);
			if (target) await openViewer(ctx, target);
			else await openPicker(ctx);
		},
	});

	// Same brake on a key, advertised in the tree widget's header while agents run.
	pi.registerShortcut(STOP_KEY, {
		description: "Stop all working subagents",
		handler: (ctx) => stopAllAgents(ctx),
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

		const layout = createLayout(ctx.cwd, { sessionId, agentDir: getAgentDir() });
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
			const { settings, warnings } = loadSettings(layout.globalSettingsFile, layout.projectSettingsFile);
			if (ctx.hasUI) for (const warning of warnings) ctx.ui.notify(`pi-subagents: ${warning}`, "warning");

			unavailableReason = null;
			core = createCore({
				layout,
				maxConcurrent: settings.maxConcurrent,
				// Guarded subagent tool calls (bash/edit/write) confirm via pi-safety
				// over pi.events; fail-closed if pi-safety is absent.
				confirm: makeSafetyConfirm(pi),
				// The SDK creates cwd-bound settings/auth/model services for subagents.
				// Keep the main compatibility facade only to mirror providers registered
				// dynamically by other extensions.
				...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
				projectTrusted: () => {
					try {
						return ctx.isProjectTrusted?.() === true;
					} catch {
						return false; // trust uncertainty fails closed
					}
				},
			});

			uiCtx = ctx;
			// A subagent that finishes/retires while the host is idle should wake it.
			core.onEvent((event) => {
				if (event.type === "turn-finished" || event.type === "agent-retired") pump.onMailArrived();
			});

			// One best-effort retention sweep per session: retired agent dirs and
			// processed .done mail older than archiveGcDays. Hygiene only — fire and
			// forget, never blocks startup.
			const gcCore = core;
			void (async () => {
				try {
					const roster = await gcCore.status();
					const boxes = [layout.mainMailboxDir, ...roster.map((entry) => layout.mailboxDir(entry.type, entry.id))];
					gcArchive(layout, settings.archiveGcDays, Date.now());
					gcDoneMail(boxes, settings.archiveGcDays, Date.now());
				} catch {
					/* best effort */
				}
			})();

			// The single ambient surface: running/waiting/mail counts plus live
			// per-agent activity. Nothing is published into the shared footer.
			if (ctx.mode === "tui") {
				tree = createTreeWidget(core, {
					setWidget: (key, content, opts) => ctx.ui.setWidget(key, content, opts),
				});
			}
		} catch (error) {
			// Setup failed AFTER the lease was claimed — tear everything down so the
			// lease is released (otherwise it blocks resume in another process), and
			// report why subagents are unavailable this session.
			await teardown();
			unavailableReason = `Subagents failed to initialize: ${error instanceof Error ? error.message : String(error)}`;
			if (ctx.hasUI) ctx.ui.notify(unavailableReason, "warning");
		}
	});

	// Map Pi's lifecycle events onto the wake pump — literal plumbing only.
	pi.on("input", (_event, ctx) => {
		uiCtx = ctx;
		pump.onInput();
	});
	pi.on("before_agent_start", () => pump.onBeforeAgentStart());
	pi.on("agent_settled", (_event, ctx) => {
		uiCtx = ctx ?? uiCtx;
		pump.onSettled(); // drains background work that finished during the turn
	});

	pi.on("session_shutdown", async () => {
		pump.shutdown(); // no stale turn after teardown
		await teardown();
	});

	async function teardown(): Promise<void> {
		if (tree) {
			tree.dispose();
			tree = null;
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
