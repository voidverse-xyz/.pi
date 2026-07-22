/**
 * script/meta.ts — extract and validate the `export const meta = {...}` header.
 *
 * The meta object must be a PURE LITERAL. It is located with a
 * string/template/comment-aware brace matcher, evaluated ALONE in a bare vm
 * context (so identifiers, calls, and spreads of outside values fail), and
 * shape-validated. The returned `body` is the source with the meta statement
 * blanked IN PLACE (non-newline chars → spaces) so vm error line numbers still
 * map to the original script.
 */

import vm from "node:vm";

export interface ProcedureMeta {
	name: string;
	description: string;
	/** Normalized phase titles (accepts strings or {title, detail} objects). */
	phases: string[];
}

export interface MetaExtraction {
	/** null when the script has no meta statement. */
	meta: ProcedureMeta | null;
	/** Source with the meta statement blanked (line numbers preserved). */
	body: string;
}

const META_START_RE = /(^|\n)[ \t]*export\s+const\s+meta\s*=\s*/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Scan forward from an opening `{`, honoring strings, template literals
 * (including nested `${}`), and comments. Returns the index just past the
 * matching `}` or throws.
 */
function matchBraces(source: string, openIndex: number): number {
	let depth = 0;
	let i = openIndex;
	while (i < source.length) {
		const ch = source[i]!;
		const next = source[i + 1];
		if (ch === "/" && next === "/") {
			const nl = source.indexOf("\n", i);
			i = nl === -1 ? source.length : nl + 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			if (end === -1) throw new Error("Unterminated block comment inside the meta literal.");
			i = end + 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(source, i, ch);
			continue;
		}
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
		i++;
	}
	throw new Error("Unbalanced braces in the meta literal.");
}

/** Skip a quoted string/template starting at `start` (its quote char). Returns index past the close. */
function skipString(source: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < source.length) {
		const ch = source[i]!;
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (quote === "`" && ch === "$" && source[i + 1] === "{") {
			// nested ${expr} — reuse the brace matcher (it handles inner strings)
			i = matchBraces(source, i + 1);
			continue;
		}
		if (ch === quote) return i + 1;
		if (quote !== "`" && ch === "\n") throw new Error("Unterminated string in the meta literal.");
		i++;
	}
	throw new Error("Unterminated string in the meta literal.");
}

/** Evaluate the literal alone; anything that references the outside world throws. */
function evaluateMetaLiteral(literal: string): unknown {
	try {
		return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 200 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`The meta object must be a pure literal (no variables, calls, spreads, or interpolation): ${message}`,
		);
	}
}

function normalizePhases(raw: unknown): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error("meta.phases must be an array.");
	// build the result in the HOST realm — raw comes from a vm context, and
	// raw.map() would hand back a vm-realm array with a foreign prototype
	const phases: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry: unknown = raw[i];
		if (typeof entry === "string" && entry.trim().length > 0) {
			phases.push(entry);
		} else if (typeof entry === "object" && entry !== null && typeof (entry as { title?: unknown }).title === "string") {
			phases.push((entry as { title: string }).title);
		} else {
			throw new Error(`meta.phases[${i}] must be a non-empty string or {title} object.`);
		}
	}
	return phases;
}

function validateMeta(value: unknown): ProcedureMeta {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("meta must be an object literal.");
	}
	const m = value as Record<string, unknown>;
	if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
		throw new Error("meta.name must be a string matching /^[a-z0-9][a-z0-9._-]*$/i.");
	}
	if (m.description !== undefined && typeof m.description !== "string") {
		throw new Error("meta.description must be a string.");
	}
	return {
		name: m.name,
		description: typeof m.description === "string" ? m.description : "",
		phases: normalizePhases(m.phases),
	};
}

/** Blank a span in place: every non-newline char becomes a space. */
function blankSpan(source: string, start: number, end: number): string {
	const blanked = source.slice(start, end).replace(/[^\n]/g, " ");
	return source.slice(0, start) + blanked + source.slice(end);
}

/**
 * Extract the meta header from a procedure script. Throws with a descriptive
 * message on any malformed meta; returns `{meta: null, body: source}` when the
 * script simply has none.
 */
export function extractMeta(source: string): MetaExtraction {
	const match = META_START_RE.exec(source);
	if (!match) return { meta: null, body: source };

	const stmtStart = match.index + match[1]!.length;
	const literalStart = match.index + match[0].length;
	if (source[literalStart] !== "{") {
		throw new Error("meta must be assigned an object literal ({...}).");
	}
	const literalEnd = matchBraces(source, literalStart);
	const literal = source.slice(literalStart, literalEnd);

	// consume an optional trailing semicolon
	let stmtEnd = literalEnd;
	while (stmtEnd < source.length && (source[stmtEnd] === " " || source[stmtEnd] === "\t")) stmtEnd++;
	if (source[stmtEnd] === ";") stmtEnd++;

	// a second `export const meta` is a script bug worth naming
	if (META_START_RE.test(source.slice(stmtEnd))) {
		throw new Error("Multiple `export const meta` statements found — a procedure script may have only one.");
	}

	const meta = validateMeta(evaluateMetaLiteral(literal));
	return { meta, body: blankSpan(source, stmtStart, stmtEnd) };
}
