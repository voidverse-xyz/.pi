/** text.ts — tiny shared text helpers for previews/summaries. */

/** Flatten all whitespace runs to single spaces, trim, and ellipsis-truncate to `max` chars. */
export function truncateFlat(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
