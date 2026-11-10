import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Render terminal control bytes as visible escapes while preserving tabs/newlines. */
export function escapeTerminalControls(value: string): string {
	return value.replace(CONTROL, (char) => {
		const code = char.charCodeAt(0);
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

/** Bound newline-dense content without allocating an array for every line. */
export function capDisplayLines(value: string, maxLines: number, marker: string): string {
	let cursor = 0;
	for (let line = 0; line < maxLines; line++) {
		const newline = value.indexOf("\n", cursor);
		if (newline < 0) return value;
		cursor = newline + 1;
	}
	return cursor >= value.length ? value : `${value.slice(0, cursor)}${marker}`;
}

/** Pad a (possibly ANSI-styled) string to an exact visible width with trailing spaces. */
export function padToWidth(content: string, width: number): string {
	return content + " ".repeat(Math.max(0, width - visibleWidth(content)));
}

/** Truncate to `width` (with an ellipsis) then pad to exactly that visible width. */
export function clipPad(content: string, width: number): string {
	return padToWidth(truncateToWidth(content, Math.max(0, width), "…"), width);
}

// DynamicBorder is stateless; reuse one per theme instead of allocating per rule.
const ruleBorders = new WeakMap<Theme, DynamicBorder>();

/** A muted horizontal rule spanning `width` columns. */
export function rule(theme: Theme, width: number): string {
	let border = ruleBorders.get(theme);
	if (!border) {
		border = new DynamicBorder((s: string) => theme.fg("borderMuted", s));
		ruleBorders.set(theme, border);
	}
	return border.render(Math.max(1, width))[0] ?? "";
}
