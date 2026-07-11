/**
 * Load-check harness: loads src/index.ts the same way pi does (jiti), with a
 * stubbed ExtensionAPI, then simulates session_start and renders the header,
 * footer, and a working-indicator frame.
 *
 * Run inside the container:
 *   node /config/workspace/codex-pi/tests/load-check.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI_PKG = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(PI_PKG + "/package.json");
const { createJiti } = require("jiti");

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../src/codex.ts");

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": PI_PKG,
		"@earendil-works/pi-tui": PI_PKG + "/node_modules/@earendil-works/pi-tui",
		typebox: PI_PKG + "/node_modules/typebox/build/index.mjs",
	},
});

// --- Stub ExtensionAPI -------------------------------------------------
const handlers = new Map();
const registered = { commands: [], tools: [], shortcuts: [] };
const pi = {
	on: (event, handler) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
	registerCommand: (name, def) => {
		registered.commands.push(name);
		registered.commandDefs ??= {};
		registered.commandDefs[name] = def;
	},
	// Match published pi 0.80.3: registerMessageRenderer exists; registerEntryRenderer does NOT.
	registerMessageRenderer: (type, renderer) => {
		registered.messageRenderers ??= {};
		registered.messageRenderers[type] = renderer;
	},
	sendMessage: (message) => {
		registered.customMessages ??= [];
		registered.customMessages.push(message);
	},
	sendUserMessage: (content) => {
		registered.sentMessages ??= [];
		registered.sentMessages.push(content);
	},
	getSessionName: () => "test session",
	exec: async (cmd, args) => {
		const { execFile } = await import("node:child_process");
		return new Promise((resolve) => {
			execFile(cmd, args, { cwd: process.env.EXEC_CWD ?? "/config/workspace/codex", maxBuffer: 10e6 }, (err, stdout, stderr) =>
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: err?.code ?? (err ? 1 : 0), killed: false }),
			);
		});
	},
	registerTool: (tool) => {
		registered.tools.push(tool.name);
		registered.toolDefs ??= {};
		registered.toolDefs[tool.name] = tool;
	},
	registerShortcut: (key, def) => {
		registered.shortcuts.push(key);
		registered.shortcutDefs ??= {};
		registered.shortcutDefs[key] = def;
	},
	getThinkingLevel: () => "medium",
	events: { emit() {}, on() {} },
};

// --- Stub context ------------------------------------------------------
const themeStub = {
	name: "dark",
	fg: (_slot, text) => `\x1b[36m${text}\x1b[39m`, // cyan-ish for accent slots
};
const uiCalls = [];
let headerFactory, footerFactory, indicatorOpts;
const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: process.cwd(),
	model: { id: "gpt-5-codex" },
	getContextUsage: () => ({ tokens: 12000, contextWindow: 200000, percent: 6 }),
	ui: {
		theme: themeStub,
		setTheme: (name) => (uiCalls.push(["setTheme", name]), { success: true }),
		setHeader: (f) => (headerFactory = f),
		setFooter: (f) => (footerFactory = f),
		setWorkingIndicator: (opts) => (indicatorOpts = opts),
		setWorkingMessage: (m) => uiCalls.push(["setWorkingMessage", JSON.stringify(m)]),
		setStatus: () => {},
		notify: () => {},
		setEditorComponent: (factory) => { registered.editorFactory = factory; },
	},
};

// --- Run ---------------------------------------------------------------
const factory = await jiti.import(entry, { default: true });
if (typeof factory !== "function") throw new Error("default export is not a factory");
await factory(pi);

for (const h of handlers.get("session_start") ?? []) await h({}, ctx);

console.log("== ui calls ==");
for (const c of uiCalls) console.log("  ", c.join(" "));
console.log("== header (width 80) ==");
const header = headerFactory(null, themeStub);
console.log(header.render(80).join("\n"));
console.log("== footer (width 80) ==");
const footerData = { getGitBranch: () => "main" };
console.log(footerFactory(null, themeStub, footerData).render(80).join("\n"));
console.log("== working frame 6/interval ==");
console.log(indicatorOpts.frames[6], ` interval=${indicatorOpts.intervalMs}ms frames=${indicatorOpts.frames.length}`);
// --- Tool render checks --------------------------------------------------
const themeFull = {
	...themeStub,
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
};
const renderCtx = (over = {}) => ({
	isError: false,
	isPartial: false,
	executionStarted: true,
	expanded: false,
	state: {},
	invalidate() {},
	cwd: process.cwd(),
	...over,
});

console.log("== tools registered ==", registered.tools.join(", "));

const bash = registered.toolDefs.bash;
console.log("== bash call (success) ==");
console.log(bash.renderCall({ command: "ls -la" }, themeFull, renderCtx()).text);
console.log("== bash call (running) ==");
console.log(bash.renderCall({ command: "sleep 5" }, themeFull, renderCtx({ isPartial: true })).text);
console.log("== bash call (failed) ==");
console.log(bash.renderCall({ command: "false" }, themeFull, renderCtx({ isError: true })).text);
console.log("== bash result collapsed (7 lines) ==");
const bashResult = { content: [{ type: "text", text: "a\nb\nc\nd\ne\nf\ng" }] };
console.log(bash.renderResult(bashResult, { expanded: false, isPartial: false }, themeFull, renderCtx()).text);

const edit = registered.toolDefs.edit;
console.log("== edit call+result ==");
const editCtx = renderCtx();
const editResult = {
	content: [{ type: "text", text: "ok" }],
	details: { diff: "--- a\n+++ b\n context\n-old line\n+new line\n+another" },
};
console.log(edit.renderResult(editResult, { expanded: true, isPartial: false }, themeFull, editCtx).text);
console.log(edit.renderCall({ path: "/tmp/x.ts" }, themeFull, editCtx).text);

for (const t of ["read", "bash", "edit", "write", "grep", "find", "ls"])
	if (!registered.toolDefs[t]) throw new Error(`missing render override for ${t}`);

// --- Command checks -------------------------------------------------------
console.log("== commands registered ==", registered.commands.join(", "));

const notifications = [];
const cmdCtx = {
	...ctx,
	ui: {
		...ctx.ui,
		notify: (msg, type) => notifications.push([type, msg]),
		getEditorText: () => "look at",
		setEditorText: (t) => notifications.push(["editor", t]),
		setWidget: (key, content) => notifications.push(["widget", key, content?.[0] ?? "cleared"]),
		select: async () => "pragmatic",
	},
};

await registered.commandDefs.status.handler("", cmdCtx);
const statusMsg = registered.customMessages.find((m) => m.customType === "codex-status");
console.log("== /status card ==");
console.log(
	registered.messageRenderers["codex-status"]({ details: statusMsg.details }, { expanded: false }, themeFull)
		.render(80)
		.join("\n"),
);

await registered.commandDefs.diff.handler("", cmdCtx);
const diffMsg = registered.customMessages.find((m) => m.customType === "codex-diff");
if (diffMsg) {
	console.log("== /diff render ==");
	console.log(
		registered.messageRenderers["codex-diff"]({ details: diffMsg.details }, { expanded: false }, themeFull)
			.render(80)
			.join("\n"),
	);
}
await registered.commandDefs.mention.handler("", cmdCtx);
await registered.commandDefs.goal.handler("ship codex-pi v1", cmdCtx);
await registered.commandDefs.personality.handler("", cmdCtx);
await registered.commandDefs.init.handler("", cmdCtx);
console.log("== notifications/effects ==");
for (const n of notifications) console.log("  ", JSON.stringify(n));
console.log("== init prompt sent ==", registered.sentMessages?.[0]?.slice(0, 60) + "...");

// before_agent_start must inject personality + goal
const bas = handlers.get("before_agent_start")?.[0];
const basResult = await bas({}, { ...cmdCtx, getSystemPrompt: () => "BASE" });
const sp = basResult?.systemPrompt ?? "";
if (!sp.includes("BASE") || !sp.includes("Current goal") || !sp.includes("Personality"))
	throw new Error("system prompt injection failed");
console.log("== system prompt injection OK (base + personality + goal) ==");

// --- Approval gate checks --------------------------------------------------
const toolCallHandlers = handlers.get("tool_call") ?? [];
const gate = toolCallHandlers[toolCallHandlers.length - 1];
let selectAnswer = "Yes, proceed";
const WORKSPACE = "/config/workspace/codex-pi";
const gateCtx = (cwd = WORKSPACE) => ({
	...cmdCtx,
	cwd,
	hasUI: true,
	ui: { ...cmdCtx.ui, select: async (_t, options) => options.find((o) => o.startsWith(selectAnswer.split(",")[0])) && selectAnswer },
});

const assert = (name, cond) => {
	if (!cond) throw new Error(`approval check failed: ${name}`);
	console.log(`  ok: ${name}`);
};

console.log("== approvals ==");
assert("safe command auto-runs", (await gate({ toolName: "bash", input: { command: "ls -la && git status" } }, gateCtx())) === undefined);
assert("redirection is not safe / approved via dialog", (await gate({ toolName: "bash", input: { command: "echo hi > /etc/x" } }, gateCtx())) === undefined);
selectAnswer = "No, and tell Codex what to do differently";
const denied = await gate({ toolName: "bash", input: { command: "rm -rf /" } }, gateCtx());
assert("deny blocks with reason", denied?.block === true && /rejected/.test(denied.reason));
selectAnswer = "Yes, and don't ask again for commands that start with `dnf install`";
await gate({ toolName: "bash", input: { command: "dnf install -y cowsay" } }, gateCtx());
selectAnswer = "No, and tell Codex what to do differently"; // would deny if asked again
assert("prefix grant persists", (await gate({ toolName: "bash", input: { command: "dnf install -y sl" } }, gateCtx())) === undefined);
assert("in-workspace edit is free", (await gate({ toolName: "edit", input: { path: "src/x.ts" } }, gateCtx())) === undefined);
const outside = await gate({ toolName: "edit", input: { path: "/etc/passwd" } }, gateCtx());
assert("outside-workspace edit prompts (denied)", outside?.block === true);

// --- Subagents (mock session factory, no live model) ----------------------
console.log("== subagents ==");
const subMod = await jiti.import(path.resolve(here, "../src/subagents.ts"));
const { registerCodexSubagents } = subMod;

// Fake AgentSession that "answers" by echoing the prompt.
function makeFakeSession() {
	let listener;
	return {
		subscribe: (l) => { listener = l; return () => {}; },
		prompt: async (text) => {
			await new Promise((r) => setTimeout(r, 20));
			listener?.({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: `did: ${text}` }] }] });
		},
		abort: async () => {},
		dispose: () => {},
	};
}

const subPi = {
	...pi,
	registerTool: (t) => { registered.toolDefs[t.name] = t; },
	registerCommand: (n, d) => { registered.commandDefs[n] = d; },
	registerMessageRenderer: () => {},
	sendMessage: () => {},
	on: () => {},
};
const { agents } = registerCodexSubagents(subPi, { createSession: async () => ({ session: makeFakeSession() }) });

const subCtx = { ...cmdCtx, cwd: WORKSPACE, model: { id: "gpt-5", provider: "openai" }, getSystemPrompt: () => "PARENT" };
const spawnRes = await registered.toolDefs.spawn_agent.execute("t1", { task_name: "probe", message: "look at foo" }, undefined, undefined, subCtx);
const spawned = JSON.parse(spawnRes.content[0].text);
if (!spawned.agent_id || spawned.nickname === undefined) throw new Error("spawn_agent bad result");
console.log("  ok: spawn_agent ->", spawned.agent_id, spawned.nickname, `[${spawned.role}]`);

const waitRes = await registered.toolDefs.wait_agent.execute("t2", { agent_ids: [spawned.agent_id] }, undefined, undefined, subCtx);
const waited = JSON.parse(waitRes.content[0].text);
if (waited[0].result !== "did: look at foo") throw new Error(`wait_agent got ${JSON.stringify(waited[0])}`);
console.log("  ok: wait_agent result =", JSON.stringify(waited[0].result));

const listRes = await registered.toolDefs.list_agents.execute("t3", {}, undefined, undefined, subCtx);
if (JSON.parse(listRes.content[0].text).length !== 1) throw new Error("list_agents wrong count");
console.log("  ok: list_agents");

await registered.toolDefs.close_agent.execute("t4", { agent_id: spawned.agent_id }, undefined, undefined, subCtx);
if (agents.size !== 0) throw new Error("close_agent did not remove");
console.log("  ok: close_agent");
for (const name of ["spawn_agent", "wait_agent", "send_input", "list_agents", "interrupt_agent", "close_agent"])
	if (!registered.toolDefs[name]) throw new Error(`missing subagent tool ${name}`);
console.log("  ok: all 6 subagent tools registered");

// --- Plan + review --------------------------------------------------------
console.log("== plan + review ==");
const planMod = await jiti.import(path.resolve(here, "../src/plan.ts"));
const planReg = { toolDefs: {}, commandDefs: {}, messageRenderers: {}, customMessages: [] };
const planPi = {
	on: (e, h) => { (planReg[e] ??= []).push(h); },
	registerTool: (t) => { planReg.toolDefs[t.name] = t; },
	registerCommand: (n, d) => { planReg.commandDefs[n] = d; },
	registerMessageRenderer: (t, r) => { planReg.messageRenderers[t] = r; },
	sendMessage: (m) => planReg.customMessages.push(m),
	sendUserMessage: () => {},
	getThinkingLevel: () => "medium",
	exec: pi.exec,
};
planMod.registerCodexPlan(planPi);
planMod.registerCodexReview(planPi, { createSession: async () => ({ session: makeFakeSession() }) });

// update_plan renders codex-style with ✔ / □
const planCtx = { ...cmdCtx, cwd: WORKSPACE };
await planReg.toolDefs.update_plan.execute("p1", {
	explanation: "Refactor in three steps",
	plan: [
		{ step: "Read the module", status: "completed" },
		{ step: "Write the new API", status: "in_progress" },
		{ step: "Update callers", status: "pending" },
	],
}, undefined, undefined, planCtx);
const planMsg = planReg.customMessages.find((m) => m.customType === "codex-plan");
console.log(planReg.messageRenderers["codex-plan"]({ details: planMsg.details }, { expanded: false }, themeFull).render(80).join("\n"));

// at-most-one in_progress guard
const dup = await planReg.toolDefs.update_plan.execute("p2", { plan: [
	{ step: "a", status: "in_progress" }, { step: "b", status: "in_progress" },
] }, undefined, undefined, planCtx);
if (!dup.isError) throw new Error("update_plan should reject two in_progress");
console.log("  ok: rejects two in_progress steps");

// Plan Mode blocks update_plan
await planReg.commandDefs.plan.handler("", planCtx);
const blocked = await planReg.toolDefs.update_plan.execute("p3", { plan: [] }, undefined, undefined, planCtx);
if (!blocked.isError) throw new Error("update_plan should be blocked in Plan Mode");
console.log("  ok: Plan Mode blocks update_plan + injects collaboration prompt");
const planBas = planReg.before_agent_start[0];
const planSp = await planBas({}, { getSystemPrompt: () => "BASE" });
if (!planSp?.systemPrompt?.includes("Plan Mode")) throw new Error("plan-mode prompt not injected");

// /review runs a nested session and renders findings
await planReg.commandDefs.review.handler("focus on auth", { ...planCtx });
const reviewMsg = planReg.customMessages.find((m) => m.customType === "codex-review");
if (!reviewMsg || !/did:/.test(reviewMsg.details.text)) throw new Error("review produced no findings");
console.log("  ok: /review nested session ->", JSON.stringify(reviewMsg.details.text.slice(0, 40)));

// --- Composer shortcuts panel (bound to `?`, not a slash command) ----------
console.log("== composer ==");
if (registered.commandDefs.shortcuts) throw new Error("/shortcuts should NOT be a slash command (not in Codex)");
if (!registered.shortcutDefs?.["?"]) throw new Error("? shortcut missing");
if (!registered.messageRenderers["codex-shortcuts"]) throw new Error("shortcuts renderer missing");
const emptyEditorCtx = { ...cmdCtx, ui: { ...cmdCtx.ui, getEditorText: () => "" } };
await registered.shortcutDefs["?"].handler(emptyEditorCtx);
const scMsg = registered.customMessages.find((m) => m.customType === "codex-shortcuts");
if (!scMsg) throw new Error("shortcuts panel not emitted by ?");
const scPanel = registered.messageRenderers["codex-shortcuts"]({ details: {} }, { expanded: false }, themeFull).render(80);
if (!scPanel.join("\n").includes("Keyboard shortcuts") || !scPanel.join("\n").includes("Slash commands"))
	throw new Error("shortcuts panel content wrong");
console.log(scPanel.slice(0, 6).join("\n"));
console.log("  ok: ? panel renders (no /shortcuts command)");

// Command descriptions must match Codex verbatim.
const CODEX_DESC = {
	status: "show current session configuration and token usage",
	diff: "show git diff (including untracked files)",
	init: "create an AGENTS.md file with instructions for Codex",
	mention: "mention a file",
	goal: "set or view the goal for a long-running task",
	personality: "choose a communication style for Codex",
	permissions: "choose what Codex is allowed to do",
	plan: "switch to Plan mode",
	review: "review my current changes and find issues",
	agent: "switch the active agent thread",
	subagents: "switch the active agent thread",
};
for (const [name, desc] of Object.entries(CODEX_DESC)) {
	const def = registered.commandDefs[name];
	if (!def) throw new Error(`command /${name} missing`);
	if (def.description !== desc) throw new Error(`/${name} desc mismatch:\n  mine:  ${def.description}\n  codex: ${desc}`);
}
console.log(`  ok: ${Object.keys(CODEX_DESC).length} command descriptions match Codex verbatim`);
if (typeof registered.editorFactory !== "function") throw new Error("codex composer editor not installed");
console.log("  ok: codex composer editor installed (visual — verified via screenshot)");

console.log("\nOK: extension loaded, all surfaces rendered");
