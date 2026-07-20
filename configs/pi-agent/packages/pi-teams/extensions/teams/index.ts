/**
 * pi-teams — extension entry.
 *
 * Design: configs/subagent-docs/ (D1'–D27'). This package supersedes the
 * earlier pi-agents implementation, which is not part of the active tree.
 *
 * At session_start the core is acquired under a single host-scope lease (D7),
 * keyed by the owning main session id (D3/D25'). Non-persisted (temporary)
 * sessions cannot spawn team agents at all (D25'). Torn down on shutdown.
 *
 * Registers the nine team_* tools, the /teams command (picker/viewer/stop/
 * peers), the stop-all shortcut, the live tree widget, and the main-mail
 * auto-wake pump.
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
	createCollectTool,
	createInterruptTool,
	createPeersTool,
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
	let tree: TreeWidgetController | null = null;
	let overlayOpen = false;
	/** Set when teams are unavailable this session (non-persisted, or lease held elsewhere). */
	let unavailableReason: string | null = null;
	/** The latest ExtensionContext, captured at session_start/input/settle for the wake pump. */
	let uiCtx: ExtensionContext | null = null;

	const unavailable = (): string => unavailableReason ?? "Teams are not available in this session.";

	const getCore = (): SubagentsCore => {
		if (core) return core;
		throw new Error(unavailable());
	};

	// --- Main-mail auto-wake (D24): all mail wakes an idle host. ---
	// The POLICY lives in mail/wake-pump.ts (pure, unit-tested). This is only the
	// port binding: core for the digest, pi.sendMessage for the injection. Keep it
	// that way — logic added here is logic the suite cannot reach.
	const pump = createWakePump({
		takeDigest: () => (core && uiCtx ? core.takeMainMailDigest() : null),
		inject: (digest) => {
			// sendMessage is fire-and-forget (returns void; the SDK floats the promise
			// and routes any rejection to its own error channel), so there is nothing to
			// catch here — synchronous acceptance is the commit boundary (wake-pump.ts).
			pi.sendMessage({ content: digest, customType: "teams-mail", display: true, details: undefined }, WAKE_DELIVERY);
		},
	});

	pi.registerTool(createSpawnTool(getCore));
	pi.registerTool(createSendTool(getCore));
	pi.registerTool(createSteerTool(getCore));
	pi.registerTool(createCollectTool(getCore));
	pi.registerTool(createAwaitTool(getCore));
	pi.registerTool(createInterruptTool(getCore));
	pi.registerTool(createRetireTool(getCore));
	pi.registerTool(createStatusTool(getCore));
	pi.registerTool(createPeersTool(getCore));

	// --- TUI (D22): /teams picker → full-screen viewer; live tree widget. ---
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
	 * The human brake (D22): interrupt every working agent. Non-destructive by
	 * design — an interrupted agent stays alive with memory intact, goes dormant, and
	 * its triggering mail stays PENDING (never auto-retried), so stopping is
	 * recoverable: send it anything and it resumes from that mail.
	 *
	 * Deliberately human-only (a command + a keybind, no `team_stop_all` tool): the
	 * LLM already has per-agent team_interrupt, and a fleet-wide brake exists for the
	 * human to reclaim control — including from a fleet the LLM is driving.
	 */
	const stopAllAgents = async (ctx: ExtensionContext): Promise<void> => {
		if (!core) {
			ctx.ui.notify(unavailable(), "warning");
			return;
		}
		const { stopped, failed } = await core.interruptAllWorking();
		if (stopped.length === 0 && failed.length === 0) {
			ctx.ui.notify("No team agents are working.", "info");
			return;
		}
		ctx.ui.notify(
			`Stopped ${stopped.length} team agent${stopped.length === 1 ? "" : "s"}${failed.length > 0 ? ` (${failed.length} failed)` : ""}: ${stopped.join(", ")}. Their mail stays pending — message an agent to resume it.`,
			failed.length > 0 ? "warning" : "info",
		);
	};

	/** User control (D12): pin peer messaging on/off, or hand it to the main agent ("llm"). */
	const setPeers = (ctx: ExtensionContext, arg: string): void => {
		if (!core) {
			ctx.ui.notify(unavailable(), "warning");
			return;
		}
		const mode = arg.trim().toLowerCase();
		if (mode !== "on" && mode !== "off" && mode !== "llm") {
			const state = core.peerState();
			ctx.ui.notify(`Peer messaging is "${state.userMode}"${state.userMode === "llm" ? " (the main agent decides)" : ""}. Use /teams peers on|off|llm.`, "info");
			return;
		}
		core.setUserPeerMode(mode);
		ctx.ui.notify(
			mode === "on"
				? "Peer messaging ON — subagents may message each other directly. (Applies on each agent's next turn.)"
				: mode === "off"
					? "Peer messaging OFF — all cross-agent work routes through the main agent. (Applies on each agent's next turn.)"
					: "Peer messaging handed to the main agent — it decides via team_peers.",
			"info",
		);
	};

	pi.registerCommand("teams", {
		description: "Teams roster. /teams <type>/<id> jump · /teams stop · /teams peers on|off|llm.",
		handler: async (args, ctx) => {
			if (!core) {
				ctx.ui.notify(unavailable(), "warning");
				return;
			}
			const target = args.trim();
			if (target === "stop") return stopAllAgents(ctx);
			if (target === "peers" || target.startsWith("peers ")) return setPeers(ctx, target.slice("peers".length));
			if (target) await openViewer(ctx, target);
			else await openPicker(ctx);
		},
	});

	// Same brake on a key, advertised in the tree widget's header while agents run.
	pi.registerShortcut(STOP_KEY, {
		description: "Stop all working team agents",
		handler: (ctx) => stopAllAgents(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		// Fresh scope per session_start (reload/resume rebuilds it).
		await teardown();

		const sessionId = ctx.sessionManager.getSessionId();
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		if (!persisted) {
			unavailableReason = "Teams require a persisted session (start or resume a saved session).";
			return;
		}

		const layout = createLayout(ctx.cwd, { sessionId, agentDir: getAgentDir() });
		try {
			lease = claimHostScope(layout);
		} catch (error) {
			if (error instanceof HostScopeLockedError) {
				unavailableReason = `Another process (pid ${error.ownerPid}) owns this session's team agents.`;
				if (ctx.hasUI) ctx.ui.notify(unavailableReason, "warning");
				return;
			}
			throw error;
		}

		try {
			const { settings, warnings } = loadSettings(layout.globalSettingsFile, layout.projectSettingsFile);
			if (ctx.hasUI) for (const warning of warnings) ctx.ui.notify(`pi-teams: ${warning}`, "warning");

			unavailableReason = null;
			core = createCore({
				layout,
				maxConcurrent: settings.maxConcurrent,
				maxHops: settings.maxHops,
				peersMode: settings.peers,
				// Guarded subagent tool calls (bash/edit/write) confirm via pi-safety
				// over pi.events (D10a); fail-closed if pi-safety is absent.
				confirm: makeSafetyConfirm(pi),
				// The SDK creates cwd-bound settings/auth/model services for subagents.
				// Keep the main compatibility facade only to mirror providers registered
				// dynamically by other extensions.
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
				if (event.type === "turn-finished" || event.type === "agent-retired") pump.onMailArrived();
			});

			// One best-effort retention sweep per session (D13): retired agent dirs and
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

			// The live "Running N team agents…" tree above the editor — the one
			// ambient surface (the old footer status segment was redundant with it:
			// mail auto-wakes main, so waiting/unread resolve themselves).
			if (ctx.mode === "tui") {
				tree = createTreeWidget(core, {
					setWidget: (key, content, opts) => ctx.ui.setWidget(key, content, opts),
				});
			}
		} catch (error) {
			// Setup failed AFTER the lease was claimed — tear everything down so the
			// lease is released (otherwise it blocks resume in another process), and
			// report why teams are unavailable this session (M3).
			await teardown();
			unavailableReason = `Teams failed to initialize: ${error instanceof Error ? error.message : String(error)}`;
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

	pi.on("session_shutdown", async (_event, _ctx) => {
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
