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
import { EXT, jiti } from "./env.mjs";
import { test, summary, until } from "./harness.mjs";

const tree = await jiti.import(join(EXT, "tui/tree-widget.ts"));
const widget = await jiti.import(join(EXT, "tui/widget.ts"));
const plainTheme = { fg: (_color, text) => text };

console.log("unified widget lines:");
await test("idle state renders no widget", () => {
	assert.deepEqual(tree.renderTreeLines([], { running: 0, waiting: 0, unread: 0 }, plainTheme), []);
});
await test("header includes running, waiting, unread mail, and the stop hint", () => {
	const lines = tree.renderTreeLines(
		[
			{ address: "worker/main", tool: "bash", summary: "Bash: npm test", toolUses: 3 },
			{ address: "reviewer/main", tool: "read", summary: "Read: src/index.ts", toolUses: 1 },
		],
		{ running: 2, waiting: 1, unread: 3 },
		plainTheme,
	);
	assert.ok(lines[0].includes(widget.AGENTS_ICON));
	assert.ok(lines[0].includes("2 running"));
	assert.ok(lines[0].includes("1 waiting"));
	assert.ok(lines[0].includes(`${widget.MAIL_ICON} 3`));
	assert.ok(lines[0].includes(`${tree.STOP_KEY} stop`));
	assert.ok(lines.some((line) => line.includes("worker/main") && line.includes("3 tool uses")));
	assert.ok(lines.some((line) => line.includes("reviewer/main") && line.includes("1 tool use") && !line.includes("1 tool uses")));
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
		[{ address: "worker/lag", tool: "", summary: "thinking…", toolUses: 0 }],
		{ running: 0, waiting: 0, unread: 0 },
		plainTheme,
	);
	assert.ok(lines[0].includes("1 running"));
	assert.ok(lines.some((line) => line.includes("worker/lag")));
});

console.log("component-backed padding:");
await test("controller mounts a raw component whose render preserves the trailing blank line", async () => {
	let listener = () => {};
	let component;
	let cleared = false;
	let renderRequests = 0;
	const rows = [{ address: "worker/main", tool: "bash", summary: "Bash: npm test", toolUses: 1 }];
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
