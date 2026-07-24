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
