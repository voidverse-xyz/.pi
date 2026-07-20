/**
 * Rendered previews for show_files — which files can render (markdown / HTML,
 * by extension) and a small dependency-free HTML → plain-text converter for the
 * preview pane.
 *
 * htmlToText is explicitly best-effort: strip <script>/<style> and comments,
 * map block-closing tags to newlines and <li> to bullets, drop the remaining
 * tags, decode common + numeric entities, and collapse blank runs. The user can
 * always press `r` for the raw source when fidelity matters.
 */

export type RenderableKind = "md" | "html";

/** Classify a path by extension: markdown, html, or not renderable (null). */
export function renderableKind(absPath: string): RenderableKind | null {
	const ext = absPath.slice(absPath.lastIndexOf(".") + 1).toLowerCase();
	if (ext === "md" || ext === "markdown") return "md";
	if (ext === "html" || ext === "htm") return "html";
	return null;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	copy: "©",
	reg: "®",
	trade: "™",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	bull: "•",
	middot: "·",
	times: "×",
	rarr: "→",
	larr: "←",
};

function decodeEntities(s: string): string {
	return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		if (body.startsWith("#")) {
			const hex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

/** Best-effort HTML → readable plain text (dependency-free tag strip). */
export function htmlToText(html: string): string {
	let s = html;
	s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre|table|ul|ol)\s*>/gi, "\n");
	s = s.replace(/<li\b[^>]*>/gi, "• ");
	s = s.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	s = s.replace(/[ \t]+\n/g, "\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
}
