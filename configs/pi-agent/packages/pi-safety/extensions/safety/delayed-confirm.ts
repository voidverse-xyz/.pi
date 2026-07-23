/**
 * Countdown-gated confirmation dialog for pi-safety.
 *
 * Renders the command and category, then locks the confirm action for `delayMs`
 * with a live countdown before it can be accepted. This forces a deliberate
 * pause rather than a reflexive keypress. Cancelling (q / n, with Esc as a
 * fallback) is allowed at any time.
 *
 * Fallbacks when the full TUI component isn't available:
 *   - RPC mode (hasUI but not "tui"): enforce the delay with a sleep, then use
 *     the plain confirm dialog.
 *   - No UI (print / json): caller handles this before calling; this returns
 *     false defensively.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CategoryColor } from "./categories.ts";

// Cap on how much of the command is rendered in a confirmation prompt, so a
// pathological command cannot flood the dialog. Display-only; classification
// and auditing always see the full command.
const MAX_DISPLAY_CHARS = 16 * 1024;

const ICON_WARNING = ""; // nf-fa-warning (requires a Nerd Font, like the shield in index.ts)

export interface DelayedConfirmOptions {
	/** Category label, e.g. "Destructive". */
	label: string;
	/** Theme color for the header. */
	color: CategoryColor;
	/** The command being gated. */
	command: string;
	/** Button-enable delay in milliseconds. */
	delayMs: number;
	/** Which confirmation this is, e.g. "1 of 2". Omitted for single-confirm categories. */
	step?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve(true);
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function delayedConfirm(ctx: ExtensionContext, opts: DelayedConfirmOptions): Promise<boolean> {
	if (!ctx.hasUI) return false;

	const title = `${opts.label} command${opts.step ? ` — confirm ${opts.step}` : ""}`;

	// RPC and other non-terminal UI: no custom component, so enforce the delay
	// out-of-band, then use the built-in confirm dialog.
	if (ctx.mode !== "tui") {
		if (!(await sleep(opts.delayMs, ctx.signal))) return false;
		return ctx.ui.confirm(title, `Run this command?\n\n  ${opts.command.slice(0, MAX_DISPLAY_CHARS)}`);
	}

	return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		const startedAt = Date.now();
		let cachedLines: string[] | undefined;
		let lastShownSecond = -1;
		let timer: ReturnType<typeof setInterval> | undefined;
		let finished = false;
		const signal = ctx.signal;

		const remainingMs = () => Math.max(0, opts.delayMs - (Date.now() - startedAt));
		const ready = () => remainingMs() <= 0;

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const finish = (value: boolean) => {
			if (finished) return;
			finished = true;
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			signal?.removeEventListener("abort", abort);
			done(value);
		};
		const abort = () => finish(false);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) finish(false);

		if (!finished) {
			timer = setInterval(() => {
				const seconds = Math.ceil(remainingMs() / 1000);
				if (seconds !== lastShownSecond) {
					lastShownSecond = seconds;
					refresh();
				}
				if (ready() && timer) {
					clearInterval(timer);
					timer = undefined;
				}
			}, 120);
			timer.unref?.();
		}

		function handleInput(data: string) {
			// Cancel is always available.
			if (data === "q" || matchesKey(data, Key.escape) || data === "n" || data === "N") {
				finish(false);
				return;
			}
			// Accept only once the countdown has elapsed.
			if (!ready()) return;
			if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
				finish(true);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const renderWidth = Math.max(1, width);
			const lines: string[] = [];

			const addWrapped = (prefix: string, text: string, maxRows: number) => {
				const prefixWidth = visibleWidth(prefix);
				const usablePrefix = prefixWidth < renderWidth ? prefix : "";
				const usablePrefixWidth = visibleWidth(usablePrefix);
				const body = wrapTextWithAnsi(text, Math.max(1, renderWidth - usablePrefixWidth));
				const visible = body.slice(0, maxRows);
				const pad = " ".repeat(usablePrefixWidth);
				visible.forEach((line, i) => lines.push(`${i === 0 ? usablePrefix : pad}${line}`));
			};

			const divider = theme.fg(opts.color, "─".repeat(renderWidth));
			lines.push(divider);
			for (const line of wrapTextWithAnsi(theme.fg(opts.color, `${ICON_WARNING} ${title}`), renderWidth)) {
				lines.push(line);
			}
			lines.push(""); // padding under the header
			addWrapped(theme.fg("dim", "  $ "), theme.fg("text", opts.command.slice(0, MAX_DISPLAY_CHARS)), 10);
			lines.push("");

			if (ready()) {
				addWrapped("  ", theme.fg("success", "Enter / y") + theme.fg("dim", " confirm   ") + theme.fg("warning", "q / n") + theme.fg("dim", " cancel"), 3);
			} else {
				const seconds = Math.ceil(remainingMs() / 1000);
				addWrapped(
					"  ",
					theme.fg("dim", "confirm locked for ") +
						theme.fg(opts.color, `${seconds}s`) +
						theme.fg("dim", "   ·   ") +
						theme.fg("warning", "q / n") +
						theme.fg("dim", " cancel"),
					3,
				);
			}
			lines.push(divider);

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
			dispose: () => {
				if (timer) clearInterval(timer);
				signal?.removeEventListener("abort", abort);
			},
		};
	});
}
