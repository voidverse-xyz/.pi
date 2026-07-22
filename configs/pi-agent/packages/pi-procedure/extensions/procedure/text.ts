/** text.ts — tiny shared text helpers for previews/summaries. */

/** Flatten all whitespace runs to single spaces, trim, and ellipsis-truncate to `max` chars. */
export function truncateFlat(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
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
