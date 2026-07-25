import assert from "node:assert/strict";
import test from "node:test";
import {
	createPiMcpToolName,
	formatArgumentPreview,
	formatMcpToolResult,
	scoreMcpTool,
	toolDefinitionWeight,
	validateMcpToolDefinition,
} from "../extensions/mcp-client/tools.ts";

const VALID_TOOL = {
	name: "lookup_issue",
	title: "Lookup Issue",
	description: "Find an issue by number",
	inputSchema: {
		type: "object",
		properties: { number: { type: "integer" } },
		required: ["number"],
	},
};

test("validates bounded object-schema MCP tools", () => {
	const validated = validateMcpToolDefinition(VALID_TOOL);
	assert.equal(validated.warning, undefined);
	assert.deepEqual(validated.tool?.definition, VALID_TOOL);
	assert.ok(toolDefinitionWeight(validated.tool!) > 0);

	assert.match(
		validateMcpToolDefinition({ ...VALID_TOOL, name: "bad name" }).warning!,
		/tool name/,
	);
	assert.match(
		validateMcpToolDefinition({ ...VALID_TOOL, inputSchema: { type: "string" } }).warning!,
		/object inputSchema/,
	);
	assert.match(
		validateMcpToolDefinition({
			...VALID_TOOL,
			execution: { taskSupport: "required" },
		}).warning!,
		/requires MCP task execution/,
	);
	assert.match(
		validateMcpToolDefinition({
			...VALID_TOOL,
			inputSchema: { type: "object", description: "x".repeat(70 * 1024) },
		}).warning!,
		/exceeds/,
	);
});

test("creates deterministic namespaced Pi tool names without collisions", () => {
	assert.equal(createPiMcpToolName("github", "lookup_issue"), "mcp_github_lookup_issue");
	const normalized = createPiMcpToolName("git-hub", "issues.get");
	assert.match(normalized, /^mcp_git_hub_issues_get_[a-f0-9]{8}$/);
	assert.equal(normalized, createPiMcpToolName("git-hub", "issues.get"));
	assert.ok(normalized.length <= 64);

	const reserved = new Set(["mcp_github_lookup_issue"]);
	assert.match(
		createPiMcpToolName("github", "lookup_issue", reserved),
		/^mcp_github_lookup_issue_[a-f0-9]{8}$/,
	);
});

test("formats text, images, and structured MCP results for Pi", () => {
	const formatted = formatMcpToolResult("fixture", "lookup_issue", {
		content: [
			{ type: "text", text: "Issue 42" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "resource_link", uri: "https://example.com/issues/42", name: "Issue" },
		],
		structuredContent: { number: 42 },
		isError: false,
	});
	assert.match((formatted.content[0] as { text: string }).text, /^\[Untrusted MCP result/);
	assert.match((formatted.content[0] as { text: string }).text, /Issue 42/);
	assert.deepEqual(formatted.content[1], {
		type: "image",
		data: "aGVsbG8=",
		mimeType: "image/png",
	});
	assert.deepEqual(formatted.details.structuredContent, { number: 42 });
	assert.equal(formatted.errorText, undefined);
});

test("preserves MCP execution errors and truncates oversized output", () => {
	const failed = formatMcpToolResult("fixture", "failure", {
		content: [{ type: "text", text: "Try a different argument" }],
		isError: true,
	});
	assert.match(failed.errorText!, /Try a different argument/);

	const oversized = formatMcpToolResult("fixture", "large", {
		content: [{ type: "text", text: "x".repeat(60 * 1024) }],
		structuredContent: { value: "x".repeat(40 * 1024) },
	});
	assert.equal(oversized.details.textTruncated, true);
	assert.equal(oversized.details.structuredContentTruncated, true);
	assert.match((oversized.content[0] as { text: string }).text, /Output truncated/);
});

test("redacts sensitive confirmation fields and scores tool discovery", () => {
	const preview = formatArgumentPreview({
		owner: "example",
		apiToken: "must-not-display",
		nested: { password: "also-hidden", value: 4 },
	});
	assert.match(preview, /example/);
	assert.doesNotMatch(preview, /must-not-display|also-hidden/);
	assert.match(preview, /\[redacted\]/);

	const validated = validateMcpToolDefinition(VALID_TOOL).tool!;
	assert.ok(scoreMcpTool("find github issue", "mcp_github_lookup_issue", "github", validated.definition) > 0);
	assert.equal(scoreMcpTool("weather forecast", "mcp_github_lookup_issue", "github", validated.definition), 0);
});
