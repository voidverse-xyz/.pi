/**
 * Countdown-gated confirmation dialog for the command-safety extension.
 *
 * Renders the command and category, then locks the confirm action for `delayMs`
 * with a live countdown before it can be accepted. This forces a deliberate
 * pause rather than a reflexive keypress. Cancelling (Esc / n) is allowed at any
 * time.
 *
 * Fallbacks when the full TUI component isn't available:
 *   - RPC mode (hasUI but not "tui"): enforce the delay with a sleep, then use
 *     the plain confirm dialog.
 *   - No UI (print / json): caller handles this before calling; this returns
 *     false defensively.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface DelayedConfirmOptions {
	/** Category label, e.g. "Destructive". */
	label: string;
	/** Theme color for the header. */
	color: "error" | "warning";
	/** The command being gated. */
	command: string;
	/** Button-enable delay in milliseconds. */
	delayMs: number;
	/** Which confirmation this is, e.g. "1 of 2". Omitted for single-confirm categories. */
	step?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function delayedConfirm(ctx: ExtensionContext, opts: DelayedConfirmOptions): Promise<boolean> {
	if (!ctx.hasUI) return false;

	const title = `${opts.label} command${opts.step ? ` — confirm ${opts.step}` : ""}`;

	// RPC and other non-terminal UI: no custom component, so enforce the delay
	// out-of-band, then use the built-in confirm dialog.
	if (ctx.mode !== "tui") {
		await sleep(opts.delayMs);
		return ctx.ui.confirm(title, `Run this command?\n\n  ${opts.command}`);
	}

	return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		const startedAt = Date.now();
		let cachedLines: string[] | undefined;
		let lastShownSecond = -1;
		let timer: ReturnType<typeof setInterval> | undefined;

		const remainingMs = () => Math.max(0, opts.delayMs - (Date.now() - startedAt));
		const ready = () => remainingMs() <= 0;

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const finish = (value: boolean) => {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			done(value);
		};

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

		function handleInput(data: string) {
			// Cancel is always available.
			if (matchesKey(data, Key.escape) || data === "n" || data === "N") {
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

			const addWrapped = (prefix: string, text: string) => {
				const prefixWidth = visibleWidth(prefix);
				const body = prefixWidth < renderWidth ? wrapTextWithAnsi(text, renderWidth - prefixWidth) : [text];
				const pad = " ".repeat(prefixWidth);
				body.forEach((line, i) => lines.push(`${i === 0 ? prefix : pad}${line}`));
			};

			const divider = theme.fg(opts.color, "─".repeat(renderWidth));
			lines.push(divider);
			for (const line of wrapTextWithAnsi(theme.fg(opts.color, `⚠ ${title}`), renderWidth)) {
				lines.push(line);
			}
			addWrapped(theme.fg("dim", "  $ "), theme.fg("text", opts.command));
			lines.push("");

			if (ready()) {
				addWrapped("  ", theme.fg("success", "Enter / y") + theme.fg("dim", " confirm   ") + theme.fg("warning", "Esc / n") + theme.fg("dim", " cancel"));
			} else {
				const seconds = Math.ceil(remainingMs() / 1000);
				addWrapped(
					"  ",
					theme.fg("dim", "confirm locked for ") +
						theme.fg(opts.color, `${seconds}s`) +
						theme.fg("dim", "   ·   ") +
						theme.fg("warning", "Esc / n") +
						theme.fg("dim", " cancel"),
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
			},
		};
	});
}
