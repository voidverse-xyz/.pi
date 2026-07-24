/**
 * text.ts — tiny shared plain-text helpers. PURE, dependency-free.
 *
 * One home for the collapse-whitespace-and-cap idiom (display labels, tool
 * summaries, sandbox confirmations) and for flattening a Pi session message's
 * content parts to a single line. Keeping these here prevents the three copies
 * that existed before from drifting.
 */

/** Collapse whitespace runs to single spaces and trim. */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Collapse whitespace, then cap at `max` chars with a trailing ellipsis when longer. */
export function collapseAndCap(text: string, max: number): string {
	const flat = collapseWhitespace(text);
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
	return collapseWhitespace(current) ? current : latest;
}

/** Build a live, tail-biased summary from provider-visible thinking output. */
export function liveThinkingSummary(text: string, max = 96): string {
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 96;
	const flat = collapseWhitespace(text);
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
 * Flatten a session message's `content` (string or part array) to plain text.
 * With `placeholders`, non-text parts render as "[type]" markers and parts join
 * with spaces (transcript-tail style); without, only text parts concatenate
 * (prompt-text style).
 */
export function flattenMessageContent(content: unknown, placeholders = false): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	if (placeholders) {
		return content
			.map((part) => {
				const p = part as { type?: string; text?: string };
				if (p.type === "text" && typeof p.text === "string") return p.text;
				return p.type ? `[${p.type}]` : "";
			})
			.filter(Boolean)
			.join(" ");
	}
	return content.map((p) => ((p as { type?: string; text?: string }).type === "text" ? ((p as { text?: string }).text ?? "") : "")).join("");
}
