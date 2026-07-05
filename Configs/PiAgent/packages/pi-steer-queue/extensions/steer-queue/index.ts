/**
 * Steer / Queue — give the user control over a message typed while the agent is busy.
 *
 * Native Pi behavior: submit while the agent is streaming → the message is
 * *steered* (delivered at the next steering checkpoint, shown as "Steering: …");
 * Alt+Enter instead *queues* it as a follow-up ("Follow-up: …"). Once that message
 * is in Pi's native queue there is no way (from an extension) to cancel it or flip
 * it between steer/queue — the extension API exposes no queue read/clear/convert.
 *
 * So this extension *owns* the pending message instead of letting Pi steer it:
 *
 *   1. on("input"): when a plain message is submitted while the agent is busy
 *      (`event.streamingBehavior` is set), we capture the text and return
 *      { action: "handled" } — which makes Pi's prompt() return *before* it
 *      queues a native steer (see agent-session.js: the input event fires first
 *      and "handled" short-circuits). The editor was already cleared by the
 *      submit handler, so the message simply moves into our own widget.
 *
 *   2. A custom widget (ctx.ui.setWidget, placement "aboveEditor") shows the held
 *      message and the keybind hints just above the main input textbox, in a
 *      customMessageBg box (background fill + padding) so it reads as a block.
 *      (Injecting into the scrolling transcript is not possible from an extension
 *      while the agent streams — sendMessage() then routes into the agent's
 *      steer/follow-up queue instead of drawing an entry.)
 *
 *      The widget is registered ONCE (on session_start) as a live component that
 *      reads the module-scope `pending` on every render — it is never re-set on
 *      toggle/cancel. This matters for stacking order: above-editor widgets render
 *      in map-insertion order and re-setting a key moves it to the bottom, so a
 *      widget that re-sets on every change keeps sinking below sibling status
 *      lines. Registering once keeps us put; dir-git re-asserts itself on
 *      agent_start (sinking below us), so our pending line sits above it.
 *
 *   3. Keybinds (pi.registerShortcut):
 *        - alt+x : cancel — discard the held message, it is never sent.
 *        - alt+q : toggle — flip the held message between steer and queue mode.
 *      Both call ctx.ui.notify(), which requests a render so the live widget
 *      reflects the change immediately.
 *
 *   4. Delivery — we hand the message back to Pi (pi.sendUserMessage) at the point
 *      that matches its mode, so the real steer-vs-queue timing is preserved:
 *        - "steer"  → delivered at the next turn_end, i.e. it interrupts the run at
 *                     the next step boundary. The whole current step is the window
 *                     during which alt+x / alt+q still work.
 *        - "queue"  → delivered at agent_end, after the agent fully finishes.
 *      agent_end also flushes any still-held message as a final safety net.
 *
 * Only plain interactive messages are intercepted — slash commands ("/…") and the
 * idle (non-streaming) path are left completely untouched.
 *
 * Install: ~/.pi/agent/extensions/steer-queue/index.ts
 * Reload:  restart Pi (event/shortcut registrations are read at startup; /reload
 *          re-runs the factory, which is enough for this extension).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const WIDGET_KEY = "steer-queue-pending";
const CANCEL_KEY = "alt+x";
const TOGGLE_KEY = "alt+q";

type Mode = "steer" | "followUp";

// Minimal shape for attached images; we pass them straight back to sendUserMessage.
interface ImageLike {
	type: "image";
	[k: string]: unknown;
}

interface Pending {
	text: string;
	images?: ImageLike[];
	mode: Mode;
}

export default function steerQueue(pi: ExtensionAPI) {
	// Single held message (module-scope, one per session). If a second message is
	// submitted while one is still held, we append it rather than dropping either.
	let pending: Pending | null = null;

	// ---- widget (registered once, reads `pending` live) ---------------------

	function lines(theme: Theme): string[] {
		if (!pending) return [];
		const p = pending;
		const label =
			p.mode === "steer" ? theme.fg("accent", "Steering") : theme.fg("success", "Queued");
		const body = label + theme.fg("dim", `: ${p.text}`);
		const toggleLabel = p.mode === "steer" ? "switch to queue" : "switch to steer";
		const hint =
			theme.fg("dim", "↳ ") +
			theme.fg("warning", CANCEL_KEY) +
			theme.fg("dim", " cancel · ") +
			theme.fg("warning", TOGGLE_KEY) +
			theme.fg("dim", ` ${toggleLabel}`);
		return [body, hint];
	}

	function registerWidget(ctx: Ctx) {
		if (!ctx.hasUI) return;
		// Live component: render() reads `pending` + the current theme every frame,
		// so we never call setWidget again (which would re-sink us). Renders 0 lines
		// when nothing is pending, so it costs no space then.
		ctx.ui.setWidget(
			WIDGET_KEY,
			() => ({
				invalidate() {},
				render: (width: number): string[] => {
					const theme = ctx.ui.theme;
					const rendered = lines(theme);
					if (rendered.length === 0) return [];
					// Background fill + padding (Pi's customMessageBg styling) so the
					// pending message reads as a distinct block.
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

	// Hand the held message back to Pi. When streaming, deliverAs routes it through
	// the native steer/follow-up queue; when idle it just starts a fresh turn.
	function deliver(ctx: Ctx) {
		if (!pending) return;
		const p = pending;
		pending = null;
		const streaming = !ctx.isIdle();
		const opts = streaming ? { deliverAs: p.mode } : undefined;
		if (p.images && p.images.length > 0) {
			pi.sendUserMessage([{ type: "text", text: p.text }, ...(p.images as never[])], opts);
		} else {
			pi.sendUserMessage(p.text, opts);
		}
	}

	// ---- intercept ----------------------------------------------------------

	pi.on("input", (event) => {
		// Only act when the agent is busy (streamingBehavior is set only then).
		if (!event.streamingBehavior) return;
		// Only interactive typing; leave programmatic / extension-driven input alone.
		if (event.source !== "interactive") return;
		// Never swallow slash commands — they must reach Pi to execute.
		if (event.text.trimStart().startsWith("/")) return;

		const images = event.images as ImageLike[] | undefined;
		if (pending) {
			// A message is already held — append and keep the current mode.
			pending.text = `${pending.text}\n${event.text}`;
			if (images && images.length > 0) {
				pending.images = [...(pending.images ?? []), ...images];
			}
		} else {
			pending = { text: event.text, images, mode: event.streamingBehavior };
		}
		// No setWidget call — the live widget picks this up on the render that the
		// submit handler requests right after prompt() returns.
		return { action: "handled" as const };
	});

	// ---- auto-delivery ------------------------------------------------------

	// A steered message interrupts at the next step boundary.
	pi.on("turn_end", (_event, ctx) => {
		if (pending && pending.mode === "steer") deliver(ctx as unknown as Ctx);
	});

	// A queued message (and any straggler) is delivered once the agent is done.
	pi.on("agent_end", (_event, ctx) => {
		if (pending) deliver(ctx as unknown as Ctx);
	});

	// ---- keybinds -----------------------------------------------------------

	pi.registerShortcut(CANCEL_KEY, {
		description: "Cancel the pending message",
		handler: (ctx) => {
			if (!pending) return;
			pending = null;
			(ctx as unknown as Ctx).ui.notify("Pending message cancelled", "info");
		},
	});

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Toggle the pending message between steer and queue",
		handler: (ctx) => {
			if (!pending) return;
			pending.mode = pending.mode === "steer" ? "followUp" : "steer";
			(ctx as unknown as Ctx).ui.notify(
				pending.mode === "steer" ? "Message will steer" : "Message will queue as follow-up",
				"info",
			);
		},
	});
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
