import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createProgress } from "../extensions/swarm/progress.mjs";
import { persistedMessageIds } from "../extensions/swarm/mail.mjs";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const delay = () => new Promise(resolve => setTimeout(resolve, 850));
function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "swarm-mail-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "main.jsonl"); writeFileSync(path, "");
	const branch = [];
	const ctx = { sessionManager: { getSessionFile: () => path, getBranch: () => branch } };
	const state = { run: { runId: "run1", status: "running", cycle: 1, revision: 1, objective: "Goal", workers: [], tasks: [], messages: [], sessions: { turns: [] }, workspace: { operations: [] } } };
	const listeners = new Set(), sent = [];
	const host = { snapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
	const pi = {
		appendEntry: (customType, data) => { const entry = { type: "custom", customType, data }; branch.push(entry); appendFileSync(path, JSON.stringify(entry) + "\n"); },
		sendMessage: (message, options) => { sent.push({ message, options }); }
	};
	const progress = createProgress(pi, () => ctx); progress.bind(host); progress.launched(); t.after(() => progress.dispose());
	const publish = () => { for (const fn of listeners) fn("message.send"); };
	const persist = message => appendFileSync(path, JSON.stringify({ type: "custom_message", ...message }) + "\n");
	return { ctx, state, host, pi, progress, sent, publish, persist, path };
}

test("coalesced owner mail still triggers a native turn; visual cards cannot acknowledge model delivery", async t => {
	const f = fixture(t);
	f.state.run.messages.push({ id: "one", from: "worker", to: "owner", text: "Question", topic: "Auth" }, { id: "peer", from: "a", to: "b", text: "Private peer coordination" });
	for (let i = 0; i < 20; i++) f.publish(); await delay();
	let mail = f.sent.filter(item => item.message.customType === "swarm-agent-mail");
	assert.equal(mail.length, 1); assert.equal(mail[0].options.triggerTurn, true);
	assert.equal(mail[0].message.display, false, "model delivery is separate from the visual card");
	assert.match(mail[0].message.content, /Question/); assert.doesNotMatch(mail[0].message.content, /Private peer coordination/);
	assert.deepEqual(f.ctx.sessionManager.getBranch().map(entry => entry.customType), ["swarm-mail-mirror"]);
	assert.deepEqual([...persistedMessageIds(f.ctx, "run1")], []);
	f.publish(); await delay(); assert.equal(f.sent.filter(item => item.message.customType === "swarm-agent-mail").length, 1);
	f.persist(mail[0].message); f.progress.settled(); await delay();
	assert.deepEqual([...persistedMessageIds(f.ctx, "run1")], ["one"]);
	assert.equal(f.sent.filter(item => item.message.customType === "swarm-agent-mail").length, 1);
	f.progress.dispose();
	const next = createProgress(f.pi, () => f.ctx); t.after(() => next.dispose()); next.bind(f.host); next.continued(); await delay();
	assert.equal(f.sent.filter(item => item.message.customType === "swarm-agent-mail").length, 1, "reload does not redeliver durable mail");
});

test("unacknowledged owner mail survives reload and partial writes never prove delivery", async t => {
	const f = fixture(t); f.state.run.messages.push({ id: "pending", from: "worker", to: "owner", text: "Pending finding" });
	f.publish(); await delay(); f.progress.dispose();
	const old = f.sent.find(item => item.message.customType === "swarm-agent-mail");
	writeFileSync(f.path, JSON.stringify({ type: "custom_message", ...old.message }));
	assert.equal(persistedMessageIds(f.ctx, "run1").size, 0);
	const next = createProgress(f.pi, () => f.ctx); t.after(() => next.dispose()); next.bind(f.host); next.continued(); await delay();
	assert.equal(f.sent.filter(item => item.message.customType === "swarm-agent-mail").length, 2);
	assert.equal(persistedMessageIds(f.ctx, "other-run").size, 0);
});


test("a failed visual projection cannot block actionable mail delivery", async t => {
	const f = fixture(t);
	f.pi.appendEntry = () => { throw Error("UI unavailable"); };
	f.state.run.messages.push({ id: "finding", from: "worker", to: "owner", text: "Need main-agent response" });
	f.publish(); await delay();
	assert.equal(f.sent.length, 1);
	assert.equal(f.sent[0].options.triggerTurn, true);
	assert.match(f.sent[0].message.content, /Need main-agent response/);
	assert.equal(f.sent[0].message.display, false);
});

test("actual Pi sessions retain automatic owner mail delivery without adding visual cards to provider context", async t => {
	const { mkdirSync } = await import("node:fs");
	const { createMockRuntime } = await import("./sdk-env.mjs");
	const { createSdkSession } = await import("../extensions/swarm/sdk-session.mjs");
	const root = mkdtempSync(join(tmpdir(), "swarm-native-mail-"));
	const cwd = join(root, "project"); mkdirSync(cwd);
	const mock = await createMockRuntime(() => ({ text: "Main agent acknowledged the finding" }));
	const opened = await createSdkSession({ cwd, sessionDir: join(root, "sessions"), modelRuntime: mock.modelRuntime,
		selection: mock.selection, systemPrompt: "Offline main conversation", customTools: [] });
	t.after(() => { opened.session.dispose(); rmSync(root, { recursive: true, force: true }); });
	await opened.session.prompt("Initial main conversation");
	const ctx = { sessionManager: opened.session.sessionManager };
	const state = { run: { runId: "native-mail", status: "running", cycle: 1, revision: 1, objective: "Goal", workers: [], tasks: [], messages: [], sessions: { turns: [] }, workspace: { operations: [] } } };
	const listeners = new Set(), failures = [];
	const host = { snapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
	const pi = {
		appendEntry: (type, data) => opened.session.sessionManager.appendCustomEntry(type, data),
		sendMessage: (message, options) => { void Promise.resolve(opened.session.sendCustomMessage(message, options)).catch(error => failures.push(error)); }
	};
	const progress = createProgress(pi, () => ctx); t.after(() => progress.dispose()); progress.bind(host); progress.launched();
	const off = opened.session.subscribe(event => { if (event.type === "agent_settled") progress.settled(); }); t.after(off);
	state.run.messages.push({ id: "finding", from: "worker", to: "owner", text: "Can you review this finding?" });
	for (const fn of listeners) fn("message.send");
	for (let i = 0; i < 400 && !persistedMessageIds(ctx, "native-mail").has("finding"); i++) await new Promise(resolve => setTimeout(resolve, 5));
	await opened.session.waitForIdle();
	assert.equal(mock.calls.length, 2);
	assert.ok(persistedMessageIds(ctx, "native-mail").has("finding"));
	assert.equal(JSON.stringify(mock.calls[1].context).match(/Can you review this finding/g)?.length, 1);
	assert.doesNotMatch(JSON.stringify(mock.calls[1].context), /swarm-mail-mirror/);
	for (const fn of listeners) fn("message.send"); await delay();
	assert.equal(mock.calls.length, 2); assert.deepEqual(failures, []);
});


test("mail beyond one batch drains without another workspace event", async t => {
	const f = fixture(t);
	for (let i = 0; i < 35; i++) f.state.run.messages.push({ id: `batch-${i}`, from: "worker", to: "owner", text: `Finding ${i}` });
	f.publish(); await delay(); await delay();
	const mail = f.sent.filter(item => item.message.customType === "swarm-agent-mail");
	assert.equal(mail.length, 2);
	assert.deepEqual(mail.map(item => item.message.details.messageIds.length), [30, 5]);
	assert.equal(new Set(mail.flatMap(item => item.message.details.messageIds)).size, 35);
});


test("next real user input recovers an interrupted delivery without granting approval", async t => {
	const f = fixture(t); f.state.run.messages.push({ id: "lost", from: "worker", to: "owner", text: "Need clarification" });
	f.publish(); await delay();
	f.progress.settled(); await delay();
	assert.equal(f.sent.filter(item => item.message.customType === "swarm-agent-mail").length, 1, "no automatic retry loop");
	f.progress.input(); await delay();
	assert.equal(f.sent.filter(item => item.message.customType === "swarm-agent-mail").length, 2);
});


test("verified completion wakes main once and persistence acknowledges the result", async t => {
	const f = fixture(t);
	f.state.run.status = "completed"; f.state.run.completionEvidence = "final-receipt";
	f.state.run.tasks = [{ id: "feature", candidate: "Reviewed deliverable", status: "done" }];
	f.publish(); await delay();
	const mail = f.sent.filter(item => item.message.customType === "swarm-agent-mail");
	assert.equal(mail.length, 1); assert.equal(mail[0].options.triggerTurn, true);
	assert.match(mail[0].message.content, /recorded final verification/);
	assert.match(mail[0].message.content, /Reviewed deliverable/);
	f.persist(mail[0].message); f.progress.settled(); f.publish(); await delay();
	assert.equal(f.sent.filter(item => item.message.customType === "swarm-agent-mail").length, 1);
});


test("final verification failure wakes the owner interface without claiming completion", async t => {
	const f = fixture(t); f.state.run.status = "paused"; f.state.run.generation = 1;
	f.state.driver = { finalVerificationFailed: true };
	f.publish(); await delay();
	const mail = f.sent.filter(item => item.message.customType === "swarm-agent-mail");
	assert.equal(mail.length, 1); assert.equal(mail[0].options.triggerTurn, true);
	assert.match(mail[0].message.content, /deliverable is incomplete/);
	assert.match(mail[0].message.content, /no automatic retry/);
});
