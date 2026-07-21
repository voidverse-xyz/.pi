/**
 * text.ts — tiny shared text helpers (truncation + label derivation). Pure
 * module: no fs, no runtime imports.
 */

/** Hard limit for human display labels (spawn tool schema + runtime validation). */
export const MAX_LABEL_CHARS = 80;

/**
 * Truncate to at most `max` characters, replacing the tail with a single `…`
 * when over. Counts UTF-16 units (same as every call site it replaced).
 */
export function ellipsize(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Build a one-line, tail-biased summary from provider-visible thinking output. */
export function liveThinkingSummary(text: string, max = 96): string {
	const prefix = "Thinking: ";
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return "thinking…";
	const budget = Math.max(1, max - prefix.length);
	const chars = Array.from(flat);
	if (chars.length <= budget) return `${prefix}${flat}`;
	const tail = chars.slice(-(budget - 1)).join("").trimStart();
	return `${prefix}…${tail}`;
}

/**
 * Derive a display label from free task/prompt text: strip light markdown,
 * flatten whitespace, prefer the first sentence, and cap at MAX_LABEL_CHARS
 * (code-point aware). Returns "" when nothing usable remains — callers supply
 * their own fallback (address, "subagent", …).
 */
export function labelFromSource(source: string): string {
	const flat = source.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
	const sentence = flat.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? flat;
	if (!sentence) return "";
	const chars = Array.from(sentence);
	return chars.length <= MAX_LABEL_CHARS ? sentence : `${chars.slice(0, MAX_LABEL_CHARS - 1).join("").trimEnd()}…`;
}
