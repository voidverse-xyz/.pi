/**
 * Minimal YAML-frontmatter parser for `.pi/agents/*.md` files.
 *
 * Packaged pi extensions may only import pi's bundled modules — no `js-yaml` —
 * so this hand-rolls the small subset agent files use: a leading `---` block of
 * `key: value` lines (values are scalars or short inline `[a, b]` lists),
 * followed by the markdown body (the system prompt). Nothing fancier is needed;
 * anything unrecognized is ignored rather than throwing.
 */

export interface ParsedFile {
	frontmatter: Record<string, string | string[]>;
	body: string;
}

function stripQuotes(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1);
	}
	return t;
}

function parseValue(raw: string): string | string[] {
	const v = raw.trim();
	// Inline list: [a, b, c]
	if (v.startsWith("[") && v.endsWith("]")) {
		return v
			.slice(1, -1)
			.split(",")
			.map((x) => stripQuotes(x))
			.filter((x) => x.length > 0);
	}
	// Comma list without brackets: a, b, c  (only when it clearly has commas)
	if (v.includes(",")) {
		return v.split(",").map((x) => stripQuotes(x)).filter((x) => x.length > 0);
	}
	return stripQuotes(v);
}

export function parseFrontmatter(content: string): ParsedFile {
	const normalized = content.replace(/\r\n/g, "\n");
	const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) {
		return { frontmatter: {}, body: normalized.trim() };
	}
	const [, fmBlock, body] = fmMatch;
	const frontmatter: Record<string, string | string[]> = {};
	for (const line of fmBlock.split("\n")) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1);
		if (!key) continue;
		frontmatter[key] = parseValue(value);
	}
	return { frontmatter, body: body.trim() };
}

/** Coerce a frontmatter field to a string list regardless of scalar/list shape. */
export function asList(v: string | string[] | undefined): string[] {
	if (v === undefined) return [];
	return Array.isArray(v) ? v : [v];
}

/** Coerce a frontmatter field to a single string. */
export function asString(v: string | string[] | undefined): string | undefined {
	if (v === undefined) return undefined;
	return Array.isArray(v) ? v.join(", ") : v;
}
