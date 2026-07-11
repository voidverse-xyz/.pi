/**
 * typedefs/parse.ts — YAML-frontmatter parser + validation for subagent type
 * .md files (04-type-schema.md; D6/D18/D19/D20).
 *
 * A type file is:
 *
 *   ---
 *   name: refactorer
 *   description: ...
 *   tools: [read, grep, edit]
 *   readOnly: false
 *   maxTokensTotal: 500000
 *   ---
 *   You are a refactoring specialist...   ← body = role prose (context layer 3)
 *
 * The frontmatter parser is a deliberate RESTRICTED YAML SUBSET, hand-rolled
 * (no dependency): top-level `key: value` pairs where value is a scalar
 * (string/number/boolean) or an inline string array `[a, b, "c"]`. Anything
 * fancier — nested maps, block lists, multi-line strings, anchors — is a hard
 * error with a clear message. Type files are authored config; failing loud
 * beats guessing.
 *
 * Validation enforces the D20 schema exactly: required name (must equal the
 * filename stem) + description; optional model, thinking, projectContext,
 * tools, readOnly, writePaths, denyPaths, maxTokensTotal, maxTurnMinutes,
 * maxContextCompactions. Unknown fields are rejected (D19: frontmatter is the
 * whole contract; typos must not silently no-op).
 *
 * Pure module: strings in, result out.
 */

/** Pi thinking levels (matches @earendil-works/pi-ai's ThinkingLevel). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Validated frontmatter of a type .md (04-type-schema.md field table). */
export interface TypeConfig {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	/** Default true; false omits the AGENTS.md context layer (D18). */
	projectContext: boolean;
	/** Tool-name allowlist; undefined = all coding tools. */
	tools?: string[];
	/** Hard read-only shorthand; default false. */
	readOnly: boolean;
	/** Mutation glob scope; undefined = cwd. */
	writePaths?: string[];
	/** Mutation-forbidden globs, beats writePaths on overlap; default []. */
	denyPaths: string[];
	/** Budget ceilings (D15); undefined = global setting. */
	maxTokensTotal?: number;
	maxTurnMinutes?: number;
	maxContextCompactions?: number;
}

/** A fully parsed type definition. */
export interface TypeDefinition {
	config: TypeConfig;
	/** Markdown body — the agent's role prose (D18 layer 3). */
	body: string;
}

export type ParseResult = { ok: true; def: TypeDefinition } | { ok: false; errors: string[] };

/**
 * Parse and validate one type .md. `filenameStem` is the file's basename
 * without .md — `name` must equal it (04: runtime errors on mismatch).
 */
export function parseTypeFile(content: string, filenameStem: string): ParseResult {
	const split = splitFrontmatter(content);
	if (!split.ok) return { ok: false, errors: split.errors };

	const parsed = parseYamlSubset(split.frontmatter);
	if (!parsed.ok) return { ok: false, errors: parsed.errors };

	const validated = validateConfig(parsed.values, filenameStem);
	if (!validated.ok) return validated;

	return { ok: true, def: { config: validated.def.config, body: split.body.trim() } };
}

// ---------------------------------------------------------------------------
// Frontmatter split
// ---------------------------------------------------------------------------

function splitFrontmatter(
	content: string,
): { ok: true; frontmatter: string; body: string } | { ok: false; errors: string[] } {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { ok: false, errors: ['type file must start with a "---" frontmatter block'] };
	}
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === "---") {
			return {
				ok: true,
				frontmatter: lines.slice(1, i).join("\n"),
				body: lines.slice(i + 1).join("\n"),
			};
		}
	}
	return { ok: false, errors: ['frontmatter block is not closed (missing terminating "---")'] };
}

// ---------------------------------------------------------------------------
// Restricted YAML subset
// ---------------------------------------------------------------------------

type YamlValue = string | number | boolean | string[];

function parseYamlSubset(
	frontmatter: string,
): { ok: true; values: Record<string, YamlValue> } | { ok: false; errors: string[] } {
	const values: Record<string, YamlValue> = {};
	const errors: string[] = [];

	for (const [index, rawLine] of frontmatter.split("\n").entries()) {
		const lineNo = index + 2; // 1-based, +1 for the opening "---"
		const line = rawLine.trimEnd();
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		if (/^\s/.test(line)) {
			errors.push(`line ${lineNo}: indented lines (nested maps / block lists / continuations) are not supported`);
			continue;
		}
		const colon = line.indexOf(":");
		if (colon <= 0) {
			errors.push(`line ${lineNo}: expected "key: value", got ${JSON.stringify(line)}`);
			continue;
		}
		const key = line.slice(0, colon).trim();
		const rawValue = line.slice(colon + 1).trim();
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
			errors.push(`line ${lineNo}: invalid key ${JSON.stringify(key)}`);
			continue;
		}
		if (key in values) {
			errors.push(`line ${lineNo}: duplicate key "${key}"`);
			continue;
		}
		if (rawValue === "") {
			errors.push(`line ${lineNo}: "${key}" has no value (multi-line values are not supported)`);
			continue;
		}
		const value = parseScalarOrArray(rawValue, lineNo, key, errors);
		if (value !== undefined) values[key] = value;
	}

	return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

function parseScalarOrArray(
	raw: string,
	lineNo: number,
	key: string,
	errors: string[],
): YamlValue | undefined {
	if (raw.startsWith("[")) {
		if (!raw.endsWith("]")) {
			errors.push(`line ${lineNo}: "${key}": array must open and close on one line`);
			return undefined;
		}
		const inner = raw.slice(1, -1).trim();
		if (inner === "") return [];
		const parts = splitTopLevelCommas(inner);
		if (parts === null) {
			errors.push(`line ${lineNo}: "${key}": unterminated quoted array item`);
			return undefined;
		}
		const items: string[] = [];
		for (const part of parts) {
			const item = part.trim();
			if (item.startsWith("[") || item.startsWith("{")) {
				errors.push(`line ${lineNo}: "${key}": nested arrays/objects are not supported`);
				return undefined;
			}
			const parsed = parseStringToken(item);
			if (parsed.error !== undefined) {
				errors.push(`line ${lineNo}: "${key}": ${parsed.error}`);
				return undefined;
			}
			items.push(parsed.value);
		}
		return items;
	}
	if (raw.startsWith("{")) {
		errors.push(`line ${lineNo}: "${key}": inline objects are not supported`);
		return undefined;
	}
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
	if (raw === "|" || raw === ">" || raw.startsWith("|") || raw.startsWith(">")) {
		errors.push(`line ${lineNo}: "${key}": block scalars (| / >) are not supported`);
		return undefined;
	}
	if (raw.startsWith("&") || raw.startsWith("*")) {
		errors.push(`line ${lineNo}: "${key}": YAML anchors/aliases are not supported`);
		return undefined;
	}
	const parsed = parseStringToken(raw);
	if (parsed.error !== undefined) {
		errors.push(`line ${lineNo}: "${key}": ${parsed.error}`);
		return undefined;
	}
	return parsed.value;
}

function parseStringToken(value: string): { value: string; error?: never } | { value?: never; error: string } {
	if (!value.startsWith('"') && !value.startsWith("'")) return { value };
	if (value.startsWith('"')) {
		try {
			const decoded = JSON.parse(value) as unknown;
			return typeof decoded === "string"
				? { value: decoded }
				: { error: "quoted scalar must decode to a string" };
		} catch {
			return { error: "invalid or unterminated double-quoted scalar" };
		}
	}
	// YAML single quotes escape one quote by doubling it. A lone quote closes
	// the token and must be its final character.
	let decoded = "";
	for (let i = 1; i < value.length; i++) {
		if (value[i] !== "'") {
			decoded += value[i];
			continue;
		}
		if (value[i + 1] === "'") {
			decoded += "'";
			i++;
			continue;
		}
		if (i === value.length - 1) return { value: decoded };
		return { error: "trailing text after single-quoted scalar" };
	}
	return { error: "unterminated single-quoted scalar" };
}

/** Split on commas not inside quotes; null means an unterminated quote. */
function splitTopLevelCommas(inner: string): string[] | null {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;
	for (const ch of inner) {
		if (quote) {
			current += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\" && quote === '"') {
				escaped = true;
			} else if (ch === quote) {
				quote = null;
			}
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
		} else if (ch === ",") {
			parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (quote !== null) return null;
	parts.push(current);
	return parts;
}

// ---------------------------------------------------------------------------
// Schema validation (04-type-schema.md)
// ---------------------------------------------------------------------------

const KNOWN_FIELDS = new Set([
	"name",
	"description",
	"model",
	"thinking",
	"projectContext",
	"tools",
	"readOnly",
	"writePaths",
	"denyPaths",
	"maxTokensTotal",
	"maxTurnMinutes",
	"maxContextCompactions",
]);

function validateConfig(
	values: Record<string, YamlValue>,
	filenameStem: string,
): { ok: true; def: { config: TypeConfig } } | { ok: false; errors: string[] } {
	const errors: string[] = [];

	const unknown = Object.keys(values).filter((key) => !KNOWN_FIELDS.has(key));
	for (const key of unknown) {
		errors.push(
			`unknown field "${key}" — allowed fields: ${[...KNOWN_FIELDS].join(", ")} ` +
				"(lifetime/team/id are spawn-time, not frontmatter — D19/D20)",
		);
	}

	const str = (key: string, required: boolean): string | undefined => {
		const value = values[key];
		if (value === undefined) {
			if (required) errors.push(`missing required field "${key}"`);
			return undefined;
		}
		if (typeof value !== "string" || value === "") {
			errors.push(`"${key}" must be a non-empty string, got ${JSON.stringify(value)}`);
			return undefined;
		}
		return value;
	};
	const bool = (key: string): boolean | undefined => {
		const value = values[key];
		if (value === undefined) return undefined;
		if (typeof value !== "boolean") {
			errors.push(`"${key}" must be true or false, got ${JSON.stringify(value)}`);
			return undefined;
		}
		return value;
	};
	const stringArray = (key: string): string[] | undefined => {
		const value = values[key];
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
			errors.push(`"${key}" must be an array of non-empty strings, got ${JSON.stringify(value)}`);
			return undefined;
		}
		return value;
	};
	const positiveNumber = (key: string): number | undefined => {
		const value = values[key];
		if (value === undefined) return undefined;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			errors.push(`"${key}" must be a positive number, got ${JSON.stringify(value)}`);
			return undefined;
		}
		return value;
	};

	const name = str("name", true);
	if (name !== undefined && name !== filenameStem) {
		errors.push(`name "${name}" must equal the filename stem "${filenameStem}" (04-type-schema)`);
	}
	const description = str("description", true);
	const model = str("model", false);

	let thinking: ThinkingLevel | undefined;
	const thinkingRaw = str("thinking", false);
	if (thinkingRaw !== undefined) {
		if ((THINKING_LEVELS as readonly string[]).includes(thinkingRaw)) {
			thinking = thinkingRaw as ThinkingLevel;
		} else {
			errors.push(`"thinking" must be one of ${THINKING_LEVELS.join("|")}, got ${JSON.stringify(thinkingRaw)}`);
		}
	}

	const projectContext = bool("projectContext");
	const tools = stringArray("tools");
	const readOnly = bool("readOnly");
	const writePaths = stringArray("writePaths");
	const denyPaths = stringArray("denyPaths");
	const maxTokensTotal = positiveNumber("maxTokensTotal");
	const maxTurnMinutes = positiveNumber("maxTurnMinutes");
	const maxContextCompactions = positiveNumber("maxContextCompactions");

	if (errors.length > 0 || name === undefined || description === undefined) {
		return { ok: false, errors };
	}

	const config: TypeConfig = {
		name,
		description,
		projectContext: projectContext ?? true,
		readOnly: readOnly ?? false,
		denyPaths: denyPaths ?? [],
	};
	if (model !== undefined) config.model = model;
	if (thinking !== undefined) config.thinking = thinking;
	if (tools !== undefined) config.tools = tools;
	if (writePaths !== undefined) config.writePaths = writePaths;
	if (maxTokensTotal !== undefined) config.maxTokensTotal = maxTokensTotal;
	if (maxTurnMinutes !== undefined) config.maxTurnMinutes = maxTurnMinutes;
	if (maxContextCompactions !== undefined) config.maxContextCompactions = maxContextCompactions;

	return { ok: true, def: { config } };
}
