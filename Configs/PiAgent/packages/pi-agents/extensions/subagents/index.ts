/**
 * Subagents — persistent subagents with durable memory and mailbox
 * communication (design: ~/Agents/Documents/Configs/Subagent-Docs/).
 *
 * Extension entry. Registers the full eight-tool surface
 * (03-tool-surface.md): spawn, send, steer, status, collect, interrupt,
 * retire — and wires the MAIN agent's mailbox into the host session:
 *
 *  - Every envelope type sent to `main` lands in .main/mailbox/ and wakes an
 *    idle main agent. Mail arriving mid-turn waits for `agent_settled`, where
 *    Pi is genuinely idle, then starts a fresh turn with the digest embedded.
 *  - Aborting any main-agent run durably latches automatic mailbox wakeups
 *    off across reload/restart. The next interactive/RPC input clears it; queued mail is then
 *    included in that user's turn and subsequent mail auto-wakes normally.
 *  - Main auto-wakes are intentionally independent of D21 autonomy budgets.
 *    Those turn/token rails continue to govern subagent work only.
 *  - settings.autoWake=false remains an explicit manual-mode override.
 *  - Main-mail durability (at-least-once): drains are parked in .delivering/
 *    until their digest is verified in the active main session JSONL. Crash
 *    recovery requeues unverified injections at session start.
 *
 * Phase 6 (05-tui-spec): ambient status, /agents picker,
 * full-screen session viewer (alt+j quick-switch), and the escalation modal
 * are wired here; all of them talk to the core facade only.
 *
 * Mutable state is keyed by the host's stable main-session id (D25). The core
 * is acquired at session_start so its host-scope lease excludes a second
 * consumer before reconciliation/GC; it is torn down on session end/shutdown.
 * Subagents run only while their owning main session is open; mail queues on
 * disk otherwise (D7).
 *
 * Install as a package: packages/pi-agents/extensions/subagents/index.ts
 * Reload: /reload
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createCore,
	mainAutoWakeBlockedFor,
	MAIN_MAIL_CUSTOM_TYPE,
	runGcSweepFor,
	setMainAutoWakeBlockedFor,
	type ScopeLocator,
	type SubagentsCore,
} from "./core.ts";
import { createLayout } from "./store/layout.ts";
import {
	adoptLegacyState,
	legacyStateRoots,
	recoverInterruptedAdoption,
	rollbackLegacyAdoption,
} from "./store/session-scope.ts";
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
import { createEscalationModal, type EscalationDecision } from "./tui/escalation-modal.ts";
import { createPicker, type PickerResult } from "./tui/picker.ts";
import { createViewer, type ViewerOptions, type ViewerResult } from "./tui/viewer.ts";
import { createWidgetController, widgetStatusText, type WidgetController } from "./tui/widget.ts";

// The digest-message customType prefix ("subagent-mail" / "subagent-mail-wake").
// Lives in core.ts because reconciliation greps the main session JSONL for it
// to verify a digest actually landed (main-mailbox at-least-once).
const MAIL_CUSTOM_TYPE = MAIN_MAIL_CUSTOM_TYPE;
const WAKE_TRIGGER_TEXT = "[subagent mail] New subagent mail arrived — the digest follows.";
const STATUS_KEY = "subagents";

export default function (pi: ExtensionAPI) {
	let core: SubagentsCore | undefined;
	let activeScope: (ScopeLocator & { persisted: boolean; ephemeralRoot?: string }) | undefined;
	/** Host-session streaming state used to defer mail until a settled boundary. */
	let mainBusy = false;
	/** Durable abort latch: only interactive/RPC user input re-enables wakeups. */
	let autoWakeBlockedByAbort = false;
	/** Last UI-capable context seen (event handlers get no ctx from runtime events). */
	let uiCtx: ExtensionContext | undefined;
	/**
	 * The host session manager, captured from event contexts so triggerWake
	 * (called from runtime callbacks that carry no ctx) can name the ACTIVE
	 * main session JSONL when draining — the target reconciliation later
	 * verifies against (main-mailbox at-least-once). Optional-chained
	 * everywhere: harness stubs may omit it, and a non-persisted session has
	 * no file (getSessionFile() undefined) — both fall back to the
	 * finalize-at-compose-time path.
	 */
	let sessionMgr: ExtensionContext["sessionManager"] | undefined;
	const currentSessionFile = (): string | null => sessionMgr?.getSessionFile?.() ?? null;
	/** One TUI surface at a time (picker/viewer/modal never stack). */
	let overlayOpen = false;
	/** An escalation arrived while an overlay was open — retry when it closes. */
	let escalationsDeferred = false;
	/** The widget's refresh loop (rebuilt per session / core). */
	let widget: WidgetController | undefined;
	/** Last settings warning surfaced to the user — de-dupes the notify (Finding 12). */
	let lastSettingsWarning = "";

	const scopeFor = (ctx: ExtensionContext): ScopeLocator & { persisted: boolean } => {
		const sessionId = ctx.sessionManager.getSessionId();
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		if (activeScope?.sessionId === sessionId) return activeScope;
		return { sessionId, persisted };
	};

	const getCore = (ctx: ExtensionContext): SubagentsCore => {
		if (!core) {
			const scope = scopeFor(ctx);
			autoWakeBlockedByAbort = mainAutoWakeBlockedFor(ctx.cwd, scope);
			core = createCore({
				cwd: ctx.cwd,
				sessionId: scope.sessionId,
				persisted: scope.persisted,
				...(scope.stateContainerRoot !== undefined ? { stateContainerRoot: scope.stateContainerRoot } : {}),
				modelRegistry: ctx.modelRegistry,
				onMainMail: (_envelope) => {
					// Every envelope type wakes an idle main agent unless the user has
					// aborted a run. Subagent autonomy budgets do not gate main wakeups.
					if (!core?.settings.autoWake || autoWakeBlockedByAbort || mainBusy) return;
					triggerWake();
				},
			});
			// Gate project-local subagent types on the host's live trust decision.
			// Trust uncertainty fails closed: local type files are executable model
			// instructions/configuration and must not become enabled on API errors or
			// in host contexts that cannot establish trust.
			(core.runtime as unknown as { setProjectTrust?(fn: () => boolean): void }).setProjectTrust?.(() => {
				try {
					return ctx.isProjectTrusted?.() === true;
				} catch {
					return false;
				}
			});
			// D22 escalation prompt: surface immediately when the user is
			// present (a live TUI); otherwise it queues behind the widget's ⚠
			// segment (picker open / alt+e surfaces the oldest pending).
			core.runtime.onEvent((event) => {
				if (event.type !== "escalation-created") return;
				const ctx2 = uiCtx;
				if (ctx2?.hasUI) void surfaceEscalations(ctx2);
			});
		}
		return core;
	};

	/**
	 * Start a main-agent turn with the mailbox digest embedded in the trigger.
	 * Re-check every gate here so a queued callback cannot race an abort latch.
	 */
	const triggerWake = (): void => {
		const current = core;
		if (!current || !current.settings.autoWake || autoWakeBlockedByAbort || mainBusy) return;
		try {
			const digest = current.drainMainMail(currentSessionFile());
			if (digest === null) return; // raced — someone else drained the box
			mainBusy = true; // suppress double-triggers until agent_start lands
			pi.sendMessage(
				{
					customType: `${MAIL_CUSTOM_TYPE}-wake`,
					content: `${WAKE_TRIGGER_TEXT}\n\n${digest}`,
					display: true,
				},
				{ triggerTurn: true },
			);
			current.commitMainMailDrain();
		} catch (error) {
			current.rollbackMainMailDrain();
			mainBusy = false;
			const ctx = uiCtx;
			if (ctx?.hasUI) {
				ctx.ui.notify(
					`Could not inject subagent mail; it was safely requeued: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
	};

	const releaseCore = async (): Promise<void> => {
		const current = core;
		core = undefined;
		widget?.dispose();
		widget = undefined;
		if (current) await current.dispose();
	};

	// -----------------------------------------------------------------------
	// Phase 6 TUI (05-tui-spec) — widget, picker, viewer, escalation modal.
	// All state flows through the core facade; overlays never stack.
	// -----------------------------------------------------------------------

	/** Publish plain compact activity through the reserved status key.
	 * pi-status-line owns styling and footer placement; idle stays silent. */
	const installWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const current = getCore(ctx);
		widget?.dispose();
		let controller: WidgetController;
		const publish = () => {
			ctx.ui.setStatus(STATUS_KEY, widgetStatusText(controller.snapshot()));
		};
		controller = createWidgetController({ core: current, onChange: publish });
		widget = controller;
		publish();
	};

	/** Full-screen viewer (spec §3), looping on alt+j: main → a1 → … → main. */
	const openViewer = async (
		ctx: ExtensionContext,
		target: Pick<ViewerOptions, "address" | "archived">,
	): Promise<void> => {
		if (ctx.mode !== "tui" || overlayOpen) return;
		const current = getCore(ctx);
		let cursor: Pick<ViewerOptions, "address" | "archived"> | undefined = target;
		while (cursor) {
			overlayOpen = true;
			let result: ViewerResult;
			try {
				const opts = cursor;
				result = await ctx.ui.custom<ViewerResult>(
					(tui, theme, _keybindings, done) =>
						createViewer({ core: current, tui, theme, ...opts, onDone: done }),
					{
						overlay: true,
						overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
					},
				);
			} finally {
				overlayOpen = false;
			}
			if (result.action === "back") break;
			// alt+j: next agent in address order; past the last → back to main.
			const fromAddress: string | undefined = cursor.address;
			const roster = (await current.status()).sort((a, b) => a.address.localeCompare(b.address));
			const at: number = fromAddress !== undefined ? roster.findIndex((r) => r.address === fromAddress) : -1;
			const next = roster[at + 1];
			cursor = next ? { address: next.address } : undefined;
		}
		// Escalations raised while this viewer was open were deferred (the
		// overlayOpen guard) — surface them now that the overlay is gone.
		await retryDeferredEscalations(ctx);
	};

	/** Re-run the escalation queue if any arrived while an overlay was open. */
	const retryDeferredEscalations = async (ctx: ExtensionContext): Promise<void> => {
		if (!escalationsDeferred || overlayOpen) return;
		await surfaceEscalations(ctx);
	};

	/** Escalation prompts (spec §4), oldest first, until none pend or Esc. */
	const surfaceEscalations = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") return;
		if (overlayOpen) {
			// A viewer/picker is up: don't stack — remember to retry when it
			// closes (previously the escalation was silently dropped until the
			// next unrelated trigger).
			escalationsDeferred = true;
			return;
		}
		escalationsDeferred = false;
		const current = getCore(ctx);
		for (;;) {
			const pending = current.escalations.pending();
			const record = pending[0];
			if (!record) return;
			overlayOpen = true;
			let decision: EscalationDecision;
			try {
				decision = await ctx.ui.custom<EscalationDecision>((tui, theme, _keybindings, done) =>
					createEscalationModal({
						record,
						queuedBehind: pending.length - 1,
						tui,
						theme,
						onDone: done,
					}),
				);
			} finally {
				overlayOpen = false;
			}
			if (decision.action === "approve") {
				// HUMAN-only approve (D10) — this call exists nowhere else.
				current.escalations.approve(record.id);
			} else if (decision.action === "deny") {
				current.escalations.deny(record.id, decision.note);
			} else if (decision.action === "view") {
				await openViewer(ctx, { address: record.agent });
				// Back from the viewer: re-offer the (still pending) prompt.
			} else {
				return; // dismissed — stays queued behind the widget's ⚠
			}
		}
	};

	/** Editor-local picker (spec §2); Enter chains into the full-screen viewer. */
	const openPicker = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || overlayOpen) return;
		const current = getCore(ctx);
		overlayOpen = true;
		let result: PickerResult;
		try {
			result = await ctx.ui.custom<PickerResult>((tui, theme, _keybindings, done) =>
				createPicker({ core: current, tui, theme, onDone: done }),
			);
		} finally {
			overlayOpen = false;
		}
		if (result.action === "view") await openViewer(ctx, { address: result.address });
		else if (result.action === "view-archived") await openViewer(ctx, { archived: result.archived });
		// Escalations deferred while the picker (and no chained viewer — the
		// viewer retries its own) was open get their prompt now.
		await retryDeferredEscalations(ctx);
	};

	/**
	 * The D21 subagent-autonomy resume affordance: refill the agent pool
	 * without changing the main-agent abort latch. Main wakeups do not consume
	 * or obey this pool.
	 */
	const resumeAutonomy = (ctx: ExtensionCommandContext): void => {
		const current = getCore(ctx);
		if (!current.autonomy.paused) {
			ctx.ui.notify("Subagent autonomy pool is not paused — nothing to resume.", "info");
			return;
		}
		current.autonomy.resume();
		if (!autoWakeBlockedByAbort && current.settings.autoWake && !mainBusy && current.mainHasPendingMail()) {
			triggerWake();
		}
		ctx.ui.notify("Subagent autonomy pool refilled — queued agent mail is draining.", "info");
	};

	// /agents [<type>/<id> | resume | adopt-legacy | rollback-legacy] — picker, viewer,
	// autonomy refill, or human-only cwd-wide state adoption.
	// the D21 pool (Phase 7; the paused status names this subcommand).
	pi.registerCommand("agents", {
		description:
			"Session-owned agent roster; jump to an agent, resume autonomy, or adopt/rollback legacy cwd-wide state",
		getArgumentCompletions: async (prefix) => {
			const trimmed = prefix.trim();
			const items: Array<{ value: string; label: string }> = [];
			if ("resume".startsWith(trimmed) && core?.autonomy.paused) {
				items.push({ value: "resume", label: "resume — refill the autonomy pool, drain queued mail" });
			}
			if ("adopt-legacy".startsWith(trimmed)) {
				items.push({ value: "adopt-legacy", label: "adopt-legacy — assign old cwd-wide state to this session" });
			}
			if ("rollback-legacy".startsWith(trimmed)) {
				items.push({ value: "rollback-legacy", label: "rollback-legacy — restore an unchanged adoption backup" });
			}
			if (!core) return items.length > 0 ? items : null;
			try {
				const roster = await core.status();
				items.push(
					...roster
						.map((r) => r.address)
						.filter((address) => address.startsWith(trimmed))
						.sort()
						.map((address) => ({ value: address, label: address })),
				);
				return items.length > 0 ? items : null;
			} catch {
				return items.length > 0 ? items : null;
			}
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			uiCtx = ctx;
			if (args.trim() === "resume") {
				resumeAutonomy(ctx);
				return;
			}
			if (args.trim() === "adopt-legacy") {
				const scope = scopeFor(ctx);
				if (!scope.persisted) {
					ctx.ui.notify("Legacy state can be adopted only into a persisted Pi session.", "error");
					return;
				}
				const layout = createLayout(ctx.cwd, scope);
				const roots = legacyStateRoots(layout);
				if (roots.length === 0) {
					ctx.ui.notify("No legacy cwd-wide subagent state was found.", "info");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Adopt legacy subagent state?",
					"This assigns the old cwd-wide registry, agents, teams, and mail to this Pi session only. Close other Pi processes in this project first.",
				);
				if (!confirmed) return;
				await releaseCore();
				try {
					const result = adoptLegacyState(layout);
					ctx.ui.notify(`Adopted ${result.files} files into this session; inactive backup retained.`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} finally {
					try {
						getCore(ctx);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					}
				}
				return;
			}
			if (args.trim() === "rollback-legacy") {
				const scope = scopeFor(ctx);
				if (!scope.persisted) {
					ctx.ui.notify("Legacy rollback requires a persisted Pi session.", "error");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Rollback legacy adoption?",
					"This succeeds only if the adopted scope is unchanged. It removes this session's scoped copy and restores the inactive cwd-wide backup.",
				);
				if (!confirmed) return;
				await releaseCore();
				try {
					const result = rollbackLegacyAdoption(createLayout(ctx.cwd, scope));
					ctx.ui.notify(`Restored legacy state at ${result.restored}. This session now has an empty scoped roster.`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} finally {
					try {
						getCore(ctx);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					}
				}
				return;
			}
			if (ctx.mode !== "tui") {
				// Headless/RPC fallback: a plain roster dump.
				const roster = await getCore(ctx).status();
				ctx.ui.notify(
					roster.length === 0
						? "No subagents."
						: roster.map((r) => `${r.state.padEnd(8)} ${r.address} (${r.purview})`).join("\n"),
					"info",
				);
				return;
			}
			const current = getCore(ctx);
			// Opening the picker surfaces the oldest pending escalation first (spec §4).
			await surfaceEscalations(ctx);
			const arg = args.trim();
			if (arg.length > 0) {
				const roster = await current.status();
				if (roster.some((r) => r.address === arg)) {
					await openViewer(ctx, { address: arg });
					return;
				}
				const archived = current.archived().find((a) => a.address === arg);
				if (archived) {
					await openViewer(ctx, { archived });
					return;
				}
				ctx.ui.notify(`Unknown subagent "${arg}" — /agents lists the roster`, "error");
				return;
			}
			await openPicker(ctx);
		},
	});

	// Global quick-switch (D17): main → agent 1 → … → main. Inside the viewer
	// the component's own alt+j handles the hop; this shortcut covers "main →
	// first agent" (it is a no-op while any of our overlays is open).
	// // DEVIATION: an earlier note assumed ctrl+j was free — it is NOT: ctrl+j
	// is the SDK's built-in tui.input.newLine (keybindings.js `newLine:
	// "tui.input.newLine"`), so a global ctrl+j shadows newline-in-input. alt+j
	// is verified unbound in the installed SDK dist and mirrors alt+e below.
	pi.registerShortcut("alt+j", {
		description: "Subagents: cycle into the session viewer",
		handler: async (ctx) => {
			uiCtx = ctx;
			if (ctx.mode !== "tui" || overlayOpen) return;
			const roster = (await getCore(ctx).status()).sort((a, b) => a.address.localeCompare(b.address));
			const first = roster[0];
			if (!first) {
				ctx.ui.notify("No subagents to view", "info");
				return;
			}
			await openViewer(ctx, { address: first.address });
		},
	});

	// The widget hotkey (spec §4): surface the oldest pending escalation.
	// // DEVIATION: the spec names no key; alt+e ("escalations") — ctrl+e is
	// taken by the editor's end-of-line binding.
	pi.registerShortcut("alt+e", {
		description: "Subagents: review pending escalations",
		handler: async (ctx) => {
			uiCtx = ctx;
			if (ctx.mode !== "tui") return;
			if (getCore(ctx).escalations.pending().length === 0) {
				ctx.ui.notify("No pending escalations", "info");
				return;
			}
			await surfaceEscalations(ctx);
		},
	});

	// The eight-tool surface (03-tool-surface.md).
	pi.registerTool(createSpawnTool(getCore));
	pi.registerTool(createSendTool(getCore));
	pi.registerTool(createSteerTool(getCore));
	pi.registerTool(createStatusTool(getCore));
	pi.registerTool(createCollectTool(getCore));
	pi.registerTool(createAwaitTool(getCore));
	pi.registerTool(createInterruptTool(getCore));
	pi.registerTool(createRetireTool(getCore));

	// Only real user input clears an abort latch. Extension-injected input must
	// not silently restart an autonomous mail cycle the user explicitly stopped.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		autoWakeBlockedByAbort = false;
		setMainAutoWakeBlockedFor(ctx.cwd, scopeFor(ctx), false);
		// D21 agent budgets are user-attention rails too. Reset them here, where
		// the source is known, never in before_agent_start (extension-generated
		// sendUserMessage turns also fire that later hook).
		core?.autonomy.reset();
	});

	// Main-mailbox delivery at real user turns: queued mail joins the next user
	// prompt. Auto-woken turns carry their digest inline and never use this hook.
	pi.on("before_agent_start", async (_event, ctx) => {
		sessionMgr = ctx?.sessionManager ?? sessionMgr;
		if (!core) return;
		// Phase 7: settings files are re-read at every real user turn — edits
		// to ~/.pi/agent/subagents.json / <project>/.pi/subagents.json apply
		// live (the budget and ceiling checks read the same mutable object).
		// Finding 12: a malformed file now RETAINS its last-known-good layer
		// (store/settings.ts) instead of failing open to defaults; surface the
		// warning so the user learns why an edit didn't take. De-duplicated so a
		// persistently-broken file warns once, not every turn.
		const settingsWarnings = core.reloadSettings();
		const joinedWarnings = settingsWarnings.join("\n");
		if (joinedWarnings !== lastSettingsWarning) {
			if (joinedWarnings.length > 0 && ctx?.hasUI) {
				ctx.ui.notify(`Subagent settings problem — using last valid values:\n${joinedWarnings}`, "warning");
			}
			lastSettingsWarning = joinedWarnings;
		}
		// While abort-latched, extension-started turns cannot drain or revive the
		// main mailbox. The input hook above clears the latch for real user input.
		if (autoWakeBlockedByAbort) return;
		try {
			const digest = core.drainMainMail(currentSessionFile());
			if (digest === null) return;
			core.commitMainMailDrain();
			return { message: { customType: MAIL_CUSTOM_TYPE, content: digest, display: true } };
		} catch (error) {
			core.rollbackMainMailDrain();
			if (ctx?.hasUI) {
				ctx.ui.notify(
					`Could not inject subagent mail; it remains queued: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			return;
		}
	});

	pi.on("agent_start", async () => {
		mainBusy = true;
	});
	// Pi exposes an aborted stop reason, not the abort's source. Any aborted
	// main run therefore latches mailbox auto-wake off until real user input.
	pi.on("agent_end", async (event, ctx) => {
		const lastAssistant = [...(event.messages ?? [])]
			.reverse()
			.find((message) => message.role === "assistant") as { stopReason?: string } | undefined;
		if (lastAssistant?.stopReason === "aborted") {
			autoWakeBlockedByAbort = true;
			setMainAutoWakeBlockedFor(ctx.cwd, scopeFor(ctx), true);
		}
	});
	// Turn boundary (D11): mail held during the host turn gets its wake now.
	// agent_settled fires once per run, after retries/compaction/queued
	// continuations resolve AND after isStreaming goes false — so triggerWake's
	// sendMessage(triggerTurn) genuinely starts a new main-agent turn (it emits
	// no interactive/RPC input event, keeping the D21 reset user-only).
	// mainBusy stays true through the agent_end→agent_settled gap so onMainMail
	// can never steer a wake into a run that is still settling.
	pi.on("agent_settled", async (_event, ctx) => {
		sessionMgr = ctx?.sessionManager ?? sessionMgr;
		mainBusy = false;
		if (core?.settings.autoWake && !autoWakeBlockedByAbort && core.mainHasPendingMail()) triggerWake();
	});

	// New/resumed/forked session → fresh wiring on next tool call (cwd or
	// registry may differ); shutdown → abort + release every live agent
	// session. Registry/teams/JSONL/mailboxes persist on disk — that's the design.
	pi.on("session_start", async (event, ctx) => {
		mainBusy = false;
		const previousScope = activeScope;
		await releaseCore();
		const sessionId = ctx.sessionManager.getSessionId();
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		const reuseEphemeral =
			!persisted &&
			event.reason === "reload" &&
			previousScope?.sessionId === sessionId &&
			previousScope.ephemeralRoot !== undefined;
		if (previousScope?.ephemeralRoot !== undefined && !reuseEphemeral) {
			rmSync(previousScope.ephemeralRoot, { recursive: true, force: true });
		}
		const ephemeralRoot = reuseEphemeral
			? previousScope!.ephemeralRoot
			: !persisted
				? mkdtempSync(join(tmpdir(), "pi-subagents-"))
				: undefined;
		activeScope = {
			sessionId,
			persisted,
			...(ephemeralRoot !== undefined ? { stateContainerRoot: ephemeralRoot, ephemeralRoot } : {}),
		};
		uiCtx = ctx;
		sessionMgr = ctx.sessionManager ?? sessionMgr;

		let recoverySafe = true;
		if (persisted) {
			try {
				recoverInterruptedAdoption(createLayout(ctx.cwd, activeScope));
			} catch (error) {
				recoverySafe = false;
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		}

		try {
			if (!recoverySafe) throw new Error("Subagent scope stayed closed because legacy-adoption recovery needs manual attention.");
			// createCore acquires the host lease, validates the manifest, and only
			// then reconciles crash-lost main mail under that exclusive ownership.
			getCore(ctx); // eagerly acquires the session host lease in every mode
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					error instanceof Error ? error.message : "Could not open this session's subagent scope.",
					"warning",
				);
			}
		}

		if (event.reason === "fork") {
			pi.sendMessage({
				customType: "subagent-scope-fork",
				content:
					"[subagent scope] This fork inherited conversation history but not the source session's subagents. Spawn new workers for this branch.",
				display: true,
			});
		}

		if (persisted) {
			try {
				const layout = createLayout(ctx.cwd, activeScope);
				if (legacyStateRoots(layout).length > 0 && ctx.hasUI) {
					ctx.ui.notify(
						"Legacy cwd-wide subagent state is available but was not assigned. Use /agents adopt-legacy to adopt it into this session.",
						"info",
					);
				}
			} catch {
				// Detection must never break startup.
			}
		}

		if (ctx.hasUI && core) installWidget(ctx);
		if (ctx.hasUI && core) {
			const current = core;
			if (current.settings.autoWake && !autoWakeBlockedByAbort && !mainBusy && current.mainHasPendingMail()) {
				triggerWake();
			}
		}

		const cwd = ctx.cwd;
		const scope = activeScope;
		const ownsScope = core !== undefined;
		const timer = setTimeout(() => {
			try {
				if (!ownsScope) return;
				runGcSweepFor(cwd, scope);
			} catch {
				// GC must never break a session.
			}
		}, 0);
		timer.unref?.();
	});
	pi.on("session_shutdown", async () => {
		uiCtx?.ui.setStatus(STATUS_KEY, undefined);
		uiCtx = undefined;
		await releaseCore();
		if (activeScope?.ephemeralRoot !== undefined) {
			rmSync(activeScope.ephemeralRoot, { recursive: true, force: true });
		}
		activeScope = undefined;
	});
}
