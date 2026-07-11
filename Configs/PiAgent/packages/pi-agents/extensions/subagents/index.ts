/**
 * Subagents — persistent subagents with durable memory and mailbox
 * communication (design: ~/Agents/Documents/Configs/Subagent-Docs/).
 *
 * Extension entry. Phase 3 registers the full seven-tool surface
 * (03-tool-surface.md): spawn, send, steer, status, collect, interrupt,
 * retire — and wires the MAIN agent's mailbox into the host session (D16
 * selective auto-wake):
 *
 *  - Every envelope to `main` lands in .main/mailbox/ (runtime side).
 *  - question | escalation | error while the host agent is idle → auto-wake:
 *    `pi.sendMessage(..., { triggerTurn: true })` starts a main-agent turn
 *    with the wake digest EMBEDDED in the trigger message (drained at trigger
 *    time — triggerTurn turns never fire before_agent_start, so a deferred
 *    digest would strand until the next real user turn while agent_end kept
 *    re-triggering). `before_agent_start` still drains quietly-queued reports
 *    into a digest at the start of every REAL user turn, per D16.
 *  - Mid-turn mail waits for the turn boundary (D11): `agent_settled` re-checks
 *    the mailbox and auto-wakes then if warranted. NOT `agent_end`: the SDK
 *    emits agent_end while the run still counts as streaming
 *    (AgentSession._isAgentRunActive is cleared only in _emitAgentSettled,
 *    which runs AFTER agent_end), so a sendMessage(triggerTurn) there would
 *    take sendCustomMessage's streaming branch and STEER into the ending turn
 *    instead of starting a fresh one. At agent_settled isStreaming is false
 *    and triggerTurn genuinely starts a new main-agent turn.
 *  - Plain reports queue silently; core.mainUnreadCount() feeds the Phase 6
 *    widget. settings.autoWake=false drops to fully-manual queueing.
 *  - Main-mail durability (at-least-once): every drain passes the ACTIVE main
 *    session JSONL path (ctx.sessionManager.getSessionFile(), captured into
 *    `sessionMgr` from event contexts) so core parks drained envelopes in
 *    .delivering/ instead of finalizing at compose time; session_start runs
 *    reconcileMainMailFor — digests verified in the recorded JSONL finalize,
 *    injections lost to a crash are requeued (and re-auto-woken in TUI).
 *
 * D21 rails (Phase 4) — this file owns the MAIN-side half of the shared
 * autonomy pool (core.autonomy; the runtime meters subagent turns itself):
 *  - "Caused by user" detection: the pool resets in `before_agent_start`.
 *    That event is emitted ONLY on AgentSession.prompt() — the real
 *    user-submission path; pi.sendMessage(..., { triggerTurn: true }) (our
 *    auto-wake, customType "subagent-mail-wake") calls the agent loop
 *    directly and never fires it. So auto-woken digest turns can never reset
 *    the pool — no customType inspection needed.
 *  - Auto-woken main turns are autonomous: triggerWake() consumes a pool turn
 *    and agent_end charges that turn's assistant token usage (agent_end is the
 *    only host event that carries the run's messages).
 *  - Paused system starts no auto-wake main turns: onMainMail/agent_settled
 *    skip triggerWake while paused (wake-worthy mail queues on disk; the reset
 *    on the next user turn drains it via the before_agent_start digest).
 *
 * Phase 6 (05-tui-spec): the ambient belowEditor widget, /subagents picker,
 * full-screen session viewer (alt+j quick-switch), and the escalation modal
 * are wired here; all of them talk to the core facade only.
 *
 * Everything session-scoped (layout, store, runtime, core) is instantiated
 * lazily on first tool call, from the tool-call context — so the extension
 * binds to whatever cwd/model registry the host session actually has — and
 * torn down on session end/shutdown (subagents only run while a main session
 * is open; mail queues on disk otherwise, D7).
 *
 * Install as a package: packages/pi-agents/extensions/subagents/index.ts
 * Reload: /reload
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createCore,
	MAIN_MAIL_CUSTOM_TYPE,
	reconcileMainMailFor,
	runGcSweepFor,
	type SubagentsCore,
	WAKE_WORTHY_TYPES,
} from "./core.ts";
import {
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
import { createWidgetController, widgetSegments, type WidgetController } from "./tui/widget.ts";

// The digest-message customType prefix ("subagent-mail" / "subagent-mail-wake").
// Lives in core.ts because reconciliation greps the main session JSONL for it
// to verify a digest actually landed (main-mailbox at-least-once).
const MAIL_CUSTOM_TYPE = MAIN_MAIL_CUSTOM_TYPE;
const WAKE_TRIGGER_TEXT =
	"[subagent mail] Wake-worthy subagent mail (question/escalation/error) arrived — the digest follows.";
const WIDGET_KEY = "subagents";

export default function (pi: ExtensionAPI) {
	let core: SubagentsCore | undefined;
	/** Host-session streaming state (D16 idle detection for auto-wake). */
	let mainBusy = false;
	/** The turn now running was auto-woken — charge its tokens at agent_end (D21). */
	let autoWokenTurn = false;
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

	const getCore = (ctx: ExtensionContext): SubagentsCore => {
		if (!core) {
			core = createCore({
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				onMainMail: (envelope) => {
					// D16 selective auto-wake: only question|escalation|error wake an
					// IDLE main agent; reports queue quietly (📬 widget). Mid-turn
					// mail always waits for the boundary (agent_end below).
					if (!core?.settings.autoWake) return;
					if (core.autonomy.paused) return; // D21: paused = no auto-wakes
					if (!(WAKE_WORTHY_TYPES as readonly string[]).includes(envelope.type)) return;
					if (mainBusy) return;
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
	 * Start an auto-woken main-agent turn with the wake digest EMBEDDED in the
	 * trigger message. (Carried-forward Phase-4 fix: sendMessage/triggerTurn
	 * turns never fire before_agent_start, so a digest deferred to that hook
	 * waited for the next real user turn while agent_end kept re-triggering —
	 * a rail-bounded self-wake loop. Draining at trigger time closes it.)
	 *
	 * // DEVIATION (D21 hops): main's auto-woken answers are sent via the
	 * normal main-agent tools with no `causedBy`, so a main-mediated
	 * sub→main→sub cascade restarts at hops 0 each round — the hops rail never
	 * trips it; only the autonomy pool bounds it. D21 already accepts this
	 * posture (the pool is the master rail; user input is the true reset).
	 * Threading trigger envelopes through triggerWake→send would need hops
	 * plumbing across the whole main tool surface — deliberately not done.
	 */
	const triggerWake = (): void => {
		const current = core;
		if (!current) return;
		const digest = current.drainMainMail(currentSessionFile());
		if (digest === null) return; // raced — someone else drained the box
		mainBusy = true; // suppress double-triggers until agent_start lands
		// D21: an auto-woken main turn is autonomous — it consumes a pool turn
		// (its token usage is charged at agent_end).
		current.autonomy.noteTurnStart();
		autoWokenTurn = true;
		pi.sendMessage(
			{
				customType: `${MAIL_CUSTOM_TYPE}-wake`,
				content: `${WAKE_TRIGGER_TEXT}\n\n${digest}`,
				display: true,
			},
			{ triggerTurn: true },
		);
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

	/** Publish compact activity into Pi's built-in extension-status footer row.
	 * Idle state stays silent; no custom footer or below-editor row is needed. */
	const installWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const current = getCore(ctx);
		widget?.dispose();
		let controller: WidgetController;
		const publish = () => {
			const snap = controller.snapshot();
			let text: string | undefined;
			if (snap.agentCount > 0 && snap.paused) {
				text = `⚒ agents paused · ${snap.queuedMail + snap.unread} queued`;
			} else if (snap.agentCount > 0) {
				const segments = widgetSegments(snap);
				if (segments.length > 0) text = `⚒ ${segments.join(" · ")}`;
			}
			ctx.ui.setStatus(WIDGET_KEY, text);
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
		if (!ctx.hasUI || overlayOpen) return;
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
		if (!ctx.hasUI) return;
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
				decision = await ctx.ui.custom<EscalationDecision>(
					(tui, theme, _keybindings, done) =>
						createEscalationModal({
							record,
							queuedBehind: pending.length - 1,
							tui,
							theme,
							onDone: done,
						}),
					{
						overlay: true,
						overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
					},
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

	/** Picker overlay (spec §2); Enter chains into the viewer. */
	const openPicker = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || overlayOpen) return;
		const current = getCore(ctx);
		overlayOpen = true;
		let result: PickerResult;
		try {
			result = await ctx.ui.custom<PickerResult>(
				(tui, theme, _keybindings, done) => createPicker({ core: current, tui, theme, onDone: done }),
				{
					overlay: true,
					overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
				},
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
	 * The D21 autonomy-resume affordance (Phase 7): refill the pool without
	 * sending a message. Mirrors the user-input reset — the "resumed" event
	 * makes the runtime drain every queued subagent mailbox, and wake-worthy
	 * main mail held during the pause gets its auto-wake now.
	 */
	const resumeAutonomy = (ctx: ExtensionCommandContext): void => {
		const current = getCore(ctx);
		if (!current.autonomy.paused) {
			ctx.ui.notify("Subagent autonomy pool is not paused — nothing to resume.", "info");
			return;
		}
		current.autonomy.resume();
		if (current.settings.autoWake && !mainBusy && current.mainHasWakeWorthy()) triggerWake();
		ctx.ui.notify("Subagent autonomy pool refilled — queued mail is draining.", "info");
	};

	// /subagents [<type>/<id> | resume] — picker, jump to a viewer, or refill
	// the D21 pool (Phase 7; the paused banner names this subcommand).
	pi.registerCommand("subagents", {
		description:
			"Subagent roster overlay; /subagents <type>/<id> jumps to that session; /subagents resume refills the autonomy pool",
		getArgumentCompletions: async (prefix) => {
			const trimmed = prefix.trim();
			const items: Array<{ value: string; label: string }> = [];
			if ("resume".startsWith(trimmed) && core?.autonomy.paused) {
				items.push({ value: "resume", label: "resume — refill the autonomy pool, drain queued mail" });
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
			if (!ctx.hasUI) {
				// Print-mode fallback: a plain roster dump.
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
				ctx.ui.notify(`Unknown subagent "${arg}" — /subagents lists the roster`, "error");
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
			if (!ctx.hasUI || overlayOpen) return;
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
			if (!ctx.hasUI) return;
			if (getCore(ctx).escalations.pending().length === 0) {
				ctx.ui.notify("No pending escalations", "info");
				return;
			}
			await surfaceEscalations(ctx);
		},
	});

	// The seven-tool surface (03-tool-surface.md).
	pi.registerTool(createSpawnTool(getCore));
	pi.registerTool(createSendTool(getCore));
	pi.registerTool(createSteerTool(getCore));
	pi.registerTool(createStatusTool(getCore));
	pi.registerTool(createCollectTool(getCore));
	pi.registerTool(createInterruptTool(getCore));
	pi.registerTool(createRetireTool(getCore));

	// Main-mailbox delivery at REAL user turns: drain pending main mail (the
	// quietly-queued reports, D16) into one digest injected at turn start.
	// Auto-woken turns never reach this hook — they carry their digest inline
	// in the trigger message (see triggerWake).
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
		// D21 user-input reset: before_agent_start only fires on the real user
		// prompt path (never for sendMessage/triggerTurn auto-wakes — see the
		// module header), so this refills the pool and, if paused, resumes +
		// drains the queued mailboxes.
		autoWokenTurn = false;
		core.autonomy.reset();
		const digest = core.drainMainMail(currentSessionFile());
		if (digest === null) return;
		return { message: { customType: MAIL_CUSTOM_TYPE, content: digest, display: true } };
	});

	pi.on("agent_start", async () => {
		mainBusy = true;
	});
	// D21 token charging lives at agent_end — the only host event carrying the
	// run's messages. The boundary wake re-check does NOT: agent_end is emitted
	// while AgentSession.isStreaming is still true (_isAgentRunActive is only
	// cleared in _emitAgentSettled, which runs after agent_end), so a
	// sendMessage(triggerTurn) here would steer into the ending turn instead of
	// starting a fresh one — see the agent_settled handler below.
	pi.on("agent_end", async (event) => {
		// D21: charge an auto-woken main turn's assistant token usage to the pool.
		if (autoWokenTurn) {
			autoWokenTurn = false;
			let tokens = 0;
			for (const message of event.messages ?? []) {
				const usage = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
				if (message.role === "assistant" && usage) {
					tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				}
			}
			core?.autonomy.noteTokens(tokens);
		}
	});
	// Turn boundary (D11): mail held during the host turn gets its wake now.
	// agent_settled fires once per run, after retries/compaction/queued
	// continuations resolve AND after isStreaming goes false — so triggerWake's
	// sendMessage(triggerTurn) genuinely starts a new main-agent turn (it never
	// fires before_agent_start, keeping the D21 pool reset user-input-only).
	// mainBusy stays true through the agent_end→agent_settled gap so onMainMail
	// can never steer a wake into a run that is still settling.
	// A paused system starts no auto-wake turns (D21).
	pi.on("agent_settled", async (_event, ctx) => {
		sessionMgr = ctx?.sessionManager ?? sessionMgr;
		mainBusy = false;
		if (core?.settings.autoWake && !core.autonomy.paused && core.mainHasWakeWorthy()) triggerWake();
	});

	// New/resumed/forked session → fresh wiring on next tool call (cwd or
	// registry may differ); shutdown → abort + release every live agent
	// session. Registry/teams/JSONL/mailboxes persist on disk — that's the design.
	pi.on("session_start", async (_event, ctx) => {
		mainBusy = false;
		autoWokenTurn = false;
		await releaseCore();
		uiCtx = ctx;
		sessionMgr = ctx.sessionManager ?? sessionMgr;
		// Main-mailbox crash recovery (at-least-once): settle .delivering/
		// against the recorded session JSONLs BEFORE the widget reads unread
		// counts. Verified digests finalize to .done/; injections a crashed
		// process never appended are requeued as pending — re-composed into a
		// fresh digest at the next drain (a re-delivered escalation surfaces
		// again instead of silently stranding its subagent in `waiting`).
		let requeued = 0;
		try {
			requeued = reconcileMainMailFor(ctx.cwd).requeued.length;
		} catch {
			// Reconciliation must never break a session start.
		}
		// TUI sessions get the ambient widget up front (it must show queued
		// mail from PREVIOUS sessions before any tool call re-creates the
		// core); headless modes stay fully lazy as before.
		if (ctx.hasUI) installWidget(ctx);
		// Crash-requeued wake-worthy mail gets its D16 auto-wake back right
		// away in TUI sessions (installWidget already built the core there;
		// headless stays lazy — the next real user turn's before_agent_start
		// digest picks the mail up instead). Normal D21 gates apply.
		if (requeued > 0 && ctx.hasUI && core) {
			const current = core;
			if (current.settings.autoWake && !current.autonomy.paused && !mainBusy && current.mainHasWakeWorthy()) {
				triggerWake();
			}
		}
		// Phase 7 retention GC: archive funerals, processed .done/ mail, and
		// resolved escalation records past archiveGcDays (default 7). Cheap
		// directory scans, off the session-start path (unref'd — a short-lived
		// headless run must never be held open for GC), errors swallowed.
		const cwd = ctx.cwd;
		const timer = setTimeout(() => {
			try {
				runGcSweepFor(cwd);
			} catch {
				// GC must never break a session.
			}
		}, 0);
		timer.unref?.();
	});
	pi.on("session_shutdown", async () => {
		uiCtx?.ui.setStatus(WIDGET_KEY, undefined);
		uiCtx = undefined;
		await releaseCore();
	});
}
