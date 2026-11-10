import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { nativeTranscript } from "../extensions/swarm/native-transcript.mjs";

const stripAnsi = text => text.replace(/\x1b\[[0-9;]*m/g, "");
initTheme("dark");
const tui = { requestRender() {}, terminal: { rows: 24 } };
const entries = [
	{ message: { role: "system", content: "PRIVATE CONTEXT" } },
	{ message: { role: "user", content: "User question 界🙂\x1b[31m" } },
	{ message: { role: "assistant", content: [{ type: "text", text: "Assistant **answer**" },
		{ type: "toolCall", name: "read", id: "call", arguments: { path: "fixture.txt" } }], stopReason: "toolUse" } },
	{ message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "Result sentinel" }], details: { private: "PRIVATE DETAILS" }, isError: false } },
];

test("verified native Pi components render user, assistant and tools without mail or opaque metadata", () => {
	const components = nativeTranscript(entries, tui, process.cwd());
	assert.deepEqual(components.map(component => component.constructor.name), ["UserMessageComponent", "AssistantMessageComponent", "ToolExecutionComponent"]);
	for (const width of [80, 40, 16, 8]) {
		const lines = components.flatMap(component => component.render(width));
		const text = stripAnsi(lines.join("\n"));
		const unwrapped = text.replace(/\s+/g, "");
		assert.match(unwrapped, /User/); assert.match(unwrapped, /Assistant/); assert.match(unwrapped, /read/);
		assert.doesNotMatch(text, /PRIVATE/);
		assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
		if (width === 80) { assert.match(text, /Result sentinel/); assert.match(text, /\\u001b\[31m/); }
	}
});

test("orphan results and pending tool activity remain visible using native fallback renderers", () => {
	const components = nativeTranscript([entries[2], { message: { role: "toolResult", toolCallId: "other", toolName: "custom_tool", content: [{ type: "text", text: "Failed result" }], isError: true } }], tui, process.cwd());
	const text = stripAnsi(components.flatMap(component => component.render(80)).join("\n"));
	assert.match(text, /read/); assert.match(text, /custom_tool/); assert.match(text, /Failed result/);
});
