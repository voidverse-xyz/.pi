import type { SearchSource } from "./client.ts";

const COMPACT_SOURCE_LIMIT = 3;
const QUERY_PREVIEW_CHARS = 240;
const EXPANDED_QUERY_CHARS = 4_000;
const TITLE_PREVIEW_CHARS = 160;
const URL_PREVIEW_CHARS = 360;
const SNIPPET_PREVIEW_CHARS = 320;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

type RenderColor = "toolTitle" | "text" | "accent" | "muted" | "dim" | "success" | "warning" | "error";

export interface WebSearchDetails {
	query: string;
	sources: SearchSource[];
	truncated?: boolean;
}

export interface WebSearchRenderTheme {
	fg(color: RenderColor, text: string): string;
	bold(text: string): string;
}

interface ToolResultLike {
	content?: unknown;
	details?: unknown;
}

interface RenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	expandHint?: string;
}

interface DisplaySource {
	title: string;
	url: string;
	host: string;
	provenance: SearchSource["provenance"];
	snippet?: string;
}

export function renderWebSearchCall(
	args: unknown,
	expanded: boolean,
	theme: WebSearchRenderTheme,
): string {
	const query = recordString(args, "query");
	const limit = expanded ? EXPANDED_QUERY_CHARS : QUERY_PREVIEW_CHARS;
	const displayQuery = clipText(cleanDisplayText(query), limit) || "(query unavailable)";
	return [
		theme.fg("toolTitle", theme.bold("Web Search")),
		`${theme.fg("muted", "Query:")} ${theme.fg("text", displayQuery)}`,
	].join("\n");
}

export function renderWebSearchResult(
	result: ToolResultLike,
	options: RenderResultOptions,
	theme: WebSearchRenderTheme,
): string {
	const details = normalizeDetails(result.details);
	const fallbackText = toolResultText(result.content);
	const lines: string[] = [];

	if (options.isError) {
		lines.push(theme.fg("error", "✗ Failed"));
		if (fallbackText) lines.push(theme.fg("muted", clipText(fallbackText, QUERY_PREVIEW_CHARS)));
		appendSourceLines(lines, details.sources, options, theme);
		return lines.join("\n");
	}

	if (options.isPartial) {
		const progress = fallbackText || "Searching the public web with Codex…";
		lines.push(`${theme.fg("warning", "◌ Searching")} ${theme.fg("muted", clipText(progress, QUERY_PREVIEW_CHARS))}`);
	} else {
		const sourceLabel = `${details.sources.length} source${details.sources.length === 1 ? "" : "s"}`;
		lines.push(`${theme.fg("success", "✓ Completed")} ${theme.fg("muted", `· ${sourceLabel}`)}`);
		if (details.truncated) {
			lines.push(theme.fg("warning", "Answer was truncated; complete source metadata is retained."));
		}
	}

	appendSourceLines(lines, details.sources, options, theme);
	return lines.join("\n");
}

function normalizeDetails(value: unknown): Omit<WebSearchDetails, "sources"> & { sources: DisplaySource[] } {
	if (!value || typeof value !== "object") return { query: "", sources: [] };
	const record = value as Record<string, unknown>;
	const sources = Array.isArray(record.sources)
		? record.sources.map(normalizeDisplaySource).filter((source): source is DisplaySource => source !== null)
		: [];
	return {
		query: typeof record.query === "string" ? record.query : "",
		sources,
		truncated: record.truncated === true,
	};
}

function normalizeDisplaySource(value: unknown): DisplaySource | null {
	if (!value || typeof value !== "object") return null;
	const source = value as Record<string, unknown>;
	if (typeof source.url !== "string") return null;

	let parsed: URL;
	try {
		parsed = new URL(source.url);
	} catch {
		return null;
	}
	if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;

	const title = typeof source.title === "string" ? cleanDisplayText(source.title) : "";
	const snippet = typeof source.snippet === "string" ? cleanDisplayText(source.snippet) : "";
	return {
		title: clipText(title, TITLE_PREVIEW_CHARS),
		url: clipText(cleanDisplayText(parsed.href), URL_PREVIEW_CHARS),
		host: clipText(cleanDisplayText(parsed.host), TITLE_PREVIEW_CHARS),
		provenance: source.provenance === "retrieved" ? "retrieved" : "reported",
		...(snippet ? { snippet: clipText(snippet, SNIPPET_PREVIEW_CHARS) } : {}),
	};
}

function appendSourceLines(
	lines: string[],
	sources: DisplaySource[],
	options: RenderResultOptions,
	theme: WebSearchRenderTheme,
): void {
	if (sources.length === 0) return;
	const displayedSources = options.expanded ? sources : sources.slice(0, COMPACT_SOURCE_LIMIT);
	for (const source of displayedSources) {
		const title = source.title && source.title !== source.url && source.title !== source.host
			? ` · ${source.title}`
			: "";
		const provenance = options.expanded ? ` · ${source.provenance}` : "";
		lines.push(
			`${theme.fg("accent", "↗")} ${theme.fg("text", source.host)}`
			+ theme.fg("muted", `${title}${provenance}`),
		);
		lines.push(`  ${theme.fg("dim", source.url)}`);
		if (options.expanded && source.snippet) lines.push(`  ${theme.fg("muted", source.snippet)}`);
	}

	const remaining = sources.length - displayedSources.length;
	if (remaining > 0) {
		const hint = cleanDisplayText(options.expandHint) || "expand for all sources";
		lines.push(theme.fg("dim", `… ${remaining} more source${remaining === 1 ? "" : "s"} · ${hint}`));
	}
}

function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			return cleanDisplayText(record.text);
		}
	}
	return "";
}

function recordString(value: unknown, key: string): string {
	if (!value || typeof value !== "object") return "";
	const item = (value as Record<string, unknown>)[key];
	return typeof item === "string" ? item : "";
}

function cleanDisplayText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxCharacters: number): string {
	const characters = Array.from(value);
	if (characters.length <= maxCharacters) return value;
	return `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("").trimEnd()}…`;
}
