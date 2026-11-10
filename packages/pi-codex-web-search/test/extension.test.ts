import { createPiJiti, findPiPackage } from "../../../tests/runtime.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const codingAgentStub = fileURLToPath(new URL("./fixtures/pi-coding-agent.mjs", import.meta.url));
const jiti = await createPiJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": codingAgentStub } });

test("discovers a Windows npm-global Pi installation without HOME", (t) => {
	const appData = mkdtempSync(join(tmpdir(), "pi-web-search-appdata-test-"));
	t.after(() => rmSync(appData, { recursive: true, force: true }));
	const expected = join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(expected, "dist"), { recursive: true });
	writeFileSync(join(expected, "dist", "index.js"), "");
	writeFileSync(join(expected, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));

	assert.equal(findPiPackage({ env: { APPDATA: appData }, home: appData }), expected);
});

test("loads the extension and wires compact transcript rendering", async () => {
	const extension = await jiti.import(
		resolve("packages/pi-codex-web-search/extensions/codex-web-search/index.ts"),
	) as { default: (pi: { registerTool(tool: unknown): void }) => void };
	const tools: any[] = [];
	extension.default({
		registerTool(tool) {
			tools.push(tool);
		},
	});

	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.equal(tool.name, "web_search");
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");

	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const call = tool.renderCall({ query: "current release" }, theme, { expanded: false });
	assert.match(call.render(100).join("\n"), /Query: current release/);

	const result = tool.renderResult(
		{
			content: [{ type: "text", text: "answer" }],
			details: {
				query: "current release",
				sources: [{
					title: "Docs",
					url: "https://docs.example.com/release",
					provenance: "retrieved",
				}],
			},
		},
		{ expanded: false, isPartial: false },
		theme,
		{ isError: false, state: {} },
	);
	const rendered = result.render(100).join("\n");
	assert.match(rendered, /✓ Completed · 1 source/);
	assert.match(rendered, /docs\.example\.com/);
	assert.match(rendered, /https:\/\/docs\.example\.com\/release/);
	assert.ok(result.render(32).every((line: string) => Array.from(line).length <= 32));

	const failureState = {};
	tool.renderResult(
		{
			content: [{ type: "text", text: "Codex completed 1 web search…" }],
			details: {
				query: "current release",
				sources: [{
					title: "Docs",
					url: "https://docs.example.com/release",
					provenance: "retrieved",
				}],
			},
		},
		{ expanded: false, isPartial: true },
		theme,
		{ isError: false, state: failureState },
	);
	const failed = tool.renderResult(
		{ content: [{ type: "text", text: "Codex app-server exited unexpectedly" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ isError: true, state: failureState },
	).render(100).join("\n");
	assert.match(failed, /✗ Failed/);
	assert.match(failed, /docs\.example\.com/);
	assert.match(failed, /https:\/\/docs\.example\.com\/release/);
});
