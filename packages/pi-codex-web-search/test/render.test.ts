import assert from "node:assert/strict";
import test from "node:test";
import type { SearchSource } from "../extensions/codex-web-search/client.ts";
import {
	renderWebSearchCall,
	renderWebSearchResult,
	type WebSearchRenderTheme,
} from "../extensions/codex-web-search/render.ts";

const plainTheme: WebSearchRenderTheme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

function source(index: number, provenance: SearchSource["provenance"] = "retrieved"): SearchSource {
	return {
		title: `Source ${index}`,
		url: `https://docs${index}.example.com/reference/${index}`,
		provenance,
		snippet: `Evidence from source ${index}`,
	};
}

test("renders the query in a durable tool-call header without terminal controls", () => {
	const rendered = renderWebSearchCall(
		{ query: "latest\u001b[31m\nrelease status" },
		false,
		plainTheme,
	);

	assert.match(rendered, /^Web Search\nQuery: /);
	assert.match(rendered, /latest.*release status/);
	assert.doesNotMatch(rendered, /\u001b|\nrelease/);

	const fullQuery = "q".repeat(4_000);
	assert.match(renderWebSearchCall({ query: fullQuery }, false, plainTheme), /…$/);
	assert.ok(renderWebSearchCall({ query: fullQuery }, true, plainTheme).endsWith(fullQuery));
});

test("renders live progress with retrieved domains and direct URLs", () => {
	const rendered = renderWebSearchResult(
		{
			content: [{ type: "text", text: "Codex completed 1 web search…" }],
			details: { query: "current docs", sources: [source(1)] },
		},
		{ expanded: false, isPartial: true, isError: false },
		plainTheme,
	);

	assert.match(rendered, /^◌ Searching Codex completed 1 web search…/);
	assert.match(rendered, /docs1\.example\.com/);
	assert.match(rendered, /https:\/\/docs1\.example\.com\/reference\/1/);
});

test("keeps completed results compact and exposes the remaining source count", () => {
	const sources = [source(1), source(2), source(3), source(4), source(5, "reported")];
	const rendered = renderWebSearchResult(
		{
			content: [{ type: "text", text: "answer" }],
			details: { query: "current docs", sources },
		},
		{ expanded: false, isPartial: false, isError: false, expandHint: "alt+e to expand" },
		plainTheme,
	);

	assert.match(rendered, /^✓ Completed · 5 sources/);
	assert.match(rendered, /docs1\.example\.com/);
	assert.match(rendered, /docs3\.example\.com/);
	assert.doesNotMatch(rendered, /docs4\.example\.com/);
	assert.match(rendered, /… 2 more sources · alt\+e to expand/);
});

test("expanded results show every source, provenance, and snippet", () => {
	const rendered = renderWebSearchResult(
		{
			content: [{ type: "text", text: "answer" }],
			details: { query: "current docs", sources: [source(1), source(2, "reported")] },
		},
		{ expanded: true, isPartial: false, isError: false },
		plainTheme,
	);

	assert.match(rendered, /docs1\.example\.com · Source 1 · retrieved/);
	assert.match(rendered, /docs2\.example\.com · Source 2 · reported/);
	assert.match(rendered, /Evidence from source 2/);
	assert.doesNotMatch(rendered, /more sources/);
});

test("sanitizes source metadata and omits malformed or credentialed URLs", () => {
	const rendered = renderWebSearchResult(
		{
			content: [{ type: "text", text: "answer" }],
			details: {
				query: "security docs",
				sources: [
					{
						title: "Safe\u001b[31m\nDocs",
						url: "https://safe.example/docs",
						provenance: "retrieved",
						snippet: "Evidence\u202e\ntext",
					},
					{
						title: "Credentials",
						url: "https://user:password@private.example/docs",
						provenance: "reported",
					},
					{
						title: "Invalid",
						url: "not a URL",
						provenance: "reported",
					},
				],
			},
		},
		{ expanded: true, isPartial: false, isError: false },
		plainTheme,
	);

	assert.match(rendered, /safe\.example/);
	assert.match(rendered, /Evidence text/);
	assert.doesNotMatch(rendered, /\u001b|\u202e|private\.example|not a URL/);
});

test("renders an explicit failure outcome and sanitizes its message", () => {
	const rendered = renderWebSearchResult(
		{ content: [{ type: "text", text: "Network\u001b[31m\nfailed" }] },
		{ expanded: false, isPartial: false, isError: true },
		plainTheme,
	);

	assert.match(rendered, /^✗ Failed\nNetwork.*failed$/);
	assert.doesNotMatch(rendered, /\u001b|\nfailed/);
});
