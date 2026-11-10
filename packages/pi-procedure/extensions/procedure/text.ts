/** text.ts — tiny shared text helpers for previews/summaries. */

/** Flatten all whitespace runs to single spaces, trim, and ellipsis-truncate to `max` chars. */
export function truncateFlat(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export const THINKING_PLACEHOLDER = "thinking…";
export const THINKING_SUFFIX = ` · ${THINKING_PLACEHOLDER}`;

const codePointLength = (text: string): number => Array.from(text).length;

function fitPlaceholder(max: number): string {
	const chars = Array.from(THINKING_PLACEHOLDER);
	if (max <= 0) return "";
	if (chars.length <= max) return THINKING_PLACEHOLDER;
	if (max === 1) return "…";
	return `${chars.slice(0, max - 1).join("")}…`;
}

/** Keep the previous clue until the current thinking block has visible text. */
export function retainLatestThought(latest: string, current: string): string {
	return current.replace(/\s+/g, " ").trim() ? current : latest;
}

/** Build a live, tail-biased summary from provider-visible thinking output. */
export function liveThinkingSummary(text: string, max = 96): string {
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 96;
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return fitPlaceholder(limit);
	const suffixLength = codePointLength(THINKING_SUFFIX);
	if (limit <= suffixLength) return fitPlaceholder(limit);
	const budget = limit - suffixLength;
	const chars = Array.from(flat);
	if (chars.length <= budget) return `${flat}${THINKING_SUFFIX}`;
	const tail = budget === 1 ? "…" : `…${chars.slice(-(budget - 1)).join("").trimStart()}`;
	return `${tail}${THINKING_SUFFIX}`;
}

/** Tail-fit a rendered thinking summary while preserving its active suffix. */
export function fitThinkingSummary(summary: string, max: number, measure = codePointLength): string {
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 96;
	if (measure(summary) <= limit) return summary;
	if (!summary.endsWith(THINKING_SUFFIX)) return summary;
	const suffixWidth = measure(THINKING_SUFFIX);
	if (limit <= suffixWidth) return fitPlaceholder(limit);
	const thought = summary.slice(0, -THINKING_SUFFIX.length);
	const tailBudget = limit - suffixWidth - measure("…");
	let tail = "";
	for (const char of Array.from(thought).reverse()) {
		const candidate = `${char}${tail}`;
		if (measure(candidate) > tailBudget) break;
		tail = candidate;
	}
	return `…${tail.trimStart()}${THINKING_SUFFIX}`;
}
