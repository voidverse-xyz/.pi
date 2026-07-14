/**
 * Subagents — persistent subagents with durable memory and mailbox
 * communication (design: ~/Agents/Documents/Configs/Subagent-Docs/).
 *
 * Extension entry. Registers the full eight-tool surface
 * (03-tool-surface.md): spawn, send, steer, status, collect, interrupt,
 * retire — and wires the MAIN agent's mailbox into the host session:
 *
 *  - Main mail never auto-wakes an idle host. Unrelated queued mail joins the
 *    next genuine user turn.
 *  - Task-bearing spawn/send/collect calls and transitive peer delegations form
 *    a current-user-turn completion group. Candidate finals are suppressed;
 *    durable results/attention continue the same run as follow-up messages.
 *  - Main-mail durability (at-least-once): claims are parked in .delivering/
 *    until verified in the active main session JSONL. Crash recovery requeues
 *    unverified claims at session start.
 *  - All token/time/compaction limits are warning-only. A non-blocking widget
 *    can interrupt only the affected subagent turn or dismiss the warning.
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
	MAIN_MAIL_CUSTOM_TYPE,
	runGcSweepFor,
	type RequiredTaskAnchor,
	type ScopeLocator,
	type SubagentsCore,
} from "./core.ts";
import type { AwaitResult, RuntimeEvent } from "./runtime/types.ts";
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

// The digest-message customType prefix. Lives in core.ts because
// reconciliation greps the main session JSONL for it
// to verify a digest actually landed (main-mailbox at-least-once).
const MAIL_CUSTOM_TYPE = MAIN_MAIL_CUSTOM_TYPE;
const STATUS_KEY = "subagents";
const WARNING_WIDGET_KEY = "subagent-limit-warning";
const STOP_WARNING_KEY = "alt+ctrl+x";
const IGNORE_WARNING_KEY = "alt+ctrl+i";

export default function (pi: ExtensionAPI) {
	let core: SubagentsCore | undefined;
	let activeScope: (ScopeLocator & { persisted: boolean; ephemeralRoot?: string }) | undefined;
	/** Last UI-capable context seen (event handlers get no ctx from runtime events). */
	let uiCtx: ExtensionContext | undefined;
	/** Active host session JSONL for durable mailbox/required-await claims. */
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
	type LimitWarning = Extract<RuntimeEvent, { type: "limit-warning" }> & { id: string };
	const limitWarnings: LimitWarning[] = [];
	let warningSequence = 0;
	let barrierAbort: AbortController | undefined;

	const scopeFor = (ctx: ExtensionContext): ScopeLocator & { persisted: boolean } => {
		const sessionId = ctx.sessionManager.getSessionId();
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		if (activeScope?.sessionId === sessionId) return activeScope;
		return { sessionId, persisted };
	};

	const getCore = (ctx: ExtensionContext): SubagentsCore => {
		if (!core) {
			const scope = scopeFor(ctx);
			core = createCore({
				cwd: ctx.cwd,
				sessionId: scope.sessionId,
				persisted: scope.persisted,
				...(scope.stateContainerRoot !== undefined ? { stateContainerRoot: scope.stateContainerRoot } : {}),
				modelRegistry: ctx.modelRegistry,
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
				const ctx2 = uiCtx;
				if (event.type === "escalation-created") {
					if (ctx2?.hasUI) void surfaceEscalations(ctx2);
					return;
				}
				if (event.type === "limit-warning") {
					limitWarnings.push({ ...event, id: `limit-${++warningSequence}` });
					publishLimitWarning();
				}
			});
		}
		return core;
	};


	const releaseCore = async (): Promise<void> => {
		const current = core;
		core = undefined;
		barrierAbort?.abort();
		barrierAbort = undefined;
		widget?.dispose();
		widget = undefined;
		uiCtx?.ui?.setWidget?.(WARNING_WIDGET_KEY, undefined);
		if (current) await current.dispose();
	};

	const formatLimit = (warning: LimitWarning): string => {
		const unit = warning.limit.includes("Tokens") || warning.limit === "maxTokensTotal"
			? "tokens"
			: warning.limit.includes("Minutes")
				? "minutes"
				: warning.limit.includes("Compactions")
					? "compactions"
					: "turns";
		return `${warning.limit}: ${warning.observed}/${warning.threshold} ${unit}`;
	};

	const publishLimitWarning = (): void => {
		const ctx = uiCtx;
		if (!ctx?.hasUI || ctx.mode !== "tui") return;
		const warning = limitWarnings[0];
		if (!warning) {
			ctx.ui.setWidget(WARNING_WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(
			WARNING_WIDGET_KEY,
			[
				`⚠ Subagent limit warning — ${warning.address}`,
				`${formatLimit(warning)}. The agent is still running.`,
				`${STOP_WARNING_KEY} interrupt only this subagent turn · ${IGNORE_WARNING_KEY} ignore`,
			],
			{ placement: "aboveWorking" },
		);
	};

	const awaitNextRequiredOutcome = async (
		ctx: ExtensionContext,
		current: SubagentsCore,
	): Promise<Array<{ task: RequiredTaskAnchor; result: AwaitResult }> | null> => {
		for (;;) {
			const tasks = current.pendingRequiredTasks();
			if (tasks.length === 0) return null;
			const controller = new AbortController();
			barrierAbort = controller;
			const waits = tasks.map(async (task) => ({
				task,
				result: await current.awaitResult({
					to: task.to,
					waitFor: task.waitFor,
					anchorId: task.anchorId,
					timeoutSeconds: 900,
					sessionFile: currentSessionFile(),
					signal: controller.signal,
				}),
			}));
			try {
				await Promise.race(waits);
				controller.abort();
				const settled = await Promise.allSettled(waits);
				const ready = settled
					.filter((item): item is PromiseFulfilledResult<{ task: RequiredTaskAnchor; result: AwaitResult }> => item.status === "fulfilled")
					.map((item) => item.value)
					.filter((item) => item.result.status !== "timeout");
				if (ready.length === 0) continue;
				return ready;
			} catch {
				controller.abort();
				await Promise.allSettled(waits);
				if (core !== current || ctx.signal?.aborted) return null;
				// A targeted warning action may have cancelled one task. Re-read the
				// group and continue waiting for every remaining required anchor.
			} finally {
				if (barrierAbort === controller) barrierAbort = undefined;
			}
		}
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

	// /agents [<type>/<id> | adopt-legacy | rollback-legacy] — picker, viewer,
	// or human-only cwd-wide state adoption.
	pi.registerCommand("agents", {
		description:
			"Session-owned agent roster; jump to an agent or adopt/rollback legacy cwd-wide state",
		getArgumentCompletions: async (prefix) => {
			const trimmed = prefix.trim();
			const items: Array<{ value: string; label: string }> = [];
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

	pi.registerShortcut(STOP_WARNING_KEY, {
		description: "Subagents: interrupt the warned agent turn",
		handler: async (ctx) => {
			uiCtx = ctx;
			const warning = limitWarnings.shift();
			if (!warning) return;
			const current = getCore(ctx);
			const result = await current.interrupt(warning.address, warning.turnId);
			if (result.interrupted) barrierAbort?.abort();
			publishLimitWarning();
			ctx.ui.notify(
				result.interrupted
					? `Interrupted ${warning.address}'s turn; other agents and main continue.`
					: `${warning.address}'s warned turn had already ended; nothing else was interrupted.`,
				"warning",
			);
		},
	});

	pi.registerShortcut(IGNORE_WARNING_KEY, {
		description: "Subagents: dismiss the current limit warning",
		handler: async (ctx) => {
			uiCtx = ctx;
			limitWarnings.shift();
			publishLimitWarning();
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

	// A genuine idle user input starts one required-task group. Follow-up/steer
	// input stays in the existing group, and extension continuations never reset it.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const current = getCore(ctx);
		current.autonomy.reset();
		if (event.streamingBehavior === undefined) current.beginRequiredTaskGroup();
	});

	// There is no main auto-wake. Queued mailbox traffic joins a genuine user
	// turn, while required task results are consumed by the in-turn barrier.
	pi.on("before_agent_start", async (_event, ctx) => {
		sessionMgr = ctx?.sessionManager ?? sessionMgr;
		if (!core) return;
		// Phase 7: settings files are re-read at every real user turn — edits
		// to ~/.pi/agent/subagents.json / <project>/.pi/subagents.json apply
		// live (warning checks read the same mutable object).
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

	// Suppress a premature user-visible final while required anchors are still
	// outstanding. agent_end below waits directly and queues the actual result
	// as a continuation of this same main run.
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const message = event.message as typeof event.message & { stopReason?: string };
		const pending = core?.pendingRequiredTasks() ?? [];
		if (message.stopReason !== "stop" || pending.length === 0) return;
		return {
			message: {
				...event.message,
				content: [{
					type: "text",
					text: `Waiting for ${pending.length} required subagent task${pending.length === 1 ? "" : "s"} before completing this user turn.`,
				}],
			},
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		sessionMgr = ctx?.sessionManager ?? sessionMgr;
		const lastAssistant = [...(event.messages ?? [])]
			.reverse()
			.find((message) => message.role === "assistant") as { stopReason?: string } | undefined;
		const current = core;
		if (!current) return;
		if (lastAssistant?.stopReason === "aborted") {
			barrierAbort?.abort();
			// Preserve required anchors. The next real input resumes the same
			// completion group rather than silently detaching delegated work.
			return;
		}
		if (lastAssistant?.stopReason !== "stop" || current.pendingRequiredTasks().length === 0) return;
		const outcomes = await awaitNextRequiredOutcome(ctx, current);
		if (!outcomes) return;
		for (const outcome of outcomes) {
			pi.sendMessage(
				{
					customType: "subagent_await-required",
					content:
						`[required subagent result for the current user turn]\n\n` +
						`${JSON.stringify(outcome.result, null, 2)}\n\n` +
						(outcome.result.status === "attention"
							? "Resolve this attention now, then continue waiting. Use ask_user if human input is required. Do not finish the user turn while required tasks remain."
							: "Incorporate this result. The completion barrier will continue waiting for every remaining required task."),
					display: true,
				},
				{ deliverAs: "followUp" },
			);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sessionMgr = ctx?.sessionManager ?? sessionMgr;
		if (core?.pendingRequiredTasks().length === 0) core.clearRequiredTaskGroup();
	});

	// New/resumed/forked session → fresh wiring on next tool call (cwd or
	// registry may differ); shutdown → abort + release every live agent
	// session. Registry/teams/JSONL/mailboxes persist on disk — that's the design.
	pi.on("session_start", async (event, ctx) => {
		limitWarnings.splice(0);
		warningSequence = 0;
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
		uiCtx?.ui?.setStatus(STATUS_KEY, undefined);
		uiCtx?.ui?.setWidget?.(WARNING_WIDGET_KEY, undefined);
		await releaseCore();
		uiCtx = undefined;
		if (activeScope?.ephemeralRoot !== undefined) {
			rmSync(activeScope.ephemeralRoot, { recursive: true, force: true });
		}
		activeScope = undefined;
	});
}
