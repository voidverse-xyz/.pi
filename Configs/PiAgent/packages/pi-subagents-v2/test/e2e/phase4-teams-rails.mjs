/**
 * Phase-4 teams + rails smoke test for pi-subagents-v2.
 *
 * Same harness as phase 2/3 (jiti-alias + scripted mock provider driving REAL
 * AgentSession turns). Covers:
 *
 *  (unit) rails/hops.ts pure: cap verdicts, D21 bounce text, report-to-main
 *         escape; rails/autonomy.ts: turn/token pools, pause events, reset;
 *         store/teams.ts roster views + diff lines; makeTeamGuard verdicts.
 *  (a) teams (D12): same-team A→B delivers with envelope.team stamped;
 *      out-of-team C→A bounces an error back to C (A never sees it);
 *      teamless agent's peer send bounces. main traffic bypasses.
 *  (b) hops (D21): forced ping-pong (each question answered with a new
 *      question) dies when the chain reaches maxHops=8 — the sender gets the
 *      "report to the main agent instead" bounce — and its report to main at
 *      hops > 8 still passes (the escape route).
 *  (c) autonomy (D21): tiny turn budget (3) → system pauses (no new turns,
 *      mail queues on disk, paused status + queued count exposed via core);
 *      user-input reset resumes and drains. Token-cap variant.
 *  (d) roster-change digest lines: teammate join + retire show up in the
 *      next wake digest.
 *  (e) rail events on the runtime bus: bounce, autonomy-paused,
 *      autonomy-resumed.
 *
 * Run: node smoke-phase4.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";



const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readRegistry } = await jiti.import(join(EXT, "store/registry.ts"));
const teamsMod = await jiti.import(join(EXT, "store/teams.ts"));
const { InProcessRuntime } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const { makeTeamGuard } = await jiti.import(join(EXT, "mail/deliver.ts"));
const hops = await jiti.import(join(EXT, "rails/hops.ts"));
const autonomyMod = await jiti.import(join(EXT, "rails/autonomy.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));

// ---------------------------------------------------------------------------
// Temp world
// ---------------------------------------------------------------------------
const scratch = join(WORLDS, "phase4-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

const WORKER_MD = [
	"---",
	"name: worker",
	"description: General worker for rails tests",
	"model: mock/mock-1",
	"projectContext: false",
	"---",
	"You are a worker.",
	"",
].join("\n");

function makeProject(name) {
	const project = join(scratch, name);
	mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
	writeFileSync(join(project, ".pi", "subagents", "worker.md"), WORKER_MD);
	return project;
}

// ---------------------------------------------------------------------------
// Scripted mock LLM provider (text replies AND tool calls)
// ---------------------------------------------------------------------------
const llmCalls = [];
let callSeq = 0;
const scripts = []; // FIFO by array order: { match(call), reply(call) }

function agentOf(systemPrompt) {
	const m = /address `([^`]+)`/.exec(systemPrompt ?? "");
	return m ? m[1] : "?";
}
function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") {
			return typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("\n");
		}
	}
	return "";
}

function mockStream(model, context) {
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		const call = {
			agent: agentOf(context.systemPrompt),
			systemPrompt: context.systemPrompt ?? "",
			messages: context.messages,
			lastUserText: lastUserText(context.messages),
			lastRole: context.messages[context.messages.length - 1]?.role,
		};
		llmCalls.push(call);
		let spec = { text: `MOCK_DEFAULT_${llmCalls.length}` };
		for (let i = 0; i < scripts.length; i++) {
			if (scripts[i].match(call)) {
				spec = scripts.splice(i, 1)[0].reply(call);
				break;
			}
		}
		const usage = {
			input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		};
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		if (spec.tools) {
			const content = spec.tools.map((t) => ({ type: "toolCall", id: `call_${++callSeq}`, name: t.name, arguments: t.args }));
			const output = { ...base, content, stopReason: "toolUse" };
			stream.push({ type: "start", partial: output });
			content.forEach((tc, i) => {
				stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: output });
			});
			stream.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const output = { ...base, content: [{ type: "text", text: spec.text }], stopReason: "stop" };
			stream.push({ type: "start", partial: output });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: spec.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: spec.text, partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
		}
		stream.end();
	})();
	return stream;
}

const authStorage = piSdk.AuthStorage.create(join(home, ".pi", "agent", "auth.json"));
const modelRegistry = piSdk.ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider("mock", {
	baseUrl: "http://mock.invalid",
	apiKey: "test-key",
	api: "mock-api",
	streamSimple: mockStream,
	models: [
		{
			id: "mock-1", name: "Mock One", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000, maxTokens: 4096,
		},
	],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, label, timeoutMs = 20000) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
		await sleep(15);
	}
}

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// (unit) rails/hops.ts
// ---------------------------------------------------------------------------
console.log("hops (pure):");
await test("under the cap allowed; at the cap bounced with the D21 text", async () => {
	const q = (h) => ({ hops: h, from: "worker/a", to: "worker/b", type: "question" });
	assert.deepEqual(hops.checkHops(q(0), 8), { allowed: true });
	assert.deepEqual(hops.checkHops(q(7), 8), { allowed: true });
	const denied = hops.checkHops(q(8), 8);
	assert.equal(denied.allowed, false);
	assert.match(denied.reason, /gone 8 rounds without resolving/);
	assert.match(denied.reason, /report to the main agent instead/);
	assert.equal(hops.checkHops(q(30), 8).allowed, false);
	assert.equal(hops.DEFAULT_MAX_HOPS, 8);
});
await test("report/escalation/error to main escape the cap at ANY depth; question to main does not", async () => {
	for (const type of ["report", "escalation", "error"]) {
		assert.deepEqual(hops.checkHops({ hops: 99, from: "worker/a", to: "main", type }, 8), { allowed: true });
	}
	assert.equal(hops.checkHops({ hops: 8, from: "worker/a", to: "main", type: "question" }, 8).allowed, false);
	// escape is main-only: a peer report is still capped
	assert.equal(hops.checkHops({ hops: 8, from: "worker/a", to: "worker/b", type: "report" }, 8).allowed, false);
	const guard = hops.makeHopsGuard(2);
	assert.equal(guard({ hops: 2, from: "worker/a", to: "worker/b", type: "message" }).allowed, false);
});

// ---------------------------------------------------------------------------
// (unit) rails/autonomy.ts
// ---------------------------------------------------------------------------
console.log("autonomy (pure):");
await test("turn pool: pauses at the cap, running-turn consumption never re-fires, reset refills", async () => {
	const budget = new autonomyMod.AutonomyBudget({ autonomousTurns: 3, autonomousTokens: 1e12 });
	const fired = [];
	budget.subscribe((event, status) => fired.push({ event, status }));
	assert.equal(budget.canStart(), true);
	budget.noteTurnStart();
	budget.noteTurnStart();
	assert.equal(budget.paused, false);
	budget.noteTurnStart(); // 3rd consumption reaches the cap
	assert.equal(budget.paused, true);
	assert.equal(budget.canStart(), false);
	assert.deepEqual(fired.map((f) => f.event), ["paused"]);
	assert.equal(fired[0].status.trippedBy, "turns");
	budget.noteTurnStart(); // an already-running turn finishing pipeline — no re-fire
	budget.noteTokens(500);
	assert.deepEqual(fired.map((f) => f.event), ["paused"]);
	budget.reset();
	assert.equal(budget.paused, false);
	assert.deepEqual(fired.map((f) => f.event), ["paused", "resumed"]);
	const status = budget.status();
	assert.deepEqual(
		{ paused: status.paused, trippedBy: status.trippedBy, turnsUsed: status.turnsUsed, tokensUsed: status.tokensUsed },
		{ paused: false, trippedBy: null, turnsUsed: 0, tokensUsed: 0 },
	);
});
await test("token pool: trips on cumulative deltas; junk deltas ignored; resume() refills; limits read live", async () => {
	const limits = { autonomousTurns: 1e9, autonomousTokens: 100 };
	const budget = new autonomyMod.AutonomyBudget(limits);
	const fired = [];
	budget.subscribe((event) => fired.push(event));
	budget.noteTokens(60);
	budget.noteTokens(-5);
	budget.noteTokens(Number.NaN);
	assert.equal(budget.paused, false);
	budget.noteTokens(40);
	assert.equal(budget.paused, true);
	assert.equal(budget.status().trippedBy, "tokens");
	budget.resume();
	assert.deepEqual(fired, ["paused", "resumed"]);
	limits.autonomousTokens = 1000; // live settings edit
	budget.noteTokens(500);
	assert.equal(budget.paused, false);
	assert.equal(budget.status().tokensBudget, 1000);
});

// ---------------------------------------------------------------------------
// (unit) team guard + roster diff
// ---------------------------------------------------------------------------
console.log("team guard + roster (pure):");
await test("makeTeamGuard: shared team stamps; none bounces", async () => {
	const teams = { duo: ["worker/a", "worker/b"], other: ["worker/c"] };
	const guard = makeTeamGuard(() => teams);
	const env = (from, to) => makeEnvelope({ from, to, type: "message", text: "x", team: null });
	assert.deepEqual(guard(env("worker/a", "worker/b")), { allowed: true, team: "duo" });
	const denied = guard(env("worker/c", "worker/a"));
	assert.equal(denied.allowed, false);
	assert.match(denied.reason, /share no team/);
	assert.match(denied.reason, /main agent/i);
	assert.equal(guard(env("worker/d", "worker/a")).allowed, false, "teamless sender is solo");
});
await test("rosterViewOf + diffRosterViews produce deterministic change lines", async () => {
	const before = teamsMod.rosterViewOf({ duo: ["worker/a", "worker/b"] }, "worker/a");
	assert.deepEqual(before, { duo: ["worker/b"] });
	const after = teamsMod.rosterViewOf(
		{ duo: ["worker/a", "worker/b", "worker/e"], crew: ["worker/a"] },
		"worker/a",
	);
	const lines = teamsMod.diffRosterViews(before, after);
	assert.deepEqual(lines, [
		"You joined team `crew` (no other members yet)",
		"`worker/e` joined your team `duo`",
	]);
	const gone = teamsMod.diffRosterViews(after, before);
	assert.deepEqual(gone, [
		"You left team `crew` (removed or disbanded) — its members are no longer reachable",
		"`worker/e` left your team `duo` (moved or retired)",
	]);
	assert.deepEqual(teamsMod.diffRosterViews(before, before), []);
});

// ---------------------------------------------------------------------------
// World A: teams + hops + roster lines (no autonomy — unlimited)
// ---------------------------------------------------------------------------
const projectA = makeProject("project-a");
const layoutA = createLayout(projectA, { home });
const settingsManager = piSdk.SettingsManager.create(projectA, join(home, ".pi", "agent"));
const mainMailA = [];
const runtimeA = new InProcessRuntime({
	layout: layoutA, modelRegistry, settingsManager, maxConcurrent: 3,
	onMainMail: (envelope) => mainMailA.push(envelope),
});
const eventsA = [];
runtimeA.onEvent((e) => eventsA.push(e));
function turnsFinished(address) {
	return eventsA.filter((e) => e.type === "turn-finished" && e.address === address).length;
}

console.log("(a) team enforcement (D12):");
await test("same-team peer send delivers with envelope.team stamped", async () => {
	await runtimeA.spawn({ type: "worker", id: "alpha", team: "duo" });
	await runtimeA.spawn({ type: "worker", id: "beta", team: "duo" });
	await runtimeA.spawn({ type: "worker", id: "gamma", team: "other" });
	await runtimeA.spawn({ type: "worker", id: "delta" }); // teamless solo

	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("SEND_BETA"),
		reply: () => ({ tools: [{ name: "send_message", args: { to: "worker/beta", text: "hello TEAM_OK_MARKER" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastRole === "toolResult",
		reply: () => ({ text: "sent." }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/beta" && c.lastUserText.includes("TEAM_OK_MARKER"),
		reply: () => ({ text: "received." }),
	});

	await runtimeA.send({ to: "worker/alpha", text: "SEND_BETA: greet your teammate" });
	await waitUntil(() => turnsFinished("worker/beta") >= 1, "beta receives");
	const call = llmCalls.find((c) => c.agent === "worker/beta" && c.lastUserText.includes("TEAM_OK_MARKER"));
	assert.ok(call, "beta woke with the teammate's message");

	// The envelope on disk carries the authorizing team (D12 stamp).
	const doneDir = join(layoutA.mailboxDir("worker", "beta"), ".done");
	const envelopes = readdirSync(doneDir).map((f) => JSON.parse(readFileSync(join(doneDir, f), "utf8")));
	const delivered = envelopes.find((e) => e.payload.text.includes("TEAM_OK_MARKER"));
	assert.ok(delivered, "delivered envelope archived in .done");
	assert.equal(delivered.team, "duo", "envelope.team stamped with the authorizing team");
	assert.equal(delivered.from, "worker/alpha");
	// main→sub traffic bypassed the guard: team stays null
	const fromMain = envelopes.find((e) => e.from === "main");
	assert.equal(fromMain ?? null, null, "no main mail to beta in this scenario");
});

await test("out-of-team peer send bounces an error back to the sender; recipient never sees it", async () => {
	scripts.push({
		match: (c) => c.agent === "worker/gamma" && c.lastUserText.includes("PROBE_ALPHA"),
		reply: () => ({ tools: [{ name: "send_message", args: { to: "worker/alpha", text: "psst XTEAM_PROBE" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/gamma" && c.lastRole === "toolResult",
		reply: (c) => ({ text: `TOOLRES:${JSON.stringify(c.messages[c.messages.length - 1].content)}` }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/gamma" && c.lastUserText.includes("Delivery failure"),
		reply: () => ({ text: "BOUNCE_ACK_GAMMA" }),
	});

	await runtimeA.send({ to: "worker/gamma", text: "PROBE_ALPHA: try to message worker/alpha" });
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "worker/gamma" && c.lastUserText.includes("Delivery failure")),
		"gamma bounce digest",
	);
	// the tool itself reported the failure...
	const toolErr = llmCalls.find(
		(c) => c.agent === "worker/gamma" && c.lastRole === "toolResult" &&
			JSON.stringify(c.messages[c.messages.length - 1].content).includes("share no team"),
	);
	assert.ok(toolErr, "send tool surfaced the out-of-team rejection");
	// ...and the bounce error envelope arrived as mail
	const bounceCall = llmCalls.find((c) => c.agent === "worker/gamma" && c.lastUserText.includes("Delivery failure"));
	assert.match(bounceCall.lastUserText, /error from `worker\/alpha`/);
	assert.match(bounceCall.lastUserText, /share no team/);
	assert.match(bounceCall.lastUserText, /XTEAM_PROBE/);
	// alpha never received the probe
	assert.ok(!llmCalls.some((c) => c.agent === "worker/alpha" && c.lastUserText.includes("XTEAM_PROBE")));
	// rail event fired
	const bounceEvent = eventsA.find((e) => e.type === "bounce" && e.from === "worker/gamma");
	assert.ok(bounceEvent, "bounce runtime event emitted");
	assert.match(bounceEvent.reason, /share no team/);
});

await test("teamless agent is solo: its peer send bounces (reverse channel still open)", async () => {
	scripts.push({
		match: (c) => c.agent === "worker/delta" && c.lastUserText.includes("PROBE_ALPHA_D"),
		reply: () => ({ tools: [
			{ name: "send_message", args: { to: "worker/alpha", text: "hi TEAMLESS_PROBE" } },
			{ name: "report", args: { text: "SOLO_REPORT_OK" } },
		] }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/delta" && c.lastRole === "toolResult",
		reply: () => ({ text: "done." }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/delta" && c.lastUserText.includes("Delivery failure"),
		reply: () => ({ text: "BOUNCE_ACK_DELTA" }),
	});
	await runtimeA.send({ to: "worker/delta", text: "PROBE_ALPHA_D: message alpha, then report" });
	await waitUntil(() => mainMailA.some((e) => e.type === "report" && e.from === "worker/delta"), "solo report");
	assert.ok(!llmCalls.some((c) => c.agent === "worker/alpha" && c.lastUserText.includes("TEAMLESS_PROBE")));
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "worker/delta" && c.lastUserText.includes("Delivery failure")),
		"delta bounce digest",
	);
	// main traffic bypassed the guard: solo report delivered, team null
	const report = mainMailA.find((e) => e.type === "report" && e.from === "worker/delta");
	assert.equal(report.team, null);
});

// ---------------------------------------------------------------------------
// (b) hops rail: forced ping-pong
// ---------------------------------------------------------------------------
console.log("(b) hops rail (D21):");
await test("ping-pong dies at hop 8 with the report-to-main bounce; escalation report passes at hops > 8", async () => {
	mainMailA.length = 0;
	// each side answers any PING question with a NEW question (never resolves)
	for (let i = 0; i < 12; i++) {
		scripts.push({
			match: (c) =>
				(c.agent === "worker/alpha" || c.agent === "worker/beta") &&
				c.lastRole !== "toolResult" &&
				c.lastUserText.includes("PING_Q") &&
				!c.lastUserText.includes("Delivery failure"),
			reply: (c) => ({
				tools: [{
					name: "send_message",
					args: {
						to: c.agent === "worker/alpha" ? "worker/beta" : "worker/alpha",
						text: "but first, answer THIS: PING_Q",
						expectReply: true,
					},
				}],
			}),
		});
	}
	// the loser wakes with the hops bounce and escalates upward
	scripts.push({
		match: (c) => c.lastUserText.includes("report to the main agent instead"),
		reply: () => ({ tools: [{ name: "report", args: { text: "PINGPONG_ESCALATED: we went in circles" } }] }),
	});
	for (let i = 0; i < 16; i++) {
		scripts.push({
			match: (c) => (c.agent === "worker/alpha" || c.agent === "worker/beta") && c.lastRole === "toolResult",
			reply: () => ({ text: "checkpoint: waiting." }),
		});
	}

	const callsBefore = llmCalls.length;
	await runtimeA.send({ to: "worker/alpha", text: "kick off: PING_Q" });
	await waitUntil(
		() => mainMailA.some((e) => e.type === "report" && e.payload.text.includes("PINGPONG_ESCALATED")),
		"escalation report after hops bounce",
		30000,
	);

	// chain died exactly at the cap: hops 1..7 delivered, the hops-8 send bounced
	const bounce = eventsA.find((e) => e.type === "bounce" && /gone 8 rounds/.test(e.reason));
	assert.ok(bounce, "hops bounce event with the D21 text");
	assert.match(bounce.reason, /report to the main agent instead/);
	const pingDone = [];
	for (const who of ["alpha", "beta"]) {
		const doneDir = join(layoutA.mailboxDir("worker", who), ".done");
		for (const f of readdirSync(doneDir)) {
			const e = JSON.parse(readFileSync(join(doneDir, f), "utf8"));
			if (e.payload.text.includes("PING_Q") && e.type === "question") pingDone.push(e);
		}
	}
	const deliveredHops = pingDone.map((e) => e.hops).sort((a, b) => a - b);
	assert.deepEqual(deliveredHops, [1, 2, 3, 4, 5, 6, 7], "exactly hops 1..7 delivered, none past the cap");

	// the report that escaped upward is DEEPER than the cap — the escape route worked
	const report = mainMailA.find((e) => e.type === "report" && e.payload.text.includes("PINGPONG_ESCALATED"));
	assert.ok(report.hops > 8, `report hops ${report.hops} > 8 passed the guard`);
	assert.ok(llmCalls.length - callsBefore < 40, "ping-pong bounded, no runaway");
});

// ---------------------------------------------------------------------------
// (d) roster-change digest lines
// ---------------------------------------------------------------------------
console.log("(d) roster-change lines:");
await test("teammate join shows up in the next wake digest", async () => {
	await runtimeA.spawn({ type: "worker", id: "epsilon", team: "duo" });
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_1"),
		reply: () => ({ text: "noted the join." }),
	});
	await runtimeA.send({ to: "worker/alpha", text: "ROSTER_PING_1: carry on" });
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_1")),
		"roster digest 1",
	);
	const call = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_1"));
	assert.match(call.lastUserText, /## Roster changes/);
	assert.match(call.lastUserText, /`worker\/epsilon` joined your team `duo`/);
});
await test("teammate retire shows up as a leave line; no-change wakes carry no roster section", async () => {
	await runtimeA.retire("worker/epsilon");
	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_2"),
		reply: () => ({ text: "noted the leave." }),
	});
	await runtimeA.send({ to: "worker/alpha", text: "ROSTER_PING_2: carry on" });
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_2")),
		"roster digest 2",
	);
	const call = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_2"));
	assert.match(call.lastUserText, /`worker\/epsilon` left your team `duo` \(moved or retired\)/);

	scripts.push({
		match: (c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_3"),
		reply: () => ({ text: "steady state." }),
	});
	await runtimeA.send({ to: "worker/alpha", text: "ROSTER_PING_3: carry on" });
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_3")),
		"roster digest 3",
	);
	const steady = llmCalls.find((c) => c.agent === "worker/alpha" && c.lastUserText.includes("ROSTER_PING_3"));
	assert.doesNotMatch(steady.lastUserText, /## Roster changes/);
});

await runtimeA.dispose();

// ---------------------------------------------------------------------------
// (c) autonomy rail through core (settings consolidation + budget + drain)
// ---------------------------------------------------------------------------
console.log("(c) autonomy rail (D21):");
await test("tiny turn budget: 3 turns run, system pauses, mail queues, status + queued count exposed", async () => {
	const projectB = makeProject("project-b");
	const core = createCore({
		cwd: projectB, home, modelRegistry,
		settings: { autonomousTurns: 3, autonomousTokens: 1e12 },
	});
	// settings consolidation: doc defaults fill the rest
	assert.equal(core.settings.maxHops, 8);
	assert.equal(core.settings.maxConcurrent, 5);
	assert.equal(core.settings.autoWake, true);
	assert.equal(core.settings.autonomousTokens, 1e12);

	const events = [];
	core.runtime.onEvent((e) => events.push(e));
	const finished = () => events.filter((e) => e.type === "turn-finished" && e.address === "worker/solo").length;

	for (let i = 1; i <= 4; i++) {
		scripts.push({
			match: (c) => c.agent === "worker/solo" && c.lastUserText.includes(`BUDGET_MSG_${i}`),
			reply: () => ({ text: `handled ${i}.` }),
		});
	}
	await core.spawn({ type: "worker", id: "solo" });
	for (let i = 1; i <= 3; i++) {
		await core.send({ to: "worker/solo", text: `BUDGET_MSG_${i}` });
		await waitUntil(() => finished() >= i, `turn ${i}`);
	}
	// 3rd consumption tripped the pause, but turn 3 was never killed
	assert.ok(events.some((e) => e.type === "autonomy-paused"), "autonomy-paused event emitted");
	assert.equal(core.autonomy.paused, true);
	const status = core.autonomy.status();
	assert.deepEqual(
		{ trippedBy: status.trippedBy, turnsUsed: status.turnsUsed, turnsBudget: status.turnsBudget },
		{ trippedBy: "turns", turnsUsed: 3, turnsBudget: 3 },
	);
	assert.equal(finished(), 3, "the tripping turn ran to completion (pause never kills)");

	// 4th message: queues on disk, no new turn starts
	await core.send({ to: "worker/solo", text: "BUDGET_MSG_4" });
	await sleep(300);
	assert.equal(finished(), 3, "no autonomous turn starts while paused");
	assert.ok(!llmCalls.some((c) => c.lastUserText.includes("BUDGET_MSG_4")), "queued mail never hit the LLM");
	assert.equal(core.queuedMailCount(), 1, "queued count exposed for the banner");
	assert.equal(mailbox.pendingCount(core.layout.mailboxDir("worker", "solo")), 1);
	const record = readRegistry(core.layout.registryFile).agents["worker/solo"];
	assert.equal(record.state, "dormant", "agent parked dormant, memory intact");

	// user input (index.ts wires this to before_agent_start) resets + drains
	core.autonomy.reset();
	await waitUntil(() => finished() >= 4, "drained turn after reset");
	assert.ok(events.some((e) => e.type === "autonomy-resumed"), "autonomy-resumed event emitted");
	assert.ok(llmCalls.some((c) => c.lastUserText.includes("BUDGET_MSG_4")), "queued mail delivered after resume");
	assert.equal(core.queuedMailCount(), 0);
	assert.equal(core.autonomy.status().turnsUsed, 1, "drained turn consumed from the FRESH pool");
	await core.dispose();
});

await test("tiny token budget: first turn's token delta trips the pause; resume() drains", async () => {
	const projectC = makeProject("project-c");
	const core = createCore({
		cwd: projectC, home, modelRegistry,
		settings: { autonomousTurns: 1e9, autonomousTokens: 10 },
	});
	const events = [];
	core.runtime.onEvent((e) => events.push(e));
	const finished = () => events.filter((e) => e.type === "turn-finished").length;

	scripts.push({
		match: (c) => c.agent === "worker/tok" && c.lastUserText.includes("TOKEN_MSG_1"),
		reply: () => ({ text: "burned some tokens." }),
	});
	scripts.push({
		match: (c) => c.agent === "worker/tok" && c.lastUserText.includes("TOKEN_MSG_2"),
		reply: () => ({ text: "resumed." }),
	});
	await core.spawn({ type: "worker", id: "tok" });
	await core.send({ to: "worker/tok", text: "TOKEN_MSG_1" });
	await waitUntil(() => finished() >= 1, "token turn 1");
	await waitUntil(() => core.autonomy.paused, "token pause");
	const status = core.autonomy.status();
	assert.equal(status.trippedBy, "tokens");
	assert.ok(status.tokensUsed >= 10, `token delta charged (${status.tokensUsed})`);

	await core.send({ to: "worker/tok", text: "TOKEN_MSG_2" });
	await sleep(250);
	assert.equal(finished(), 1, "paused: second turn never starts");
	assert.equal(core.queuedMailCount(), 1);

	core.autonomy.resume(); // Phase 6 banner keypress
	await waitUntil(() => finished() >= 2, "token turn 2 after resume");
	assert.ok(llmCalls.some((c) => c.lastUserText.includes("TOKEN_MSG_2")));
	assert.ok(events.some((e) => e.type === "autonomy-paused" && e.status.trippedBy === "tokens"));
	assert.ok(events.some((e) => e.type === "autonomy-resumed"));
	await core.dispose();
});

// ---------------------------------------------------------------------------
// (e) rail events recap (collected along the way)
// ---------------------------------------------------------------------------
console.log("(e) rail events:");
await test("bounce / autonomy-paused / autonomy-resumed all rode the runtime event bus", async () => {
	assert.ok(eventsA.some((e) => e.type === "bounce" && /share no team/.test(e.reason)), "team bounce event");
	assert.ok(eventsA.some((e) => e.type === "bounce" && /gone 8 rounds/.test(e.reason)), "hops bounce event");
	// autonomy events asserted inside (c); shape-check one payload here
	const bounce = eventsA.find((e) => e.type === "bounce");
	assert.deepEqual(Object.keys(bounce).sort(), ["envelopeId", "from", "reason", "to", "type"]);
});

console.log(`\nall ${passed} phase-4 smoke tests passed`);
