/**
 * typedefs/parse.ts — parse a type-definition `.md` into config + system prompt
 * (D6/D19/D20). YAML frontmatter between `---` fences; the body is the role
 * prose (context layer 3).
 *
 * The Pi runtime ships no YAML parser, so this reads a deliberately tiny YAML
 * subset: top-level `key: value` scalars and single-line inline arrays
 * `[a, b, "c"]`. Indentation, block scalars, anchors, nested structures, and
 * duplicate keys are hard errors with line numbers — a type author gets a clear
 * message, never a silently mis-parsed capability grant.
 *
 * Slim schema (D20): name, description, model, thinking, projectContext, tools.
 * v1's readOnly/writePaths/denyPaths and budget ceilings are gone (no pi-teams
 * territory sandbox; pi-safety gates risk).
 *
 * Pure module: no fs.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface TypeConfig {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	projectContext: boolean;
	/** Tool-name allowlist; undefined = all coding tools (resolved in sandbox/tools-filter). */
	tools?: string[];
	/**
	 * Peer-to-peer messaging (D12). true (default) = this instance may message other
	 * subagents directly. false = it has no `send_message` tool and is told the main
	 * agent coordinates the team — everything cross-agent routes through main.
	 */
	peers?: boolean;
}

export interface TypeDefinition {
	config: TypeConfig;
	/** Markdown body = the agent's role prose (system-prompt layer 3). */
	body: string;
}

export type ParseResult = { ok: true; definition: TypeDefinition } | { ok: false; errors: string[] };

const KNOWN_FIELDS = new Set(["name", "description", "model", "thinking", "projectContext", "tools", "peers"]);

/** Split leading `---\n…\n---\n` frontmatter from the body. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } | { error: string } {
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	if (lines[0] !== "---") {
		return { error: "type file must begin with a YAML frontmatter block (`---`)" };
	}
	// The closing fence must be a FULL line `---` (not merely a line starting with
	// `---`, so a body/value line like `----` or `---foo` can't be mistaken for it).
	let closeLine = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") {
			closeLine = i;
			break;
		}
	}
	if (closeLine === -1) return { error: "unterminated frontmatter block (missing closing `---`)" };
	const frontmatter = lines.slice(1, closeLine).join("\n");
	const body = lines.slice(closeLine + 1).join("\n");
	return { frontmatter, body };
}

/** Parse a single scalar token (quoted or bare) into string | number | boolean. */
function parseScalar(token: string): { value: string | number | boolean } | { error: string } {
	const t = token.trim();
	if (t === "") return { error: "empty value" };
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		if (t.length < 2) return { error: "unterminated quoted string" };
		return { value: t.slice(1, -1) };
	}
	if (t === "true") return { value: true };
	if (t === "false") return { value: false };
	// No config field is numeric today — numbers are parsed so string-typed fields
	// can REJECT them ("must be a string") instead of silently coercing `123` → "123".
	if (/^-?\d+$/.test(t)) return { value: Number.parseInt(t, 10) };
	if (/[:{}[\]&*#|>]/.test(t)) return { error: `unsupported YAML syntax in value ${JSON.stringify(t)}` };
	return { value: t };
}

/** Parse an inline array `[a, "b c", 3]`. Nested brackets/objects rejected. */
function parseInlineArray(token: string): { value: (string | number | boolean)[] } | { error: string } {
	const inner = token.trim().slice(1, -1).trim();
	if (inner === "") return { value: [] };
	if (inner.includes("[") || inner.includes("]") || inner.includes("{")) {
		return { error: "nested arrays/objects are not supported" };
	}
	const items: (string | number | boolean)[] = [];
	// split on commas not inside quotes
	const parts: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (const ch of inner) {
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			cur += ch;
		} else if (ch === ",") {
			parts.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (quote) return { error: "unterminated quoted string in array" };
	parts.push(cur);
	for (const part of parts) {
		const scalar = parseScalar(part);
		if ("error" in scalar) return { error: scalar.error };
		items.push(scalar.value);
	}
	return { value: items };
}

type RawValue = string | number | boolean | (string | number | boolean)[];

/** Parse the frontmatter subset into a flat key→value map. */
function parseYamlSubset(frontmatter: string): { map: Map<string, RawValue> } | { errors: string[] } {
	const errors: string[] = [];
	const map = new Map<string, RawValue>();
	const lines = frontmatter.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		if (/^\s/.test(line)) {
			errors.push(`line ${i + 1}: indentation / nested structures are not supported`);
			continue;
		}
		const colon = line.indexOf(":");
		if (colon === -1) {
			errors.push(`line ${i + 1}: expected \`key: value\``);
			continue;
		}
		const key = line.slice(0, colon).trim();
		const rest = line.slice(colon + 1).trim();
		if (key === "") {
			errors.push(`line ${i + 1}: empty key`);
			continue;
		}
		if (map.has(key)) {
			errors.push(`line ${i + 1}: duplicate key ${JSON.stringify(key)}`);
			continue;
		}
		if (rest === "") {
			errors.push(`line ${i + 1}: key ${JSON.stringify(key)} has no value (block values unsupported)`);
			continue;
		}
		const result = rest.startsWith("[") && rest.endsWith("]") ? parseInlineArray(rest) : parseScalar(rest);
		if ("error" in result) {
			errors.push(`line ${i + 1}: ${result.error}`);
			continue;
		}
		map.set(key, result.value);
	}
	return errors.length > 0 ? { errors } : { map };
}

/** Validate the parsed map against the slim schema. */
function validateConfig(map: Map<string, RawValue>, filenameStem: string): { config: TypeConfig } | { errors: string[] } {
	const errors: string[] = [];
	for (const key of map.keys()) {
		if (!KNOWN_FIELDS.has(key)) errors.push(`unknown field ${JSON.stringify(key)} (allowed: ${[...KNOWN_FIELDS].join(", ")})`);
	}

	const name = map.get("name");
	if (typeof name !== "string") errors.push("name is required and must be a string");
	else if (name !== filenameStem) errors.push(`name ${JSON.stringify(name)} must equal the filename stem ${JSON.stringify(filenameStem)}`);

	const description = map.get("description");
	if (typeof description !== "string" || description.trim() === "") errors.push("description is required and must be a non-empty string");

	const model = map.get("model");
	if (model !== undefined && typeof model !== "string") errors.push("model must be a string");

	const thinking = map.get("thinking");
	if (thinking !== undefined && (typeof thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinking))) {
		errors.push(`thinking must be one of ${THINKING_LEVELS.join("|")}`);
	}

	const projectContext = map.get("projectContext");
	if (projectContext !== undefined && typeof projectContext !== "boolean") errors.push("projectContext must be a boolean");

	const tools = map.get("tools");
	if (tools !== undefined) {
		if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) errors.push("tools must be an array of strings");
	}

	const peers = map.get("peers");
	if (peers !== undefined && typeof peers !== "boolean") errors.push("peers must be a boolean");

	if (errors.length > 0) return { errors };
	const config: TypeConfig = {
		name: name as string,
		description: description as string,
		projectContext: (projectContext as boolean | undefined) ?? true,
	};
	if (typeof model === "string") config.model = model;
	if (typeof thinking === "string") config.thinking = thinking as ThinkingLevel;
	if (Array.isArray(tools)) config.tools = tools as string[];
	if (typeof peers === "boolean") config.peers = peers;
	return { config };
}

/** Parse a type file's content given its filename stem (for the name check). */
export function parseTypeFile(content: string, filenameStem: string): ParseResult {
	const split = splitFrontmatter(content);
	if ("error" in split) return { ok: false, errors: [split.error] };
	const parsed = parseYamlSubset(split.frontmatter);
	if ("errors" in parsed) return { ok: false, errors: parsed.errors };
	const validated = validateConfig(parsed.map, filenameStem);
	if ("errors" in validated) return { ok: false, errors: validated.errors };
	return { ok: true, definition: { config: validated.config, body: split.body.trim() } };
}
