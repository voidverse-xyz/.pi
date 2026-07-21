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

/** Build a one-line, tail-biased summary from provider-visible thinking output. */
export function liveThinkingSummary(text: string, max = 96): string {
	const prefix = "Thinking: ";
	const flat = collapseWhitespace(text);
	if (!flat) return "thinking…";
	const budget = Math.max(1, max - prefix.length);
	const chars = Array.from(flat);
	if (chars.length <= budget) return `${prefix}${flat}`;
	const tail = chars.slice(-(budget - 1)).join("").trimStart();
	return `${prefix}…${tail}`;
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
