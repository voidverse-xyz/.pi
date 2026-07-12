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
