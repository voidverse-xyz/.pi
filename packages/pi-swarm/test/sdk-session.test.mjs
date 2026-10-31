import {
	chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
	rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import test from "node:test";
import { Type } from "typebox";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createMockRuntime } from "./sdk-env.mjs";
import { guardNetwork } from "./network-guard.mjs";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createSdkSession, readSessionHistory } from "../extensions/swarm/sdk-session.mjs";

async function fixture(t, script = []) {
	guardNetwork(t);
	const root = mkdtempSync(join(tmpdir(), "swarm-sdk-"));
	const cwd = join(root, "checkout");
	mkdirSync(cwd);
	const mock = await createMockRuntime(script);
	const options = {
		cwd, sessionDir: join(root, "sessions"), modelRuntime: mock.modelRuntime,
		selection: mock.selection, systemPrompt: "Only the explicit swarm prompt.", customTools: [],
	};
	const sessions = [];
	t.after(() => { for (const session of sessions) session.dispose(); rmSync(root, { recursive: true, force: true }); });
	return {
		root, ...mock, options,
		async open(overrides = {}) {
			const result = await createSdkSession({ ...options, ...overrides });
			sessions.push(result.session);
			return result;
		},
	};
}

async function until(predicate) {
	for (let i = 0; i < 300; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("Timed out waiting for mock request");
}

test("public custom messages with triggerTurn false persist idle and queue during a turn without model continuation", async t => {
	const f = await fixture(t, [{ waitForAbort: true }]);
	const { session } = await f.open();
	const notice = content => ({ customType: "swarm-progress", content, display: true });
	await session.sendCustomMessage(notice("Idle observation"), { triggerTurn: false });
	assert.equal(f.calls.length, 0);
	assert.ok(session.messages.some(message => message.content === "Idle observation"));
	const prompt = session.prompt("Hold this fixture turn");
	await until(() => f.calls.length === 1);
	await session.sendCustomMessage(notice("During-turn observation"), { triggerTurn: false });
	assert.equal(session.messages.some(message => message.content === "During-turn observation"), false);
	await session.abort(); await prompt; await session.waitForIdle();
	assert.equal(f.calls.length, 1);
	assert.equal(session.messages.filter(message => message.content === "During-turn observation").length, 1);
});

test("native session identity persists before first prompt and after idle/reopen", async (t) => {
	const f = await fixture(t, [{ text: "First answer" }, { text: "Second answer" }]);
	const first = await f.open();
	const bound = { sessionId: first.sessionId, sessionFile: first.sessionFile };
	assert.equal(existsSync(first.sessionFile), false, "Pi writes the session file at the first prompt");
	if (process.platform !== "win32") assert.equal(statSync(f.options.sessionDir).mode & 0o777, 0o700);
	const empty = await f.open(bound);
	assert.equal(empty.sessionId, first.sessionId);
	empty.session.dispose();
	const events = [];
	first.session.subscribe((event) => events.push(event.type));
	await first.session.prompt("First request");
	await first.session.waitForIdle();
	assert.equal(first.session.isStreaming, false);
	assert.ok(events.includes("agent_end"));
	assert.ok(events.indexOf("agent_settled") > events.indexOf("agent_end"));
	assert.equal(first.session.isIdle, true);
	assert.equal(f.calls.length, 1);
	first.session.dispose();
	const reopened = await f.open(bound);
	assert.equal(reopened.sessionId, first.sessionId);
	assert.equal(reopened.sessionFile, first.sessionFile);
	assert.ok(reopened.session.messages.some((message) => message.content?.[0]?.text === "First request"));
	await reopened.session.prompt("Second request");
	assert.ok(f.calls[1].context.messages.some((message) => message.content?.[0]?.text === "First answer"));
	assert.equal(readdirSync(f.options.sessionDir).length, 1);
});

test("a session reopened before its first prompt keeps its identity when Pi files it under a new name", async t => {
	const f = await fixture(t, [{ text: "First answer" }, { text: "Second answer" }]);
	const first = await f.open();
	const bound = { sessionId: first.sessionId, sessionFile: first.sessionFile };
	first.session.dispose();
	assert.deepEqual(readSessionHistory(bound.sessionFile, f.options.cwd, bound.sessionId), []);
	const reopened = await f.open(bound);
	assert.equal(reopened.sessionId, bound.sessionId);
	await reopened.session.prompt("First request");
	reopened.session.dispose();
	const again = await f.open(bound);
	assert.equal(again.sessionId, bound.sessionId);
	assert.equal(again.sessionFile, reopened.sessionFile);
	assert.ok(again.session.messages.some((message) => message.content?.[0]?.text === "First request"));
	assert.deepEqual(readSessionHistory(bound.sessionFile, f.options.cwd, bound.sessionId), again.manager.getBranch());
	await again.session.prompt("Second request");
	assert.ok(f.calls[1].context.messages.some((message) => message.content?.[0]?.text === "First answer"));
	assert.equal(readdirSync(f.options.sessionDir).length, 1);
});

test("explicit custom tools replace builtin names and unknown builtin calls never execute", async (t) => {
	const f = await fixture(t, [
		{ toolCalls: [{ name: "read", arguments: { path: "fake" } }, { name: "bash", arguments: { command: "exit 0" } }] },
		{ text: "Finished" },
	]);
	let reads = 0;
	const read = {
		name: "read", label: "Guarded read", description: "Only the supplied read", parameters: Type.Object({ path: Type.String() }),
		async execute() { reads++; return { content: [{ type: "text", text: "guarded" }], details: {} }; },
	};
	const { session } = await f.open({ customTools: [read] });
	assert.deepEqual(session.getActiveToolNames(), ["read"]);
	assert.deepEqual(session.getAllTools().map((tool) => [tool.name, tool.sourceInfo.source]), [["read", "sdk"]]);
	await session.prompt("Call the tools");
	assert.equal(reads, 1);
	assert.deepEqual(getCurrentTools(f.calls[0].context.messages).map((tool) => tool.name), ["read"]);
	assert.ok(session.messages.some((message) => message.role === "toolResult" && message.toolName === "bash" && message.isError));
	const isolated = await f.open();
	assert.deepEqual(isolated.session.getAllTools(), []);
	assert.deepEqual(isolated.session.getActiveToolNames(), []);
});

test("resource loader ignores project context, extensions, prompts, skills, and settings", async (t) => {
	const f = await fixture(t, [{ text: "No discovery" }]);
	const cwd = f.options.cwd;
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
	mkdirSync(join(cwd, ".agents", "skills", "sentinel"), { recursive: true });
	writeFileSync(join(cwd, "AGENTS.md"), "CONTEXT_DISCOVERY_SENTINEL");
	writeFileSync(join(cwd, "SYSTEM.md"), "SYSTEM_DISCOVERY_SENTINEL");
	writeFileSync(join(cwd, ".pi", "extensions", "sentinel.mjs"), 'throw new Error("EXTENSION_DISCOVERY_SENTINEL")');
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true }, defaultTools: ["bash"] }));
	writeFileSync(join(cwd, ".pi", "prompts", "sentinel.md"), "PROMPT_DISCOVERY_SENTINEL");
	writeFileSync(join(cwd, ".agents", "skills", "sentinel", "SKILL.md"), "---\nname: sentinel\ndescription: SKILL_DISCOVERY_SENTINEL\n---\nSentinel");
	const { session } = await f.open();
	await session.prompt("/sentinel");
	assert.match(getCurrentSystemPrompt(f.calls[0].context.messages), /Only the explicit swarm prompt/);
	assert.doesNotMatch(JSON.stringify(f.calls[0].context), /DISCOVERY_SENTINEL/);
	assert.deepEqual(session.getAllTools(), []);
	assert.equal(session.settingsManager.getCompactionEnabled(), true);
	assert.equal(session.settingsManager.getRetryEnabled(), true);
	assert.equal(f.calls[0].options.maxRetries, undefined);
});

test("abort reaches mock stream and real SDK becomes idle without retry", async (t) => {
	const f = await fixture(t, [{ waitForAbort: true }]);
	const { session } = await f.open();
	const prompt = session.prompt("Wait");
	await until(() => f.calls.length === 1);
	assert.equal(session.isStreaming, true);
	await session.abort();
	await prompt;
	await session.waitForIdle();
	assert.equal(session.isStreaming, false);
	assert.equal(f.calls[0].options.signal.aborted, true);
	assert.equal(f.calls.length, 1);
	assert.equal(session.messages.at(-1).stopReason, "aborted");
});

test("Pi 1.0 abort and idle wait for agent_settled after an uncooperative provider unwinds", async t => {
	let release;
	const held = new Promise(resolve => { release = resolve; });
	t.after(() => release());
	const f = await fixture(t, async () => { await held; return { text: "Must not escape abort" }; });
	const { session } = await f.open();
	const events = [];
	session.subscribe(event => events.push(event.type));
	const prompt = session.prompt("Hold the provider");
	await until(() => f.calls.length === 1);
	let aborted = false;
	let idle = false;
	const abort = session.abort().then(() => { aborted = true; });
	const waiting = session.waitForIdle().then(() => { idle = true; });
	await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(f.calls[0].options.signal.aborted, true);
	assert.equal(aborted, false);
	assert.equal(idle, false);
	assert.equal(session.isIdle, false);
	assert.ok(!events.includes("agent_settled"));
	release();
	await Promise.all([prompt, abort, waiting]);
	assert.equal(session.isIdle, true);
	assert.equal(session.messages.at(-1).stopReason, "aborted");
	assert.ok(events.indexOf("agent_settled") > events.indexOf("agent_end"));
});

test("Pi 1.0 branch context edits and retain-none checkpoints reopen without rewriting raw history", async t => {
	const f = await fixture(t, [{ text: "Omitted response" }, { text: "After edits" }]);
	const first = await f.open();
	await first.session.prompt("Original request");
	const entries = first.manager.getEntries();
	const user = entries.find(entry => entry.type === "message" && entry.message.role === "user");
	const assistant = entries.find(entry => entry.type === "message" && entry.message.role === "assistant");
	first.manager.appendContextEdit(user.id, { content: "Replacement request" });
	first.manager.appendContextEdit(assistant.id, null);
	first.session.dispose();
	const bound = { sessionId: first.sessionId, sessionFile: first.sessionFile };
	const reopened = await f.open(bound);
	await reopened.session.prompt("Continue");
	assert.match(JSON.stringify(f.calls[1].context), /Replacement request/);
	assert.doesNotMatch(JSON.stringify(f.calls[1].context), /Original request|Omitted response/);
	assert.equal(reopened.manager.getEntry(assistant.id).message.content[0].text, "Omitted response");
	const checkpointId = reopened.manager.appendCompaction("Retain only this summary", null, 100);
	assert.equal(reopened.manager.getEntry(checkpointId).firstKeptEntryId, checkpointId);
	reopened.session.dispose();
	const compacted = await f.open(bound);
	assert.ok(compacted.session.messages.some(message => message.role === "compactionSummary"));
	assert.ok(!compacted.session.messages.some(message => message.role === "assistant"));
	assert.equal(compacted.manager.getEntry(assistant.id).message.content[0].text, "Omitted response");
});

test("manual native compaction preserves session, summary, and full durable history", async (t) => {
	const f = await fixture(t, [
		{ text: "Remember the original decision" }, { text: "Recent response" },
		{ text: "## Goal\nPreserve the original decision." },
	]);
	const { session, manager, sessionFile, sessionId } = await f.open();
	await session.prompt("We decided to preserve history.");
	await session.prompt("Recent context. ".repeat(7000));
	const before = manager.getEntries().filter((entry) => entry.type === "message").length;
	const result = await session.compact("Keep the decision and current task");
	assert.match(result.summary, /original decision/);
	assert.equal(session.sessionId, sessionId);
	assert.equal(manager.getEntries().filter((entry) => entry.type === "message").length, before);
	const checkpoint = manager.getEntries().find((entry) => entry.type === "compaction");
	assert.equal(checkpoint.systemMessage.role, "system");
	assert.match(getCurrentSystemPrompt([checkpoint.systemMessage]), /Only the explicit swarm prompt/);
	assert.equal(f.calls.length, 3);
	assert.equal(f.calls[2].options.maxRetries, undefined);
	assert.equal(f.calls[2].model.provider, "swarm-mock");
	assert.match(JSON.stringify(f.calls[2].context), /Keep the decision/);
	session.dispose();
	const reopened = await f.open({ sessionId, sessionFile });
	assert.equal(reopened.sessionId, sessionId);
	assert.ok(reopened.session.messages.some((message) => message.role === "compactionSummary"));
});

test("transient provider failures retry successfully without burning a task attempt", async (t) => {
	const f = await fixture(t, [{ error: "429 rate limit exceeded" }, { text: "Recovered" }]);
	const { session, manager } = await f.open();
	await session.prompt("Fail once");
	assert.equal(f.calls.length, 2);
	assert.equal(session.messages.at(-1).stopReason, "stop");
	assert.equal(manager.getEntries().some((entry) => entry.type === "compaction"), false);
});

test("aborted native manual compaction retains original history and identity", async (t) => {
	const f = await fixture(t, [{ text: "Old decision" }, { text: "Recent response" }, { waitForAbort: true }]);
	const { session, manager, sessionId } = await f.open();
	await session.prompt("Old decision");
	await session.prompt("Recent context. ".repeat(7000));
	const before = manager.getEntries();
	const compact = session.compact("Keep the decision");
	const rejected = assert.rejects(compact, /abort|cancel/i);
	await until(() => f.calls.length === 3);
	session.abortCompaction();
	await rejected;
	assert.equal(session.sessionId, sessionId);
	assert.deepEqual(manager.getEntries(), before);
	assert.equal(f.calls[2].options.signal.aborted, true);
	assert.equal(f.calls.length, 3);
});

test("exhausted native compaction retries preserve original history", async (t) => {
	const f = await fixture(t, [{ text: "Old decision" }, { text: "Recent response" }, ...Array.from({ length: 4 }, () => ({ error: "429 rate limit exceeded" }))]);
	const { session, manager } = await f.open();
	await session.prompt("Old decision");
	await session.prompt("Recent context. ".repeat(7000));
	const before = manager.getEntries();
	await assert.rejects(session.compact("Keep the decision"), /429|rate limit/);
	assert.deepEqual(manager.getEntries(), before);
	assert.equal(f.calls.length, 6);
});

test("selection rejects real providers, missing models, and live APIs before creating storage", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.open({ selection: { ...f.selection, provider: "anthropic" } }), /only supports/);
	await assert.rejects(f.open({ selection: { ...f.selection, modelId: "missing" } }), /fallback is disabled/);
	await assert.rejects(f.open({ modelRuntime: { getModel: () => ({ ...f.model, api: "openai-completions" }) } }), /fallback is disabled/);
	assert.deepEqual(readdirSync(f.root), ["checkout"]);
	assert.equal(f.calls.length, 0);
});

test("approved thinking overrides persisted native thinking on idle restore", async (t) => {
	const f = await fixture(t, [{ text: "Persisted high thinking" }, { text: "New pinned thinking" }]);
	const first = await f.open({ selection: { ...f.selection, thinkingLevel: "high" } });
	await first.session.prompt("Persist old selection");
	first.session.dispose();
	const second = await f.open({ sessionId: first.sessionId, sessionFile: first.sessionFile });
	assert.equal(second.session.thinkingLevel, "off");
	assert.equal(second.session.model.id, f.selection.modelId);
	await second.session.prompt("Use new selection with old history");
	assert.equal(f.calls[1].options.reasoning, undefined);
	assert.match(JSON.stringify(f.calls[1].context), /Persisted high thinking/);
});

test("idle restore explicitly changes an old persisted model without replacing history or identity", async t => {
	const f = await fixture(t, [{ text: "Old model decision" }, { text: "New model response" }]);
	const first = await f.open();
	await first.session.prompt("Persist old model");
	first.session.dispose();
	const alternate = { ...f.model, id: "alternate" };
	const runtime = new Proxy(f.modelRuntime, { get(target, property) {
		if (property === "getModel") return (provider, id) => provider === "swarm-mock" && id === "alternate" ? alternate : target.getModel(provider, id);
		const value = Reflect.get(target, property, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
	const second = await f.open({ sessionId: first.sessionId, sessionFile: first.sessionFile,
		modelRuntime: runtime, selection: { ...f.selection, modelId: "alternate", thinkingLevel: "low" } });
	assert.equal(second.sessionId, first.sessionId);
	assert.equal(second.session.model.id, "alternate");
	await second.session.prompt("Continue with new model");
	assert.equal(f.calls[1].model.id, "alternate");
	assert.equal(f.calls[1].options.reasoning, "low");
	assert.match(JSON.stringify(f.calls[1].context), /Old model decision/);
});

for (const drift of ["model", "thinking", "metadata"]) test(`pinned ${drift} drift is denied before request admission`, async t => {
	const f = await fixture(t, [{ text: "Must not request" }]);
	let admissions = 0;
	const { session } = await f.open({ admitRequest() { admissions++; } });
	if (drift === "model") session.agent.state.model = { ...f.model, id: "other" };
	if (drift === "thinking") session.agent.state.thinkingLevel = "high";
	await assert.rejects(session.agent.streamFunction(f.model, { messages: [] }, { reasoning: drift === "metadata" ? "high" : undefined }), /approved model\/thinking/);
	assert.equal(admissions, 0);
	assert.equal(f.calls.length, 0);
});

test("pinned thinking drift in a native retry is denied without provider continuation", async t => {
	const f = await fixture(t, [{ error: "429 rate limit exceeded" }, { text: "Must not retry" }]);
	const { session } = await f.open();
	session.subscribe(event => { if (event.type === "auto_retry_start") session.agent.state.thinkingLevel = "high"; });
	await session.prompt("One initial failure");
	await session.waitForIdle();
	assert.equal(f.calls.length, 1);
	assert.equal(session.messages.at(-1).stopReason, "error");
});

test("manual compaction validates the actual pin before provider admission", async t => {
	const f = await fixture(t, [{ text: "Old history" }, { text: "Recent history" }]);
	let admissions = 0;
	const { session } = await f.open({ admitRequest() { admissions++; } });
	await session.prompt("Old context");
	await session.prompt("Recent context. ".repeat(7000));
	session.agent.state.thinkingLevel = "high";
	await assert.rejects(session.compact("Keep old history"), /approved model\/thinking/);
	assert.equal(admissions, 2);
	assert.equal(f.calls.length, 2);
});

test("reopen rejects a session file from another session or workspace and leaves it unchanged", async (t) => {
	const f = await fixture(t, [{ text: "Valid response" }]);
	const first = await f.open();
	await first.session.prompt("Valid request");
	first.session.dispose();
	const bound = { sessionId: first.sessionId, sessionFile: first.sessionFile };
	const [line, ...rest] = readFileSync(first.sessionFile, "utf8").split("\n");
	const header = JSON.parse(line);
	for (const changed of [{ ...header, id: "other-session" }, { ...header, cwd: f.root }]) {
		const text = [JSON.stringify(changed), ...rest].join("\n");
		writeFileSync(first.sessionFile, text);
		await assert.rejects(f.open(bound), /identity/);
		assert.throws(() => readSessionHistory(bound.sessionFile, f.options.cwd, bound.sessionId), /identity/);
		assert.equal(readFileSync(first.sessionFile, "utf8"), text);
	}
});

test("session paths reject symlinks, traversal, outside files and a public directory", async (t) => {
	const f = await fixture(t, [{ text: "Persisted response" }]);
	const first = await f.open();
	await first.session.prompt("Persist the session file");
	const bound = { sessionId: first.sessionId, sessionFile: first.sessionFile };
	const symlink = join(f.options.sessionDir, "alias.jsonl");
	symlinkSync(first.sessionFile, symlink);
	await assert.rejects(f.open({ ...bound, sessionFile: symlink }), /aliases|symlinks/);
	const aliasDir = join(f.root, "alias-dir");
	symlinkSync(f.options.sessionDir, aliasDir);
	await assert.rejects(f.open({ sessionDir: aliasDir }));
	await assert.rejects(f.open({ ...bound, sessionFile: join(f.root, "outside.jsonl") }), /inside/);
	await assert.rejects(f.open({ ...bound, sessionFile: `${f.options.sessionDir}/../sessions/${first.sessionFile.split("/").at(-1)}` }), /inside|canonical/);
	chmodSync(f.options.sessionDir, 0o755);
	if (process.platform !== "win32") await assert.rejects(f.open(bound), /private/);
});

test('retry backoff abort settles promptly without a later request', async t => {
 const f = await fixture(t, [{ error: '429 rate limit exceeded' }, { text: 'must not execute' }]);
 const { session } = await f.open({ admitRequest: () => {} });
 let retry;
 const started = new Promise(resolve => { retry = resolve; });
 session.subscribe(event => { if (event.type === 'auto_retry_start') retry(); });
 const prompt = session.prompt('Retry once');
 await started;
 const before = performance.now();
 await session.abort(); await prompt; await session.waitForIdle();
 assert.ok(performance.now() - before < 1500);
 assert.equal(f.calls.length, 1);
});

test('admission fences tool follow-up before the provider is called', async t => {
 let admitted = true;
 const f = await fixture(t, [{ toolCalls: [{ id: 'fence', name: 'fence', arguments: {} }] }, { text: 'must not execute' }]);
 const { session } = await f.open({ admitRequest() { if (!admitted) throw Error('FENCED'); },
  customTools: [{ name: 'fence', label: 'Fence', description: 'Fence test', parameters: Type.Object({}),
   async execute() { admitted = false; return { content: [{ type: 'text', text: 'fenced' }], details: {} }; } }] });
 await session.prompt('Fence after tool'); await session.waitForIdle();
 assert.equal(f.calls.length, 1); assert.equal(session.messages.at(-1).stopReason, 'error');
});

for (const cancel of [false, true]) test(`automatic compaction ${cancel ? 'cancels without a late request' : 'preserves a summary and continues'}`, async t => {
 const usage = { input: 120000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 120005,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
 let admissions = 0;
 const f = await fixture(t, [{ text: 'Original decision' }, { text: 'More context', usage },
  cancel ? { waitForAbort: true } : { text: 'Summary of original decision' }, { text: 'Continued after compaction' }]);
 const { session, manager } = await f.open({ admitRequest() { admissions++; } });
 await session.prompt('Original decision. '.repeat(8000));
 const prompt = session.prompt('Recent context. '.repeat(8000));
 if (cancel) {
  await until(() => f.calls.length === 3);
  session.abortCompaction(); await session.abort(); await prompt; await session.waitForIdle();
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].options.signal.aborted, true);
  assert.equal(manager.getEntries().some(entry => entry.type === 'compaction'), false);
 } else {
  await prompt; await session.waitForIdle();
  assert.ok(manager.getEntries().some(entry => entry.type === 'compaction'));
  await session.prompt('Continue the original task'); await session.waitForIdle();
  assert.equal(f.calls.length, 4);
  assert.match(JSON.stringify(f.calls[3].context.messages), /Summary of original decision/);
 }
 assert.equal(admissions, f.calls.length);
});


test("a bound fork with missing native history is fenced rather than reseeded", async t => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { captureWorkerContext } = await import("../extensions/swarm/context/fork.mjs");
	const { unlinkSync } = await import("node:fs");
	const f = await fixture(t);
	const parent = SessionManager.inMemory(f.options.cwd);
	parent.appendMessage({ role: "user", content: "Snapshot background", timestamp: 1 });
	const workerContext = captureWorkerContext({ sessionManager: parent }, "fork");
	const first = await f.open({ workerContext });
	assert.ok(existsSync(first.sessionFile)); first.session.dispose(); unlinkSync(first.sessionFile);
	await assert.rejects(f.open({ workerContext, sessionId: first.sessionId, sessionFile: first.sessionFile }), /Fork worker history is missing/);
	assert.equal(f.calls.length, 0);
});
