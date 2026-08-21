/**
 * Phase-9 TUI e2e: the unified ambient widget owns running/waiting/mail status,
 * live activity rows, and its trailing padding line. The extension publishes no
 * subagent footer status.
 *
 * Run: node phase9-tui.mjs
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXT, PI_PKG, jiti } from "./env.mjs";
import { test, summary, until } from "./harness.mjs";

const tree = await jiti.import(join(EXT, "tui/tree-widget.ts"));
const text = await jiti.import(join(EXT, "text.ts"));
const widget = await jiti.import(join(EXT, "tui/widget.ts"));
const piTuiModuleUrl = pathToFileURL(join(PI_PKG, "node_modules/@earendil-works/pi-tui/dist/index.js")).href;
const { visibleWidth } = await import(piTuiModuleUrl);
const plainTheme = { fg: (_color, text) => text };

console.log("unified widget lines:");
await test("idle state renders no widget", () => {
	assert.deepEqual(tree.renderTreeLines([], { running: 0, waiting: 0, unread: 0 }, plainTheme), []);
});
await test("header includes running, waiting, unread mail, and the stop hint", () => {
	const lines = tree.renderTreeLines(
		[
			{ address: "adhoc/tmp-a1b2", label: "test runner", tool: "bash", summary: "Bash: npm test", toolUses: 3, tokens: 12_400, ctxPercent: 18.4 },
			{ address: "reviewer/main", label: "source scout", tool: "read", summary: "Read: src/index.ts", toolUses: 1, tokens: 8100, ctxPercent: 11.2 },
		],
		{ running: 2, waiting: 1, unread: 3 },
		plainTheme,
	);
	assert.ok(lines[0].includes(widget.AGENTS_ICON));
	assert.ok(lines[0].includes("2 running"));
	assert.ok(lines[0].includes("1 waiting"));
	assert.ok(lines[0].includes(`${widget.MAIL_ICON} 3`));
	assert.ok(lines[0].includes(`${tree.STOP_KEY} stop`));
	assert.ok(lines.some((line) => line.includes("test runner") && !line.includes("adhoc/tmp-a1b2") && line.includes(`${tree.TOOL_ICON} 3 tools`) && line.includes(`${tree.TOKEN_ICON} 12k tokens`) && line.includes(`${tree.CONTEXT_ICON} 18%`)));
	assert.ok(lines.some((line) => line.includes("source scout") && line.includes(`${tree.TOOL_ICON} 1 tool`) && !line.includes(`${tree.TOOL_ICON} 1 tools`) && line.includes(`${tree.TOKEN_ICON} 8.1k tokens`) && line.includes(`${tree.CONTEXT_ICON} 11%`)));
	assert.equal(lines.at(-1), "", "widget ends with one raw blank padding line");
});
await test("mail-only status remains visible without advertising the stop brake", () => {
	const lines = tree.renderTreeLines([], { running: 0, waiting: 0, unread: 2 }, plainTheme);
	assert.ok(lines[0].includes(`${widget.MAIL_ICON} 2`));
	assert.ok(!lines[0].includes(`${tree.STOP_KEY} stop`));
	assert.deepEqual(lines.slice(1), [""], "mail-only widget still has bottom padding");
});
await test("activity rows cover a briefly lagging roster snapshot", () => {
	const lines = tree.renderTreeLines(
		[{ address: "worker/lag", label: "lag watcher", tool: "", summary: "thinking…", toolUses: 0, tokens: 0, ctxPercent: null }],
		{ running: 0, waiting: 0, unread: 0 },
		plainTheme,
	);
	assert.ok(lines[0].includes("1 running"));
	assert.ok(lines.some((line) => line.includes("lag watcher") && line.includes(`${tree.TOOL_ICON} 0 tools`) && line.includes(`${tree.TOKEN_ICON} 0 tokens`) && line.includes(`${tree.CONTEXT_ICON} ?`)));
});
await test("compact token formatting matches Pi-style thresholds", () => {
	assert.equal(widget.formatTokens(999), "999");
	assert.equal(widget.formatTokens(8_100), "8.1k");
	assert.equal(widget.formatTokens(12_400), "12k");
});
await test("thinking summaries preserve prior clues and honor narrow budgets", () => {
	assert.equal(text.retainLatestThought("prior clue", " \n "), "prior clue");
	for (let max = 0; max <= 15; max++) {
		assert.ok(Array.from(text.liveThinkingSummary("abcdef", max)).length <= max);
	}
});
await test("long thinking rows retain the newest clue and active suffix", () => {
	const summary = text.liveThinkingSummary(`${"older context ".repeat(20)}FINAL_MARKER`);
	const lines = tree.renderTreeLines(
		[{ address: "worker/thinking", label: "reasoner", tool: "", summary, toolUses: 0, tokens: 100, ctxPercent: 1 }],
		{ running: 1, waiting: 0, unread: 0 },
		plainTheme,
		40,
	);
	const detail = lines.find((line) => line.endsWith(" · thinking…"));
	assert.ok(detail?.includes("FINAL_MARKER"), `newest thought should survive: ${lines.join(" | ")}`);
	assert.ok(visibleWidth(detail) <= 40);
});
await test("an 80-character label is truncated before required metrics at ordinary width", () => {
	const lines = tree.renderTreeLines(
		[{ address: "adhoc/tmp-long", label: `${"descriptive ".repeat(6)}longname`, tool: "bash", summary: "Bash: npm test", toolUses: 4, tokens: 22_000, ctxPercent: 67 }],
		{ running: 1, waiting: 0, unread: 0 },
		plainTheme,
		80,
	);
	const metrics = lines.find((line) => line.includes(tree.TOOL_ICON));
	assert.ok(metrics.includes(`${tree.TOOL_ICON} 4 tools`));
	assert.ok(metrics.includes(`${tree.TOKEN_ICON} 22k tokens`));
	assert.ok(metrics.includes(`${tree.CONTEXT_ICON} 67%`));
	assert.ok(visibleWidth(metrics) <= 80);
});

console.log("component-backed padding:");
await test("controller mounts a raw component whose render preserves the trailing blank line", async () => {
	let listener = () => {};
	let component;
	let cleared = false;
	let renderRequests = 0;
	const rows = [{ address: "worker/main", label: "test runner", tool: "bash", summary: "Bash: npm test", toolUses: 1, tokens: 12_400, ctxPercent: 18 }];
	let unread = 1;
	const core = {
		status: async () => [{ state: "running" }],
		mainUnreadCount: () => unread,
		activitySnapshot: () => rows,
		onEvent: (fn) => {
			listener = fn;
			return () => {
				listener = () => {};
			};
		},
	};
	const tui = { requestRender: () => renderRequests++ };
	const host = {
		setWidget: (_key, content) => {
			if (content) component = content(tui, plainTheme);
			else cleared = true;
		},
	};
	const controller = tree.createTreeWidget(core, host);
	assert.ok(await until(() => component !== undefined, 1000), "widget component mounted");
	const rendered = component.render(120);
	assert.equal(rendered.at(-1), "", "component returns the raw padding row");
	const narrow = component.render(32);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 32), "narrow rows are clipped to the widget width");
	assert.ok(narrow.some((line) => line.includes("test runner")), "the human label survives on its narrow row");
	assert.ok(
		narrow.some((line) => line.includes(`${tree.TOOL_ICON} 1`) && line.includes(`${tree.TOKEN_ICON} 12k`) && line.includes(`${tree.CONTEXT_ICON} 18%`)),
		"a separate compact row preserves all metrics at narrow width",
	);
	unread = 2;
	listener({ type: "state-changed" });
	assert.ok(await until(() => renderRequests > 0, 1000), "runtime changes request a rerender");
	controller.dispose();
	assert.equal(cleared, true, "dispose clears the widget");
});

await test("index never publishes a subagents footer status", () => {
	const source = readFileSync(join(EXT, "index.ts"), "utf8");
	assert.ok(!source.includes(".setStatus("), "subagent status belongs only to the tree widget");
});

summary("Phase 9");
