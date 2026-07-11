/**
 * Loads a core plugin + a look plugin the way pi does (jiti), wires them through
 * a SHARED event bus + shared message-renderer/command registries, and drives
 * the contract end-to-end: core emits cards → look renders them; core broadcasts
 * state → look reacts.
 *
 * Usage (in container):
 *   node tests/two-plugin-check.mjs codex-core codex-look
 *   node tests/two-plugin-check.mjs codex-core claude-look
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI_PKG = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(PI_PKG + "/package.json");
const { createJiti } = require("jiti");
const here = path.dirname(fileURLToPath(import.meta.url));
const [coreName, lookName] = process.argv.slice(2);
if (!coreName || !lookName) throw new Error("usage: two-plugin-check.mjs <core-pkg> <look-pkg>");

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": PI_PKG,
		"@earendil-works/pi-tui": PI_PKG + "/node_modules/@earendil-works/pi-tui",
		typebox: PI_PKG + "/node_modules/typebox/build/index.mjs",
	},
});

// --- Shared bus + registries (one instance shared by both plugins) ---------
const busHandlers = new Map();
const events = {
	emit: (ch, data) => (busHandlers.get(ch) ?? []).forEach((h) => h(data)),
	on: (ch, h) => {
		if (!busHandlers.has(ch)) busHandlers.set(ch, []);
		busHandlers.get(ch).push(h);
		return () => {};
	},
};
const reg = { commands: {}, tools: {}, messageRenderers: {}, shortcuts: {}, customMessages: [], widgets: {}, editorFactory: null, theme: null };

function makePi() {
	const handlers = new Map();
	const pi = {
		events,
		on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h); },
		_handlers: handlers,
		registerCommand: (n, d) => (reg.commands[n] = d),
		registerTool: (t) => (reg.tools[t.name] = t),
		registerMessageRenderer: (t, r) => (reg.messageRenderers[t] = r),
		registerShortcut: (k, d) => (reg.shortcuts[k] = d),
		sendMessage: (m) => reg.customMessages.push(m),
		sendUserMessage: () => {},
		getThinkingLevel: () => "medium",
		getSessionName: () => "test session",
		appendEntry: () => {},
		exec: async (cmd, args) => {
			const { execFile } = await import("node:child_process");
			return new Promise((res) => execFile(cmd, args, { cwd: process.env.EXEC_CWD ?? "/tmp", maxBuffer: 10e6 },
				(err, stdout, stderr) => res({ stdout: stdout ?? "", stderr: stderr ?? "", code: err?.code ?? (err ? 1 : 0), killed: false })));
		},
	};
	return pi;
}

const theme = {
	name: "dark",
	fg: (_s, t) => `\x1b[36m${t}\x1b[39m`,
	bg: (_s, t) => `\x1b[48;5;238m${t}\x1b[49m`,
	bold: (t) => `\x1b[1m${t}\x1b[22m`,
};
const ctx = {
	mode: "tui", hasUI: true, cwd: process.env.EXEC_CWD ?? "/tmp",
	model: { id: "gpt-5-codex", provider: "openai", contextWindow: 200000 },
	getContextUsage: () => ({ tokens: 12000, contextWindow: 200000, percent: 6 }),
	getSystemPrompt: () => "BASE",
	ui: {
		theme,
		setTheme: (n) => (reg.theme = n),
		setHeader: (f) => (reg.header = f),
		setFooter: (f) => (reg.footer = f),
		setWorkingIndicator: (o) => (reg.indicator = o),
		setWorkingMessage: () => {},
		setWidget: (k, c) => (reg.widgets[k] = c),
		setStatus: () => {},
		setEditorComponent: (f) => (reg.editorFactory = f),
		notify: () => {},
		select: async (_t, opts) => opts[0],
		getEditorText: () => "",
		setEditorText: () => {},
	},
};

// --- Load both plugins on the shared bus ------------------------------------
const corePi = makePi();
const lookPi = makePi();
const coreFactory = await jiti.import(path.resolve(here, `../${coreName}/src/core.ts`), { default: true });
const lookEntry = lookName === "codex-look" ? "look.ts" : "look.ts";
const lookFactory = await jiti.import(path.resolve(here, `../${lookName}/src/${lookEntry}`), { default: true });
await coreFactory(corePi);
await lookFactory(lookPi);

for (const h of corePi._handlers.get("session_start") ?? []) await h({}, ctx);
for (const h of lookPi._handlers.get("session_start") ?? []) await h({}, ctx);

const assert = (name, cond) => { if (!cond) throw new Error(`FAIL: ${name}`); console.log(`  ok: ${name}`); };

console.log(`== ${coreName} + ${lookName} ==`);
// Core registered functionality
for (const c of ["status", "diff", "init", "mention", "goal", "personality", "permissions", "plan", "review", "agent", "subagents"])
	assert(`core command /${c}`, !!reg.commands[c]);
for (const t of ["spawn_agent", "delegate", "wait_agent", "list_agents", "interrupt_agent", "close_agent", "update_plan"])
	assert(`core tool ${t}`, !!reg.tools[t]);

// Look registered chrome
assert("look set a theme", typeof reg.theme === "string");
assert("look set header", typeof reg.header === "function");
assert("look set footer", typeof reg.footer === "function");
assert("look set working indicator", !!reg.indicator);
assert("look installed composer editor", typeof reg.editorFactory === "function");

// Contract: core /status emits a card, look renders it
await reg.commands.status.handler("", ctx);
const statusMsg = reg.customMessages.find((m) => m.customType === "cpx.status");
assert("core emitted cpx.status", !!statusMsg);
assert("look renders cpx.status", !!reg.messageRenderers["cpx.status"]);
const statusCard = reg.messageRenderers["cpx.status"]({ details: statusMsg.details }, { expanded: false }, theme).render(80);
assert("cpx.status card non-empty", statusCard.length > 3);
console.log(statusCard.slice(0, 3).join("\n"));

// Contract: core /plan broadcasts mode → look footer reacts; update_plan card renders
await reg.commands.plan.handler("", ctx);
const footerLine = reg.footer(null, theme, { getGitBranch: () => "main" }).render(80).join("");
assert("footer shows plan mode after /plan", /plan/.test(footerLine));
console.log("  footer:", footerLine.replace(/\x1b\[[0-9;]*m/g, ""));

await reg.commands.plan.handler("off", ctx); // update_plan is (correctly) blocked in plan mode
await reg.tools.update_plan.execute("p", { plan: [{ step: "x", status: "in_progress" }] }, undefined, undefined, ctx);
const planMsg = reg.customMessages.find((m) => m.customType === "cpx.plan");
assert("update_plan emitted cpx.plan", !!planMsg);
assert("look renders cpx.plan", !!reg.messageRenderers["cpx.plan"]);

// Contract: subagent broadcast → look widget
await reg.commands.goal.handler("ship it", ctx);
assert("look reacted to goal widget", !!reg.widgets["codex-goal"]);

console.log(`\nOK: ${coreName} + ${lookName} — functionality + look wired through the contract`);
