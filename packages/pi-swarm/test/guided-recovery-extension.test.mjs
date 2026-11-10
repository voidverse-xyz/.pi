import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { repository } from "./helpers.mjs";
import { createMockRuntime } from "./sdk-env.mjs";
import { SwarmHost } from "../extensions/swarm/host.mjs";
import { reduceEvent } from "../extensions/swarm/state.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { createSwarmExtension } from "../extensions/swarm/extension.mjs";
import { atomicJson } from "../extensions/swarm/store/files.mjs";
import { acquireLease } from "../extensions/swarm/store/lease.mjs";
import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import { openJournal, inspectJournal } from "../extensions/swarm/store/journal.mjs";

const evidence = "independently verified fixture sessions and all commands have stopped";
const approve = () => ({ approved: true, attestation: { kind: "user-established-settlement", evidence } });
// External inspection never opens a journal writer or changes journal metadata.
const readJournal = layout => inspectJournal(layout.journalPath).events;
async function until(predicate) {
	for (let i = 0; i < 500; i++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 4));
	}
	assert.fail("Offline recovery did not settle within its bounded wait");
}

async function fixture(t, { stale = true, ownerSessionId = "owner1" } = {}) {
	t.mock.method(globalThis, "fetch", async () => assert.fail("Recovery tests must not contact a network provider"));
	const root = repository(t);
	const mock = await createMockRuntime(() => ({ waitForAbort: true }));
	const first = new SwarmHost({ events: new EventEmitter(), sessionId: "owner1", modelRuntime: mock.modelRuntime, mainModel: mock.model, requestApproval: approve, tickIntervalMs: 0 });
	const specification = { objective: "Recover the complete fixture objective\nwithout replay", criteria: ["Result"], scope: ["src"], codingTools: ["read"], instructions: "Preserve existing work", limits: { agents: 3, active: 2, tasks: 10, attempts: 2, durationMs: 60000 } };
	await first.launch({ workspace: root, runId: "run1", specification });
	await first.recruit({ id: "builder", specialization: "Build", brief: "Build approved work", reason: "Independent work" });
	await first.close();
	const layout = prepareLayout(root, "run1");
	let state = first.snapshot().run;
	const append = (actor, type, payload) => {
		const event = { version: 1, operationId: randomUUID(), actor, type, payload, expectedRevision: state.revision, cycle: state.cycle, generation: state.generation, atMs: state.lastAtMs };
		state = reduceEvent(state, event);
		const journal = openJournal(layout.journalPath, () => {});
		try { journal.append(event); } finally { journal.close(); }
	};
	// Only this safely closed, private offline fixture is given recorded orphan intent.
	append("owner", "run.resume", { reconciled: true });
	append("system", "session.turn.start", { id: "turn1", workerId: "builder", kind: "prompt", messageIds: [], guidanceRevision: 0 });
	append("builder", "task.create", { id: "task1", title: "Implement", criteria: [0], dependencies: [] });
	append("builder", "task.claim", { taskId: "task1", kind: "build", assignmentId: "assignment1" });
	append("system", "workspace.start", { id: "execution1", taskId: "task1", assignmentId: "assignment1", kind: "shell", command: "never replay this fixture command", paths: [], before: state.workspace.fingerprint });
	if (stale) {
		acquireLease(layout, { ownerSessionId: "owner1" });
		const leasePath = join(layout.ownerPath, "owner.json");
		atomicJson(leasePath, { ...JSON.parse(readFileSync(leasePath, "utf8")), pid: null });
	}
	const events = new EventEmitter(), handlers = new Map(), tools = new Map(), commands = new Map(), entries = [], packets = [];
	const mode = { version: 1, instanceId: "fixture-mode", revision: 1, contextRevision: 1, ready: true, sessionId: ownerSessionId, selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false };
	events.on("pi-plan:query-mode", request => request.respond({ ...mode }));
	const dialog = async () => assert.fail("Recovery must use owner chat, never a native approval dialog");
	const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: { getSessionId: () => ownerSessionId, getSessionFile: () => "fixture-owner.jsonl", getEntries: () => entries, getBranch: () => entries },
		ui: { input: dialog, select: dialog, confirm: dialog, notify() {} } };
	const pi = { events, registerMessageRenderer() {}, registerEntryRenderer() {}, sendMessage() {},
		registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
	createSwarmExtension({ modelRuntime: mock.modelRuntime, mainModel: mock.model, tickIntervalMs: 0 })(pi);
	const event = (name, data = {}) => handlers.get(name)(data, ctx);
	const tool = (args, signal) => tools.get("swarm_control").execute("fixture-owner", args, signal, output => packets.push(output.content[0].text), ctx);
	const input = (text, source = "interactive") => event("input", { source, text });
	const consume = p => tool({ action: "recover", proposalId: p.proposalId });
	const propose = async (args = {}) => {
		const result = await tool({ action: "recover", runId: "run1", ...args });
		assert.equal(result.isError, undefined, result.details.error);
		assert.equal(result.details.awaitingConfirmation, true);
		return result.details;
	};
	t.after(() => event("session_shutdown"));
	return { root, layout, mock, state, specification, append, event, tool, input, consume, propose, packets, ctx, commands };
}

for (const resume of [false, true]) test(`one owner reply recovers ${resume ? "and resumes the old roster" : "paused without dispatch"}`, { timeout: 15000 }, async t => {
	const f = await fixture(t), before = readJournal(f.layout);
	const p = await f.propose(resume ? { resume: true } : {});
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(f.mock.calls.length, 0);
	const start = p.agreement.indexOf("{\n");
	const boundaries = ["\nProvider agreement", "\nExisting changes:"].map(marker => p.agreement.indexOf(marker, start)).filter(index => index >= 0);
	const pinned = JSON.parse(p.agreement.slice(start, Math.min(...boundaries)));
	for (const [key, value] of Object.entries(f.specification)) assert.deepEqual(pinned[key], value, `Pinned ${key} changed`);
	assert.equal(pinned.model.provider, f.mock.model.provider);
	assert.equal(pinned.model.modelId, f.mock.model.id);
	for (const value of ["criteria", "scope", "limits", "codingTools", "instructions", "provider", "owner1", "turn1", "execution1", resume ? "resume" : "paused"]) assert.ok(p.agreement.includes(value), `Agreement omitted ${value}`);
	assert.ok(p.confirmationPrompt.includes(resume ? "I confirm recovery and resume:" : "I confirm recovery:"));
	assert.ok(f.packets.some(text => text.includes(p.agreement)));
	assert.equal((await f.consume(p)).isError, true);
	await f.input(`${resume ? "I confirm recovery and resume" : "I confirm recovery"}: ${evidence}`);
	const result = await f.consume(p);
	assert.equal(result.isError, undefined, result.details.error);
	assert.equal(result.details.status, resume ? "running" : "paused");
	assert.deepEqual(result.details.recovery.completed, ["lease", "restore", "reconciliation", ...(resume ? ["continuation"] : [])]);
	assert.equal(result.details.recovery.settled, true);
	assert.equal(result.details.recovery.resumed, resume);
	assert.equal(result.details.cycle, f.state.cycle);
	const recovered = readJournal(f.layout).reduce(reduceEvent, null);
	assert.deepEqual(recovered.limits, f.state.limits);
	assert.ok(recovered.elapsedMs >= f.state.elapsedMs);
	assert.equal(recovered.workspace.receipts[0].outcome, "unknown");
	assert.equal(recovered.sessions.history[0].outcome, "interrupted");
	assert.equal(recovered.settlementAttestations.length, 1);
	assert.equal(recovered.settlementAttestations[0].evidence, evidence);
	if (resume) { await until(() => f.mock.calls.length === 1); assert.equal(f.mock.calls[0].model.id, f.mock.model.id); }
	else assert.equal(f.mock.calls.length, 0);
	assert.equal((await f.consume(p)).isError, true);
});

for (const text of ["start", "yes", "I confirm settlement: independently verified stopped", "I confirm recovery:   ", "I confirm recovery: independently verified stopped"]) test(`resume cannot be approved by ${JSON.stringify(text)}`, async t => {
	const f = await fixture(t), before = readJournal(f.layout), p = await f.propose({ resume: true });
	await f.input(text);
	assert.equal((await f.consume(p)).isError, true);
	await f.input(`I confirm recovery and resume: ${evidence}`);
	assert.equal((await f.consume(p)).isError, true);
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(f.mock.calls.length, 0);
});

for (const text of ["start", "yes", `I confirm settlement: ${evidence}`]) test(`paused recovery rejects ${JSON.stringify(text)}`, async t => {
	const f = await fixture(t), before = readJournal(f.layout), p = await f.propose();
	await f.input(text);
	assert.equal((await f.consume(p)).isError, true);
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(f.mock.calls.length, 0);
});

for (const source of ["extension", "rpc", "worker"]) test(`${source} cannot approve recovery`, async t => {
	const f = await fixture(t), before = readJournal(f.layout), p = await f.propose();
	await f.input(`I confirm recovery: ${evidence}`, source);
	assert.equal((await f.consume(p)).isError, true);
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(f.mock.calls.length, 0);
});

for (const extra of [{ evidence }, { resume: true }, { runId: "run1" }, { attestation: { kind: "user-established-settlement", evidence } }]) test(`consumption rejects tool-supplied fields ${JSON.stringify(extra)}`, async t => {
	const f = await fixture(t), before = readJournal(f.layout), p = await f.propose();
	await f.input(`I confirm recovery: ${evidence}`);
	assert.equal((await f.tool({ action: "recover", proposalId: p.proposalId, ...extra })).isError, true);
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(f.mock.calls.length, 0);
});

for (const change of ["lease", "journal", "workspace"]) test(`exact recovery proposal refuses changed ${change} before consuming state`, async t => {
	const f = await fixture(t), p = await f.propose({ resume: true });
	await f.input(`I confirm recovery and resume: ${evidence}`);
	const leasePath = join(f.layout.ownerPath, "owner.json");
	if (change === "lease") atomicJson(leasePath, { ...JSON.parse(readFileSync(leasePath, "utf8")), token: "fixture-replacement" });
	if (change === "journal") f.append("owner", "run.redirect", { text: "Changed fixture guidance" });
	if (change === "workspace") writeFileSync(join(f.root, "existing-work.txt"), "Preserve this outside change\n");
	const expected = readJournal(f.layout), lease = readFileSync(leasePath, "utf8");
	assert.equal((await f.consume(p)).isError, true);
	assert.deepEqual(readJournal(f.layout), expected);
	assert.equal(readFileSync(leasePath, "utf8"), lease);
	assert.equal((await f.consume(p)).isError, true);
	assert.equal(f.mock.calls.length, 0);
});

for (const cancellation of ["stop", "abort", "ui_prompt_start"]) test(`${cancellation} clears recovery consent`, async t => {
	const f = await fixture(t), p = await f.propose(), before = readJournal(f.layout);
	await f.input(`I confirm recovery: ${evidence}`);
	if (cancellation === "stop") await f.commands.get("swarm").handler("stop", f.ctx);
	else if (cancellation === "abort") await f.tool({ action: "recover", proposalId: p.proposalId }, AbortSignal.abort());
	else await f.event("ui_prompt_start", { kind: "confirm" });
	assert.equal((await f.consume(p)).isError, true);
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(f.mock.calls.length, 0);
});

for (const context of [{ mode: "rpc" }, { hasUI: false }]) test(`noninteractive context ${JSON.stringify(context)} cannot propose recovery`, async t => {
	const f = await fixture(t), before = readJournal(f.layout);
	Object.assign(f.ctx, context);
	const result = await f.tool({ action: "recover", runId: "run1", resume: true });
	assert.equal(result.isError, true);
	assert.equal(result.details.awaitingConfirmation, undefined);
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(f.mock.calls.length, 0);
});

test("only the original owner can recover a stale lease", async t => {
	const f = await fixture(t, { ownerSessionId: "other-owner" }), before = readJournal(f.layout);
	const leasePath = join(f.layout.ownerPath, "owner.json"), lease = readFileSync(leasePath, "utf8");
	const result = await f.tool({ action: "recover", runId: "run1" });
	assert.equal(result.isError, true);
	assert.equal(result.details.awaitingConfirmation, undefined);
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(readFileSync(leasePath, "utf8"), lease);
	assert.equal(f.mock.calls.length, 0);
});

for (const args of [{ action: "recover" }, { action: "recover", runId: [] }, { action: "recover", runId: "run1", resume: "yes" }, { action: "recover", runId: "run1", resume: null }, { action: "resume", resume: true }]) test(`invalid recovery arguments ${JSON.stringify(args)} never dispatch`, async t => {
	const f = await fixture(t), before = readJournal(f.layout);
	assert.equal((await f.tool(args)).isError, true);
	assert.deepEqual(readJournal(f.layout), before);
	assert.equal(f.mock.calls.length, 0);
});

test("attached run ID is inferred for paused recovery", async t => {
	const f = await fixture(t, { stale: false });
	assert.equal((await f.tool({ action: "restore", runId: "run1" })).isError, undefined);
	const proposed = await f.tool({ action: "recover" });
	assert.equal(proposed.details.awaitingConfirmation, true, proposed.details.error);
	await f.input(`I confirm recovery: ${evidence}`);
	const result = await f.consume(proposed.details);
	assert.equal(result.isError, undefined, result.details.error);
	assert.equal(result.details.status, "paused");
	assert.equal(f.mock.calls.length, 0);
});

test("failure after durable settlement reports partial stage without dispatch", async t => {
	const f = await fixture(t), p = await f.propose({ resume: true });
	await f.input(`I confirm recovery and resume: ${evidence}`);
	const owner = SwarmController.prototype.owner;
	t.mock.method(SwarmController.prototype, "owner", async function(type, ...args) {
		if (type === "host.continue") throw new Error("Private fixture continuation failure");
		return owner.call(this, type, ...args);
	});
	const result = await f.consume(p);
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "paused");
	assert.equal(result.details.recovery.stage, "continuation");
	assert.deepEqual(result.details.recovery.completed, ["lease", "restore", "reconciliation"]);
	assert.equal(result.details.recovery.settled, true);
	assert.equal(result.details.recovery.resumed, false);
	assert.equal(result.details.unsettled.operations, 0);
	assert.equal(result.details.unsettled.turns, 0);
	assert.equal(f.mock.calls.length, 0);
	assert.ok(!result.content[0].text.includes("Private fixture continuation failure"));
	assert.equal((await f.consume(p)).isError, true);
});
