/**
 * Steer / Queue — give the user control over messages typed while the agent is busy.
 *
 * Native Pi behavior: submit while the agent is streaming → the message is
 * *steered* (delivered at the next steering checkpoint, shown as "Steering: …");
 * Alt+Enter instead *queues* it as a follow-up ("Follow-up: …"). Once that message
 * is in Pi's native queue there is no way (from an extension) to cancel it or flip
 * it between steer/queue — the extension API exposes no queue read/clear/convert.
 *
 * So this extension *owns* the pending messages instead of letting Pi steer them:
 *
 *   1. on("input"): when a plain message is submitted while the agent is busy
 *      (`event.streamingBehavior` is set), we capture the text and return
 *      { action: "handled" } — which makes Pi's prompt() return *before* it
 *      queues a native steer (see agent-session.js: the input event fires first
 *      and "handled" short-circuits). The editor was already cleared by the
 *      submit handler, so the message simply moves into our own queue. Each
 *      submission becomes a SEPARATE queue entry (order preserved); the whole
 *      queue has ONE mode (steer vs queue), initialized from how the first
 *      entry was submitted (Enter → steer, Alt+Enter → queue).
 *
 *   2. A custom widget (ctx.ui.setWidget, placement "aboveEditor") shows the
 *      entry count plus a truncated first-line preview of each pending entry and
 *      the keybind hints just above the main input textbox, in a customMessageBg
 *      box (background fill + padding) so it reads as a block. (Injecting into
 *      the scrolling transcript is not possible from an extension while the
 *      agent streams — sendMessage() then routes into the agent's steer/follow-up
 *      queue instead of drawing an entry.)
 *
 *      The widget is registered ONCE (on session_start) as a live component that
 *      reads the module-scope `entries` on every render — it is never re-set on
 *      toggle/cancel. This matters for stacking order: above-editor widgets render
 *      in map-insertion order and re-setting a key moves it to the bottom, so a
 *      widget that re-sets on every change keeps sinking below sibling status
 *      lines. Registering once keeps us put; dir-git re-asserts itself on
 *      agent_start (sinking below us), so our pending block sits above it.
 *
 *   3. Keybinds (pi.registerShortcut):
 *        - alt+x : cancel — discard the MOST RECENT pending entry (when the last
 *                  one goes, the widget hides).
 *        - alt+q : toggle — flip the WHOLE queue between steer and queue mode.
 *      Both call ctx.ui.notify(), which requests a render so the live widget
 *      reflects the change immediately.
 *
 *   4. /queue (alias /steer) opens a management panel (see panel.ts): edit an
 *      entry, delete one, send one NOW, reorder (move up/down), toggle the
 *      queue's mode. The panel talks to the queue through a QueueController and
 *      refreshes live when deliveries/keybinds mutate the queue while it is open.
 *
 *   5. Delivery — we hand the messages back to Pi (pi.sendUserMessage) at the
 *      point that matches the queue's mode, so the real steer-vs-queue timing is
 *      preserved. Entries are delivered as SEPARATE messages, in order:
 *        - "steer"  → at the next turn_end, every entry is pushed into Pi's
 *                     native steering queue (one sendUserMessage per entry with
 *                     deliverAs "steer"); the agent loop drains that queue at the
 *                     next step boundary as separate user messages, in order.
 *                     The whole current step is the window during which alt+x /
 *                     alt+q / /queue still work.
 *        - "queue"  → at agent_end. If the agent is somehow still streaming, all
 *                     entries are pushed as native follow-ups (separate messages,
 *                     in order). In the normal (idle) case sendUserMessage starts
 *                     a fresh turn and awaits the ENTIRE run, so only the FIRST
 *                     entry is sent then; each remaining entry goes out at the
 *                     following agent_end — one entry per agent run, still
 *                     separate messages, still in order (and still cancellable
 *                     via alt+x / /queue in between).
 *      agent_end also flushes any still-held entries as a final safety net.
 *
 * Only plain interactive messages are intercepted — slash commands ("/…") and the
 * idle (non-streaming) path are left completely untouched.
 *
 * Install: ~/.pi/agent/extensions/steer-queue/index.ts
 * Reload:  restart Pi (event/shortcut registrations are read at startup; /reload
 *          re-runs the factory, which is enough for this extension).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { createQueuePanel, type QueueController, type QueueMode } from "./panel.ts";

const WIDGET_KEY = "steer-queue-pending";
const CANCEL_KEY = "alt+x";
const TOGGLE_KEY = "alt+q";
// Widget preview: at most this many entries get their own line; the rest fold
// into a "… +N more" line so the widget never crowds out the editor.
const MAX_PREVIEW_ENTRIES = 5;

// Minimal shape for attached images; we pass them straight back to sendUserMessage.
interface ImageLike {
	type: "image";
	[k: string]: unknown;
}

interface QueueEntry {
	text: string;
	images?: ImageLike[];
}

export default function steerQueue(pi: ExtensionAPI) {
	// The pending-message queue (module-scope, one per session), oldest first.
	// One mode for the whole queue — set by the first entry's submit style,
	// flipped by alt+q or the panel's `t`.
	let entries: QueueEntry[] = [];
	let mode: QueueMode = "steer";

	// The /queue panel subscribes here so it refreshes when the queue changes
	// underneath it (keybinds, deliveries). Null when no panel is open.
	let onQueueChange: (() => void) | null = null;

	function changed() {
		onQueueChange?.();
	}

	// ---- widget (registered once, reads `entries` live) ---------------------

	function lines(theme: Theme, width: number): string[] {
		if (entries.length === 0) return [];
		const label =
			mode === "steer"
				? theme.fg("accent", `Steering (${entries.length})`)
				: theme.fg("success", `Queued (${entries.length})`);
		const out: string[] = [label];
		const shown = entries.slice(0, MAX_PREVIEW_ENTRIES);
		for (let i = 0; i < shown.length; i++) {
			const firstLine = shown[i].text.split("\n")[0]?.trim() || "(empty)";
			const imageMark = shown[i].images?.length ? theme.fg("warning", " ⧉") : "";
			out.push(
				truncateToWidth(theme.fg("dim", ` ${i + 1}. `) + theme.fg("text", firstLine), Math.max(8, width), "…") +
					imageMark,
			);
		}
		if (entries.length > MAX_PREVIEW_ENTRIES) {
			out.push(theme.fg("dim", `    … +${entries.length - MAX_PREVIEW_ENTRIES} more`));
		}
		const toggleLabel = mode === "steer" ? "switch to queue" : "switch to steer";
		out.push(
			theme.fg("dim", "↳ ") +
				theme.fg("warning", CANCEL_KEY) +
				theme.fg("dim", " cancel last · ") +
				theme.fg("warning", TOGGLE_KEY) +
				theme.fg("dim", ` ${toggleLabel} · `) +
				theme.fg("warning", "/queue") +
				theme.fg("dim", " manage"),
		);
		return out;
	}

	function registerWidget(ctx: Ctx) {
		if (!ctx.hasUI) return;
		// Live component: render() reads `entries` + the current theme every frame,
		// so we never call setWidget again (which would re-sink us). Renders 0 lines
		// when nothing is pending, so it costs no space then.
		ctx.ui.setWidget(
			WIDGET_KEY,
			() => ({
				invalidate() {},
				render: (width: number): string[] => {
					const theme = ctx.ui.theme;
					// Box(1,1) pads one column each side — truncate previews to fit inside.
					const rendered = lines(theme, width - 4);
					if (rendered.length === 0) return [];
					// Background fill + padding (Pi's customMessageBg styling) so the
					// pending messages read as a distinct block.
					const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
					box.addChild(new Text(rendered.join("\n"), 0, 0));
					// Trailing blank (unfilled) line = margin between the box and the
					// input box below it.
					return [...box.render(width), ""];
				},
			}),
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", (_event, ctx) => registerWidget(ctx as unknown as Ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		const c = ctx as unknown as Ctx;
		if (c.hasUI) c.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
	});

	// ---- delivery -----------------------------------------------------------

	// Hand one entry back to Pi. With deliverAs set (streaming) it routes through
	// the native steer/follow-up queue; without it (idle) it starts a fresh turn.
	function deliverEntry(entry: QueueEntry, deliverAs?: QueueMode) {
		const opts = deliverAs ? { deliverAs } : undefined;
		if (entry.images && entry.images.length > 0) {
			pi.sendUserMessage([{ type: "text", text: entry.text }, ...(entry.images as never[])], opts);
		} else {
			pi.sendUserMessage(entry.text, opts);
		}
	}

	// While streaming: push every entry into the matching native queue, in order.
	// Each entry stays a separate user message (the agent loop drains the whole
	// steering/follow-up queue as individual messages).
	function flushStreaming(deliverAs: QueueMode) {
		const batch = entries;
		entries = [];
		for (const entry of batch) deliverEntry(entry, deliverAs);
		changed();
	}

	// ---- intercept ----------------------------------------------------------

	pi.on("input", (event) => {
		// Only act when the agent is busy (streamingBehavior is set only then).
		if (!event.streamingBehavior) return;
		// Only interactive typing; leave programmatic / extension-driven input alone.
		if (event.source !== "interactive") return;
		// Never swallow slash commands — they must reach Pi to execute.
		if (event.text.trimStart().startsWith("/")) return;

		// First entry decides the queue's mode; later submissions just append
		// (flip the whole queue with alt+q or the panel's `t`).
		if (entries.length === 0) mode = event.streamingBehavior;
		entries.push({ text: event.text, images: event.images as ImageLike[] | undefined });
		changed();
		// No setWidget call — the live widget picks this up on the render that the
		// submit handler requests right after prompt() returns.
		return { action: "handled" as const };
	});

	// ---- auto-delivery ------------------------------------------------------

	// Steered entries interrupt at the next step boundary: push them all into the
	// native steering queue while the agent is still streaming.
	pi.on("turn_end", (_event, ctx) => {
		if (entries.length === 0 || mode !== "steer") return;
		if (!(ctx as unknown as Ctx).isIdle()) flushStreaming("steer");
		// Idle at turn_end → agent_end follows immediately and flushes there.
	});

	// Queued entries (and any stragglers) are delivered once the agent is done.
	pi.on("agent_end", (_event, ctx) => {
		if (entries.length === 0) return;
		if (!(ctx as unknown as Ctx).isIdle()) {
			// Still streaming (rare at agent_end): all entries fit in the native
			// follow-up queue as separate messages.
			flushStreaming("followUp");
			return;
		}
		// Idle: sendUserMessage starts a fresh turn and awaits the whole run, so
		// send only the FIRST entry now; the rest go out one per following
		// agent_end (separate messages, order preserved, still cancellable).
		const entry = entries.shift();
		if (entry) deliverEntry(entry);
		changed();
	});

	// ---- keybinds -----------------------------------------------------------

	pi.registerShortcut(CANCEL_KEY, {
		description: "Cancel the most recent pending message",
		handler: (ctx) => {
			if (entries.length === 0) return;
			entries.pop();
			changed();
			const left = entries.length > 0 ? ` (${entries.length} left)` : "";
			(ctx as unknown as Ctx).ui.notify(`Last pending message cancelled${left}`, "info");
		},
	});

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Toggle the pending messages between steer and queue",
		handler: (ctx) => {
			if (entries.length === 0) return;
			mode = mode === "steer" ? "followUp" : "steer";
			changed();
			(ctx as unknown as Ctx).ui.notify(
				mode === "steer" ? "Pending messages will steer" : "Pending messages will queue as follow-ups",
				"info",
			);
		},
	});

	// ---- /queue panel --------------------------------------------------------

	async function runQueuePanel(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/queue requires interactive TUI mode", "error");
			return;
		}
		if (entries.length === 0) {
			ctx.ui.notify("No pending messages (type while the agent is busy to add one)", "info");
			return;
		}

		const ctrl: QueueController = {
			entries: () => entries.map((e) => ({ text: e.text, imageCount: e.images?.length ?? 0 })),
			mode: () => mode,
			toggleMode: () => {
				mode = mode === "steer" ? "followUp" : "steer";
				changed();
				return mode;
			},
			removeAt: (index) => {
				if (index < 0 || index >= entries.length) return;
				entries.splice(index, 1);
				changed();
			},
			updateText: (index, text) => {
				const entry = entries[index];
				if (!entry) return;
				entry.text = text;
				changed();
			},
			moveBy: (index, delta) => {
				const target = index + delta;
				if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) return index;
				const [entry] = entries.splice(index, 1);
				entries.splice(target, 0, entry!);
				changed();
				return target;
			},
			sendNow: (index) => {
				const entry = entries[index];
				if (!entry) return;
				entries.splice(index, 1);
				// Same delivery path as turn_end/agent_end: while streaming, the
				// steering queue is the soonest checkpoint there is ("NOW");
				// when idle it simply starts a fresh turn.
				const idle = ctx.isIdle();
				deliverEntry(entry, idle ? undefined : "steer");
				changed();
				ctx.ui.notify(idle ? "Message sent" : "Message steering in (next step boundary)", "info");
			},
			setOnChange: (cb) => {
				onQueueChange = cb;
			},
		};

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
			createQueuePanel({ ctrl, tui, theme, onDone: () => done(undefined) }),
		);
	}

	const queueCommand = {
		description: "Manage pending messages — edit, reorder, send now, delete, toggle steer/queue",
		handler: async (_args: string, ctx: ExtensionCommandContext) => runQueuePanel(ctx),
	};
	// /queue is the primary name; /steer stays as an alias.
	pi.registerCommand("queue", queueCommand);
	pi.registerCommand("steer", queueCommand);
}

// ---- local structural types (avoid importing internal UI typings) ----------

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
}

type WidgetFactory = () => { render(width: number): string[]; invalidate?(): void };

interface Ctx {
	hasUI: boolean;
	isIdle(): boolean;
	ui: {
		theme: Theme;
		setWidget(
			key: string,
			content: WidgetFactory | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}
