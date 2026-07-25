import { createHash } from "node:crypto";
import type { McpCallToolResult, McpToolDefinition } from "./protocol.ts";

const MAX_DESCRIPTION_CHARS = 4_096;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_PI_TOOL_NAME_CHARS = 64;
const MAX_TEXT_BYTES = 50 * 1024;
const MAX_TEXT_LINES = 2_000;
const MAX_DETAILS_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const SENSITIVE_KEY_RE = /(authorization|credential|password|secret|token|api[_-]?key|private[_-]?key)/i;
const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export interface ValidatedMcpTool {
	definition: McpToolDefinition;
	schemaBytes: number;
}

export type PiMcpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface FormattedMcpResult {
	content: PiMcpContent[];
	details: {
		server: string;
		tool: string;
		structuredContent?: unknown;
		structuredContentTruncated?: boolean;
		textTruncated: boolean;
		imagesOmitted: number;
	};
	errorText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: string, maximum: number): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim()
		.slice(0, maximum);
}

function serializedBytes(value: unknown): number | undefined {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return undefined;
	}
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
	try {
		return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function validateMcpToolDefinition(value: unknown): { tool?: ValidatedMcpTool; warning?: string } {
	if (!isRecord(value)) return { warning: "tool definition must be an object" };
	if (typeof value.name !== "string" || !MCP_TOOL_NAME_RE.test(value.name)) {
		return { warning: "tool name must use 1–128 letters, digits, underscores, hyphens, or dots" };
	}
	if (!isRecord(value.inputSchema) || value.inputSchema.type !== "object") {
		return { warning: `tool ${value.name} must expose an object inputSchema` };
	}
	const schemaBytes = serializedBytes(value.inputSchema);
	if (schemaBytes === undefined || schemaBytes > MAX_SCHEMA_BYTES) {
		return { warning: `tool ${value.name} inputSchema exceeds ${MAX_SCHEMA_BYTES} bytes or is not serializable` };
	}
	const inputSchema = cloneJsonObject(value.inputSchema);
	if (!inputSchema) return { warning: `tool ${value.name} inputSchema could not be copied safely` };

	let outputSchema: Record<string, unknown> | undefined;
	if (value.outputSchema !== undefined) {
		if (!isRecord(value.outputSchema)) return { warning: `tool ${value.name} has an invalid outputSchema` };
		const outputBytes = serializedBytes(value.outputSchema);
		if (outputBytes === undefined || outputBytes > MAX_SCHEMA_BYTES) {
			return { warning: `tool ${value.name} outputSchema exceeds ${MAX_SCHEMA_BYTES} bytes or is not serializable` };
		}
		outputSchema = cloneJsonObject(value.outputSchema);
		if (!outputSchema) return { warning: `tool ${value.name} outputSchema could not be copied safely` };
	}

	const taskSupport = isRecord(value.execution) ? value.execution.taskSupport : undefined;
	if (taskSupport === "required") {
		return { warning: `tool ${value.name} requires MCP task execution, which this client does not support` };
	}
	if (
		taskSupport !== undefined
		&& taskSupport !== "optional"
		&& taskSupport !== "forbidden"
		&& taskSupport !== "required"
	) {
		return { warning: `tool ${value.name} has invalid task support metadata` };
	}

	const definition: McpToolDefinition = {
		name: value.name,
		...(typeof value.title === "string" && value.title.trim()
			? { title: cleanText(value.title, 200) }
			: {}),
		...(typeof value.description === "string" && value.description.trim()
			? { description: cleanText(value.description, MAX_DESCRIPTION_CHARS) }
			: {}),
		inputSchema,
		...(outputSchema ? { outputSchema } : {}),
		...(isRecord(value.annotations) ? { annotations: cloneJsonObject(value.annotations) ?? {} } : {}),
		...(taskSupport ? { execution: { taskSupport } } : {}),
	};
	return { tool: { definition, schemaBytes } };
}

function normalizeNameSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "") || "tool";
}

function toolHash(serverId: string, remoteName: string): string {
	return createHash("sha256").update(serverId).update("\0").update(remoteName).digest("hex").slice(0, 8);
}

export function createPiMcpToolName(
	serverId: string,
	remoteName: string,
	reserved: ReadonlySet<string> = new Set(),
): string {
	const normalizedServer = normalizeNameSegment(serverId);
	const normalizedTool = normalizeNameSegment(remoteName);
	const base = `mcp_${normalizedServer}_${normalizedTool}`;
	const identityChanged = normalizedServer !== serverId || normalizedTool !== remoteName;
	if (!identityChanged && base.length <= MAX_PI_TOOL_NAME_CHARS && !reserved.has(base)) return base;

	const suffix = `_${toolHash(serverId, remoteName)}`;
	const candidate = `${base.slice(0, MAX_PI_TOOL_NAME_CHARS - suffix.length)}${suffix}`;
	if (!reserved.has(candidate)) return candidate;
	throw new Error(`MCP tool-name collision for ${serverId}/${remoteName}`);
}

export function toolDefinitionWeight(tool: ValidatedMcpTool): number {
	return tool.schemaBytes + Buffer.byteLength(tool.definition.description ?? "", "utf8") + tool.definition.name.length;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
	let bytes = 0;
	let end = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += character.length;
	}
	return { text: value.slice(0, end), truncated: true };
}

function truncateText(value: string): { text: string; truncated: boolean } {
	const lines = value.split("\n");
	const lineTruncated = lines.length > MAX_TEXT_LINES;
	const lineBounded = lineTruncated ? lines.slice(0, MAX_TEXT_LINES).join("\n") : value;
	const byteBounded = truncateUtf8(lineBounded, MAX_TEXT_BYTES);
	const truncated = lineTruncated || byteBounded.truncated;
	return {
		text: truncated ? `${byteBounded.text}\n\n[Output truncated by pi-mcp-client]` : byteBounded.text,
		truncated,
	};
}

function validImageContent(value: Record<string, unknown>): value is Record<string, unknown> & {
	data: string;
	mimeType: string;
} {
	if (typeof value.data !== "string" || typeof value.mimeType !== "string") return false;
	if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(value.mimeType)) return false;
	if (value.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) return false;
	if (value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return false;
	return Buffer.byteLength(value.data, "base64") <= MAX_IMAGE_BYTES;
}

function renderContentItem(item: unknown): { text?: string; image?: PiMcpContent; omittedImage?: boolean } {
	if (!isRecord(item) || typeof item.type !== "string") return { text: "[Unsupported MCP content item]" };
	if (item.type === "text" && typeof item.text === "string") return { text: item.text };
	if (item.type === "image") {
		if (!validImageContent(item)) return { text: "[Invalid or oversized MCP image omitted]", omittedImage: true };
		return { image: { type: "image", data: item.data, mimeType: item.mimeType } };
	}
	if (item.type === "audio") {
		const mimeType = typeof item.mimeType === "string" ? cleanText(item.mimeType, 100) : "unknown";
		return { text: `[MCP audio content omitted: ${mimeType}]` };
	}
	if (item.type === "resource_link") {
		const uri = typeof item.uri === "string" ? cleanText(item.uri, 2_048) : "unknown";
		const name = typeof item.name === "string" ? ` (${cleanText(item.name, 200)})` : "";
		return { text: `[MCP resource link${name}: ${uri}]` };
	}
	if (item.type === "resource" && isRecord(item.resource)) {
		const uri = typeof item.resource.uri === "string" ? cleanText(item.resource.uri, 2_048) : "unknown";
		if (typeof item.resource.text === "string") {
			return { text: `[Embedded MCP resource: ${uri}]\n${item.resource.text}` };
		}
		return { text: `[Embedded binary MCP resource omitted: ${uri}]` };
	}
	return { text: `[Unsupported MCP content type: ${cleanText(item.type, 100)}]` };
}

function boundedStructuredContent(value: unknown): { value?: unknown; truncated: boolean } {
	if (value === undefined) return { truncated: false };
	try {
		const serialized = JSON.stringify(value);
		if (Buffer.byteLength(serialized, "utf8") > MAX_DETAILS_BYTES) return { truncated: true };
		return { value: JSON.parse(serialized), truncated: false };
	} catch {
		return { truncated: true };
	}
}

export function formatMcpToolResult(
	serverId: string,
	toolName: string,
	result: McpCallToolResult,
): FormattedMcpResult {
	const textParts: string[] = [];
	const images: PiMcpContent[] = [];
	let imagesOmitted = 0;
	for (const item of result.content ?? []) {
		const rendered = renderContentItem(item);
		if (rendered.text) textParts.push(rendered.text);
		if (rendered.image) {
			if (images.length < MAX_IMAGES) images.push(rendered.image);
			else imagesOmitted++;
		}
		if (rendered.omittedImage) imagesOmitted++;
	}

	if (textParts.length === 0 && result.structuredContent !== undefined) {
		try {
			textParts.push(JSON.stringify(result.structuredContent, null, 2));
		} catch {
			textParts.push("[MCP structured content could not be serialized]");
		}
	}
	if (textParts.length === 0 && images.length === 0) textParts.push("[MCP tool returned no content]");

	const prefix = `[Untrusted MCP result from ${serverId}/${toolName}]`;
	const truncatedText = truncateText(`${prefix}\n${textParts.join("\n\n")}`);
	const structured = boundedStructuredContent(result.structuredContent);
	const content: PiMcpContent[] = [{ type: "text", text: truncatedText.text }, ...images];
	const details = {
		server: serverId,
		tool: toolName,
		...(structured.value !== undefined ? { structuredContent: structured.value } : {}),
		...(structured.truncated ? { structuredContentTruncated: true } : {}),
		textTruncated: truncatedText.truncated,
		imagesOmitted,
	};
	return {
		content,
		details,
		...(result.isError ? { errorText: truncatedText.text } : {}),
	};
}

function redactValue(value: unknown, key = "", depth = 0): unknown {
	if (SENSITIVE_KEY_RE.test(key)) return "[redacted]";
	if (depth >= 5) return "[nested value omitted]";
	if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactValue(entry, "", depth + 1));
	if (!isRecord(value)) return value;
	const output: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) {
		output[childKey] = redactValue(childValue, childKey, depth + 1);
	}
	return output;
}

export function formatArgumentPreview(args: Record<string, unknown>): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(redactValue(args), null, 2);
	} catch {
		serialized = "[arguments could not be displayed]";
	}
	return truncateUtf8(serialized, 4_096).text;
}

export function scoreMcpTool(query: string, piName: string, serverId: string, tool: McpToolDefinition): number {
	const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	if (terms.length === 0) return 0;
	const nameText = `${piName} ${serverId} ${tool.name}`.toLowerCase();
	const descriptionText = `${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (nameText.includes(term)) score += 3;
		if (descriptionText.includes(term)) score += 1;
	}
	return score;
}
