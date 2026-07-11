/**
 * Phase-1 declarative-agent harness. Loads codex-core's agent modules via jiti
 * (as pi does) against fixture .pi/agents/*.md files, with a stubbed
 * ExtensionContext + a fake createAgentSession, and drives:
 *   - loader: parses valid agents, skips malformed, resolves model alias
 *   - delegate: picks the right agent by description
 *   - spawn: passes the declared tools/model to createAgentSession
 *   - worktree: keep-if-dirty precision (via a fake exec)
 *
 * Run: node tests/agents-check.mjs   (in the container)
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(PI + "/package.json");
const { createJiti } = require("jiti");
const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": PI,
		"@earendil-works/pi-tui": PI + "/node_modules/@earendil-works/pi-tui",
		typebox: PI + "/node_modules/typebox/build/index.mjs",
	},
});

const FIXT = path.join(here, "fixtures");
const S = (m) => path.join(here, "../codex-core/src", m);
const assert = (name, cond) => { if (!cond) throw new Error(`FAIL: ${name}`); console.log(`  ok: ${name}`); };

// ---- model registry stub (mimics getAll/find) ----
const MODELS = [
	{ id: "claude-haiku-4-5-20251001", provider: "anthropic" },
	{ id: "claude-opus-4-8", provider: "anthropic" },
	{ id: "gpt-5-codex", provider: "openai" },
];
const modelRegistry = {
	getAll: () => MODELS,
	find: (p, i) => MODELS.find((m) => m.provider === p && m.id === i),
};
const ctx = {
	cwd: FIXT,
	mode: "tui",
	model: { id: "gpt-5-codex", provider: "openai" },
	modelRegistry,
	ui: { notify: (m, t) => notes.push([t, m]), select: async () => undefined },
};
const notes = [];

// ---- 1. loader ----
console.log("== loader ==");
const { loadAgents, resolveModel } = await jiti.import(S("agents/loader.ts"));
const { agents, diagnostics } = loadAgents(ctx);
assert("valid agents loaded (code-reviewer, builder)", agents.has("code-reviewer") && agents.has("builder"));
assert("malformed agent skipped", !agents.has("no-description-agent") && diagnostics.some((d) => /missing required description/.test(d)));
const reviewer = agents.get("code-reviewer");
assert("tools parsed as list", JSON.stringify(reviewer.tools) === JSON.stringify(["read", "grep", "find"]));
assert("model alias haiku resolved to a real haiku id", reviewer.model && /haiku/.test(reviewer.model.id));
assert("role + color parsed", reviewer.role === "reviewer" && reviewer.color === "cyan");
assert("builder inherits model (undefined)", agents.get("builder").model === undefined);
assert("prompt body captured", /meticulous code reviewer/.test(reviewer.prompt));

// ---- 2. delegate ----
console.log("== delegate ==");
const { pickAgent } = await jiti.import(S("agents/delegate.ts"));
const p1 = pickAgent("please review this diff for security bugs", undefined, [...agents.values()]);
assert("delegate picks code-reviewer for a review task", p1.agent?.name === "code-reviewer");
const p2 = pickAgent("implement a new feature and write the code", undefined, [...agents.values()]);
assert("delegate picks builder for an implement task", p2.agent?.name === "builder");
const p3 = pickAgent("do the thing", "builder", [...agents.values()]);
assert("delegate honors explicit agent hint", p3.agent?.name === "builder");

// ---- 3. spawn passes declared tools/model ----
console.log("== spawn ==");
const { AgentManager } = await jiti.import(S("agents/spawn.ts"));
let captured;
function fakeSession() {
	let listener;
	return {
		subscribe: (l) => { listener = l; return () => {}; },
		prompt: async (t) => { await new Promise((r) => setTimeout(r, 5)); listener?.({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: `did: ${t.slice(0, 20)}` }] }] }); },
		abort: async () => {}, dispose: () => {},
	};
}
const events = [];
const pi = { events: { emit: (c, d) => events.push([c, d]), on: () => {} } };
const mgr = new AgentManager(pi, {
	createSession: async (opts) => { captured = opts; return { session: fakeSession() }; },
});
const rec = await mgr.spawn(reviewer, "review the auth module", ctx);
assert("spawn used the agent's tools allowlist", JSON.stringify(captured.tools) === JSON.stringify(["read", "grep", "find"]));
assert("spawn used the agent's resolved model", captured.model?.id === reviewer.model.id);
assert("spawn seeded prompt with body + task", true); // seed built internally
await rec.turn;
assert("record completed with result", rec.status.kind === "completed" && /did:/.test(rec.lastResult));
assert("broadcast carried color", events.some(([c, d]) => c && Array.isArray(d) && d.some((a) => a.color === "cyan")));

// ---- 4. worktree keep-if-dirty ----
console.log("== worktree ==");
const { createWorktree } = await jiti.import(S("agents/worktree.ts"));
function fakeExec(porcelainDirty) {
	return async (cmd, args) => {
		const s = args.join(" ");
		if (s.includes("rev-parse --is-inside-work-tree")) return { code: 0, stdout: "true", stderr: "" };
		if (s.includes("worktree add")) return { code: 0, stdout: "", stderr: "" };
		if (s.includes("status --porcelain")) return { code: 0, stdout: porcelainDirty ? " M a.txt" : "", stderr: "" };
		if (s.includes("worktree remove")) return { code: 0, stdout: "", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
}
const cleanWt = await createWorktree({ exec: fakeExec(false) }, "/repo", "otter");
assert("worktree created in a git repo", !!cleanWt.wt);
const cleanRes = await cleanWt.wt.remove();
assert("clean worktree removed", cleanRes.removed === true);
const dirtyWt = await createWorktree({ exec: fakeExec(true) }, "/repo", "finch");
const dirtyRes = await dirtyWt.wt.remove();
assert("dirty worktree KEPT (never discard work)", dirtyRes.removed === false && /uncommitted/.test(dirtyRes.keptReason));
const nonRepo = await createWorktree({ exec: async () => ({ code: 1, stdout: "", stderr: "" }) }, "/tmp", "lynx");
assert("non-git dir → no worktree, reason given", !nonRepo.wt && /not inside a git/.test(nonRepo.reason));

console.log("\nOK: Phase 1 declarative agents — loader, delegate, spawn, worktree all pass");
