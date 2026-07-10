/**
 * Phase-7 full-system e2e for pi-subagents-v2: the WHOLE story in one run,
 * driven through the extension entry (index.ts) with a stubbed ExtensionAPI
 * and a scripted mock LLM provider — the same surfaces a real Pi session
 * exercises (tools, commands, host events), no real network.
 *
 *  (unit) store/settings.ts: defaults, global←project merge, programmatic
 *         overrides, lenient validation warnings, null-clears-ceiling.
 *  (unit) vitalsBaseline/combineVitals cross-wake math.
 *  (unit) gcEscalationRecords + gcSweep retention semantics.
 *  (story) in ONE extension lifetime:
 *    1. session_start GC honors retention (pre-seeded old/recent archive,
 *       .done mail, resolved escalation records).
 *    2. Spawn a team of 3 — 2 persistent + 1 oneshot via the task param.
 *    3. Peer question round-trip (non-blocking, digest quotes the question).
 *    4. Oneshot final report → auto-retire + archive; teams scrubbed.
 *    5. subagent_collect with schema → validated digest note on drain.
 *    6. Out-of-scope write → escalation envelope to main → main DENIES BY
 *       MAIL with a note → the blocked tool errors and the agent reacts.
 *    7. Settings live-reload: project subagents.json edit applies at the
 *       next user turn; tiny pool → budget pause (mail queues, no turns);
 *       `/subagents resume` refills and drains.
 *    8. Cumulative vitals: tokens grow across a dormant→wake cycle, and
 *       survive a host restart + session-file rotation (registry baseline).
 *    9. End-state consistency: registry ⋈ teams ⋈ disk with no orphans.
 *
 * Run: node phase7-full-story.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";

const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readRegistry, emptyVitals } = await jiti.import(join(EXT, "store/registry.ts"));
const { readTeams } = await jiti.import(join(EXT, "store/teams.ts"));
const settingsMod = await jiti.import(join(EXT, "store/settings.ts"));
const archiveMod = await jiti.import(join(EXT, "store/archive.ts"));
const { vitalsBaseline, combineVitals } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const indexModule = await jiti.import(join(EXT, "index.ts"));
const extensionFactory = indexModule.default ?? indexModule;

// ---------------------------------------------------------------------------
// Temp world
// ---------------------------------------------------------------------------
const scratch = join(WORLDS, "phase7-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
mkdirSync(join(project, "allowed"), { recursive: true });

const TYPES = {
	builder: [
		"---",
		"name: builder",
		"description: Builds things, writes only inside allowed/",
		"model: mock/mock-1",
		"projectContext: false",
		'writePaths: ["allowed/**"]',
		"---",
		"You are the builder.",
	],
	helper: [
		"---",
		"name: helper",
		"description: Answers teammate questions",
		"model: mock/mock-1",
		"projectContext: false",
		"---",
		"You are the helper.",
	],
	runner: [
		"---",
		"name: runner",
		"description: Disposable one-task runner",
		"model: mock/mock-1",
		"projectContext: false",
		"---",
		"You are the runner.",
	],
};
for (const [name, lines] of Object.entries(TYPES)) {
	writeFileSync(join(project, ".pi", "subagents", `${name}.md`), `${lines.join("\n")}\n`);
}

// Phase 7 settings files: global defaults + project override (autoWake off =
// fully-manual queueing so the story controls every main-mail drain itself).
const globalSettingsFile = join(home, ".pi", "agent", "subagents.json");
const projectSettingsFile = join(project, ".pi", "subagents.json");
writeFileSync(globalSettingsFile, `${JSON.stringify({ autoWake: false, autonomousTurns: 40, archiveGcDays: 7 })}\n`);
writeFileSync(projectSettingsFile, `${JSON.stringify({ autonomousTurns: 30 })}\n`);

// ---------------------------------------------------------------------------
// Scripted mock LLM provider (same pattern as phases 2–6)
// ---------------------------------------------------------------------------
const llmCalls = [];
let callSeq = 0;
const scripts = []; // FIFO: { match(call), reply(call) } — reply {text}|{tools}

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
	const call = {
		agent: agentOf(context.systemPrompt),
		messages: context.messages,
		lastUserText: lastUserText(context.messages),
		lastRole: context.messages[context.messages.length - 1]?.role,
		lastJson: JSON.stringify(context.messages[context.messages.length - 1]?.content ?? ""),
	};
	llmCalls.push(call);
	let spec = { text: `MOCK_DEFAULT_${llmCalls.length}` };
	for (let i = 0; i < scripts.length; i++) {
		if (scripts[i].match(call)) {
			spec = scripts.splice(i, 1)[0].reply(call);
			break;
		}
	}
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
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

const layout = createLayout(project, { home });

// ---------------------------------------------------------------------------
// (unit) settings loader
// ---------------------------------------------------------------------------
console.log("settings (unit):");
await test("defaults when no files exist", async () => {
	const empty = createLayout(join(scratch, "nowhere"), { home: join(scratch, "nohome") });
	const { settings, warnings } = settingsMod.loadSettings(empty);
	assert.deepEqual(settings, {
		autoWake: true, maxConcurrent: 5, maxHops: 8,
		autonomousTurns: 40, autonomousTokens: 500000, archiveGcDays: 7,
	});
	assert.deepEqual(warnings, []);
});
await test("global ← project merge; project wins field-by-field", async () => {
	const { settings, warnings } = settingsMod.loadSettings(layout);
	assert.equal(settings.autoWake, false, "from the global file");
	assert.equal(settings.autonomousTurns, 30, "project override wins");
	assert.equal(settings.maxConcurrent, 5, "untouched fields keep defaults");
	assert.deepEqual(warnings, []);
});
await test("lenient validation: unknown keys / bad types warn, never throw; null clears a ceiling", async () => {
	const dir = join(scratch, "settings-unit");
	mkdirSync(join(dir, "home"), { recursive: true });
	mkdirSync(join(dir, "proj", ".pi"), { recursive: true });
	const l = { globalSettingsFile: join(dir, "home", "subagents.json"), projectSettingsFile: join(dir, "proj", ".pi", "subagents.json") };
	writeFileSync(l.globalSettingsFile, JSON.stringify({ maxTokensTotal: 100, banana: 1, maxHops: "eight", autoWake: null }));
	writeFileSync(l.projectSettingsFile, JSON.stringify({ maxTokensTotal: null, autonomousTurns: 0.5 }));
	const { settings, warnings } = settingsMod.loadSettings(l);
	assert.equal(settings.maxTokensTotal, undefined, "project null cleared the global ceiling");
	assert.equal(settings.maxHops, 8, "mistyped value ignored");
	assert.equal(settings.autoWake, true, "null on a required field ignored");
	assert.equal(settings.autonomousTurns, 40, "non-integer turn budget ignored");
	assert.ok(warnings.some((w) => w.includes('unknown setting "banana"')));
	assert.ok(warnings.some((w) => w.includes('"maxHops" must be a positive integer')));
	assert.ok(warnings.some((w) => w.includes('"autoWake" cannot be null')));
	// invalid JSON warns instead of throwing
	writeFileSync(l.projectSettingsFile, "{nope");
	const bad = settingsMod.readSettingsFile(l.projectSettingsFile);
	assert.deepEqual(bad.values, {});
	assert.ok(bad.warnings[0].includes("invalid JSON"));
});
await test("applySettingsInto: live in-place reload, programmatic overrides keep winning", async () => {
	const target = settingsMod.defaultSettings();
	target.maxTokensTotal = 111; // pretend an earlier load set it
	const warnings = settingsMod.applySettingsInto(target, layout, { maxConcurrent: 2 });
	assert.deepEqual(warnings, []);
	assert.equal(target.autoWake, false);
	assert.equal(target.autonomousTurns, 30);
	assert.equal(target.maxConcurrent, 2, "programmatic override survives reload");
	assert.equal(target.maxTokensTotal, undefined, "stale optional dropped when files do not set it");
});

// ---------------------------------------------------------------------------
// (unit) cross-wake vitals math
// ---------------------------------------------------------------------------
console.log("vitals (unit):");
await test("baseline is zero when the resumed session already explains the totals", async () => {
	const persisted = { contextPercent: 40, tokens: 500, cost: 0.5, turns: 6, compactions: 1 };
	const liveAtOpen = { contextPercent: 40, tokens: 500, cost: 0.5, turns: 6, compactions: 1 };
	assert.deepEqual(vitalsBaseline(persisted, liveAtOpen), emptyVitals());
});
await test("fresh session file carries the previous totals forward", async () => {
	const persisted = { contextPercent: 40, tokens: 500, cost: 0.5, turns: 6, compactions: 1 };
	const base = vitalsBaseline(persisted, emptyVitals());
	assert.deepEqual(base, { contextPercent: 0, tokens: 500, cost: 0.5, turns: 6, compactions: 1 });
	const live = { contextPercent: 10, tokens: 30, cost: 0.002, turns: 2, compactions: 0 };
	assert.deepEqual(combineVitals(base, live), { contextPercent: 10, tokens: 530, cost: 0.502, turns: 8, compactions: 1 });
});

// ---------------------------------------------------------------------------
// (unit) GC retention
// ---------------------------------------------------------------------------
console.log("gc (unit):");
const DAY = 24 * 3600 * 1000;
await test("gcEscalationRecords: old resolved deleted; pending and recent kept", async () => {
	const dir = join(scratch, "gc-unit", "escalations");
	mkdirSync(dir, { recursive: true });
	const rec = (id, status, resolvedAt) =>
		writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, status, resolvedAt, createdAt: resolvedAt ?? new Date().toISOString() }));
	rec("esc_old_denied", "denied", new Date(Date.now() - 8 * DAY).toISOString());
	rec("esc_old_pending", "pending", null);
	utimesSync(join(dir, "esc_old_pending.json"), new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
	rec("esc_new_approved", "approved", new Date().toISOString());
	const deleted = archiveMod.gcEscalationRecords(dir, { days: 7 });
	assert.deepEqual(deleted, [join(dir, "esc_old_denied.json")]);
	assert.ok(existsSync(join(dir, "esc_old_pending.json")), "pending records are never GC'd");
	assert.ok(existsSync(join(dir, "esc_new_approved.json")));
});

// ---------------------------------------------------------------------------
// (story) — through the extension entry with a stubbed ExtensionAPI
// ---------------------------------------------------------------------------
console.log("(story) full system:");

// Seed retention-GC fixtures BEFORE session_start.
const OLD = new Date(Date.now() - 8 * DAY);
mkdirSync(join(layout.archiveRoot, "ghost", "old"), { recursive: true });
writeFileSync(join(layout.archiveRoot, "ghost", "old", ".retired-at"), `${OLD.toISOString()}\n`);
mkdirSync(join(layout.archiveRoot, "ghost", "recent"), { recursive: true });
writeFileSync(join(layout.archiveRoot, "ghost", "recent", ".retired-at"), `${new Date().toISOString()}\n`);
mkdirSync(layout.mainMailboxDoneDir, { recursive: true });
writeFileSync(join(layout.mainMailboxDoneDir, "msg_00000000000000000000000000.json"), "{}\n");
utimesSync(join(layout.mainMailboxDoneDir, "msg_00000000000000000000000000.json"), OLD, OLD);
writeFileSync(join(layout.mainMailboxDoneDir, "msg_00000000000000000000000001.json"), "{}\n");
mkdirSync(layout.escalationsDir, { recursive: true });
writeFileSync(
	layout.escalationFile("esc_seed_old"),
	JSON.stringify({ id: "esc_seed_old", status: "denied", resolvedAt: OLD.toISOString(), createdAt: OLD.toISOString() }),
);

// The stubbed host.
const handlers = {};
const tools = new Map();
const commands = new Map();
const sentMessages = [];
const notifications = [];
// Models AgentSession's streaming flag and records the delivery MODE the real
// SDK would pick (agent-session.js sendCustomMessage): while isStreaming a
// sendMessage STEERS into the running turn; only isStreaming=false +
// triggerTurn starts a genuinely new turn.
const stubPi = {
	isStreaming: false,
	on: (event, handler) => (handlers[event] ??= []).push(handler),
	registerTool: (tool) => tools.set(tool.name, tool),
	registerCommand: (name, def) => commands.set(name, def),
	registerShortcut: () => {},
	sendMessage: (message, options) => {
		const mode =
			options?.deliverAs === "nextTurn" ? "nextTurn"
			: stubPi.isStreaming ? (options?.deliverAs === "followUp" ? "followUp" : "steer")
			: options?.triggerTurn ? "newTurn"
			: "append";
		sentMessages.push({ message, options, mode });
	},
};
extensionFactory(stubPi);

const ctx = {
	cwd: project,
	modelRegistry,
	model: modelRegistry.find("mock", "mock-1"),
	hasUI: false,
	ui: { notify: (text, level) => notifications.push({ text, level }) },
};
const fire = async (event) => {
	for (const h of handlers[event] ?? []) await h({}, ctx);
};
/** One host agent run with the REAL SDK's event ordering: agent_end fires
 * while isStreaming is still true (_isAgentRunActive is cleared only in
 * _emitAgentSettled, AFTER agent_end); agent_settled fires once settled. */
const fireHostTurn = async (messages = []) => {
	stubPi.isStreaming = true;
	for (const h of handlers.agent_start ?? []) await h({ type: "agent_start" }, ctx);
	for (const h of handlers.agent_end ?? []) await h({ type: "agent_end", messages }, ctx);
	stubPi.isStreaming = false;
	for (const h of handlers.agent_settled ?? []) await h({ type: "agent_settled" }, ctx);
};
/** Drain the main mailbox the way a real user turn does; returns digest or null. */
const drainMainViaUserTurn = async () => {
	for (const h of handlers.before_agent_start ?? []) {
		const out = await h({}, ctx);
		if (out?.message) return out.message.content;
	}
	return null;
};
const callTool = async (name, params) => {
	const result = await tools.get(name).execute(`t${++callSeq}`, params, undefined, undefined, ctx);
	return JSON.parse(result.content[0].text);
};
const stateOf = (address) => readRegistry(layout.registryFile).agents[address]?.state;

const prevHome = process.env.HOME;
process.env.HOME = home; // index.ts derives the layout home from os.homedir()

await test("1. session_start GC honors retention (archive + .done + resolved escalations)", async () => {
	await fire("session_start");
	await waitUntil(() => !existsSync(join(layout.archiveRoot, "ghost", "old")), "old archive swept");
	assert.ok(existsSync(join(layout.archiveRoot, "ghost", "recent")), "recent archive kept");
	assert.ok(!existsSync(join(layout.mainMailboxDoneDir, "msg_00000000000000000000000000.json")), "old .done mail swept");
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, "msg_00000000000000000000000001.json")), "recent .done mail kept");
	assert.ok(!existsSync(layout.escalationFile("esc_seed_old")), "old resolved escalation record swept");
});

const PEER_Q = "Which artifact name should I use? PEER_Q_MARKER";
let runnerAddress;

await test("2+3. team of 3 (2 persistent + oneshot task) with a peer Q&A round-trip", async () => {
	// builder asks helper, non-blocking; helper answers with the correlationId.
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastUserText.includes("TEAM_TASK"),
		reply: () => ({ tools: [{ name: "send_message", args: { to: "helper/main", text: PEER_Q, expectReply: true } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastRole === "toolResult" && c.lastJson.includes("disposition"),
		reply: () => ({ text: "CHECKPOINT: paused waiting for helper; next: build with the name." }),
	});
	scripts.push({
		match: (c) => c.agent === "helper/main" && c.lastUserText.includes("PEER_Q_MARKER"),
		reply: (c) => {
			const cid = /correlationId "(msg_[0-9A-Z]{26})"/.exec(c.lastUserText)?.[1];
			return { tools: [{ name: "send_message", args: { to: "builder/main", text: "Use artifact-x. PEER_A_MARKER", correlationId: cid } }] };
		},
	});
	scripts.push({
		match: (c) => c.agent === "helper/main" && c.lastRole === "toolResult",
		reply: () => ({ text: "answered." }),
	});
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastUserText.includes("PEER_A_MARKER"),
		reply: () => ({ text: "GOT_PEER_ANSWER" }),
	});
	// the oneshot: final report retires it (D13).
	scripts.push({
		match: (c) => c.agent?.startsWith("runner/tmp-") && c.lastUserText.includes("RUNNER_GO"),
		reply: () => ({ tools: [{ name: "report", args: { text: "RUNNER_FINAL_RESULT", final: true, data: { ok: true } } }] }),
	});
	scripts.push({
		match: (c) => c.agent?.startsWith("runner/tmp-") && c.lastRole === "toolResult",
		reply: () => ({ text: "signing off." }),
	});

	const helper = await callTool("subagent_spawn", { type: "helper", id: "main", team: "ship" });
	assert.equal(helper.created, true);
	const builder = await callTool("subagent_spawn", {
		type: "builder", id: "main", team: "ship",
		task: "TEAM_TASK: build the artifact; ask helper/main for its name first",
	});
	assert.equal(builder.address, "builder/main");
	const runner = await callTool("subagent_spawn", {
		type: "runner", lifetime: "oneshot", team: "ship", task: "RUNNER_GO: run the one thing and report",
	});
	runnerAddress = runner.address;
	assert.match(runnerAddress, /^runner\/tmp-/);
	assert.equal(readTeams(layout.teamsFile).ship.length, 3, "all three joined the team");

	// Peer round trip lands: builder woken with its question quoted (D14).
	await waitUntil(() => llmCalls.some((c) => c.agent === "builder/main" && c.lastUserText.includes("PEER_A_MARKER")), "builder answer wake");
	const wake = llmCalls.find((c) => c.agent === "builder/main" && c.lastUserText.includes("PEER_A_MARKER"));
	assert.match(wake.lastUserText, /## Answers to your questions/);
	assert.match(wake.lastUserText, /> Which artifact name should I use\? PEER_Q_MARKER/);
	assert.match(wake.lastUserText, /`helper\/main` answered/);
});

await test("4. oneshot auto-retires after its final report; envelope survives; teams scrubbed", async () => {
	await waitUntil(() => readRegistry(layout.registryFile).agents[runnerAddress] === undefined, "oneshot funeral");
	const [type, id] = runnerAddress.split("/");
	assert.ok(existsSync(layout.archiveDir(type, id)), "archived for post-mortem");
	assert.ok(!existsSync(layout.agentInstanceDir(type, id)), "live dir moved");
	assert.ok(!(readTeams(layout.teamsFile).ship ?? []).includes(runnerAddress), "scrubbed from the team");
	const report = mailbox.readPending(layout.mainMailboxDir).find((p) => p.envelope.from === runnerAddress);
	assert.ok(report, "final report still pending in main's mailbox");
	assert.equal(report.envelope.payload.text, "RUNNER_FINAL_RESULT");
});

await test("5. collect with schema → report validated on drain (digest note)", async () => {
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastUserText.includes("Collect request"),
		reply: (c) => {
			const id = /message from `main` \((msg_[0-9A-Z]{26})\)/.exec(c.lastUserText)?.[1];
			return { tools: [{ name: "report", args: { text: "collect result ready", data: { status: "ok", files: 2 }, correlationId: id } }] };
		},
	});
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastRole === "toolResult" && c.lastJson.includes("reported"),
		reply: () => ({ text: "collect sent." }),
	});
	const res = await callTool("subagent_collect", {
		to: "builder/main",
		schema: { type: "object", required: ["status", "files"], properties: { status: { type: "string" }, files: { type: "integer" } } },
	});
	// M5: the tool surfaces the full CollectResult (requestId for correlating
	// multiple outstanding collects; recipientState for dormant-vs-running).
	assert.deepEqual(Object.keys(res).sort(), ["recipientState", "requestId", "requested"], "spec-exact collect result");
	assert.equal(res.requested, true);
	assert.match(res.requestId, /^msg_/);
	assert.ok(["dormant", "queued", "running", "waiting"].includes(res.recipientState));
	await waitUntil(
		() => mailbox.readPending(layout.mainMailboxDir).some((p) => p.envelope.type === "report" && p.envelope.correlationId !== null),
		"collect report in main mailbox",
	);
	const digest = await drainMainViaUserTurn();
	assert.ok(digest, "user turn drained the quiet queue (autoWake:false)");
	assert.match(digest, /RUNNER_FINAL_RESULT/, "oneshot final report rode the same digest");
	assert.match(digest, /\[collect result — conforms to the requested schema\]/);
});

let escalationEnvelopeId;
await test("6. out-of-scope write → escalation → main denies BY MAIL with a note → agent reacts", async () => {
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastUserText.includes("WRITE_OUT"),
		reply: () => ({ tools: [{ name: "write", args: { path: "forbidden/nope.txt", content: "should never land\n" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastRole === "toolResult" && c.lastJson.includes("DENY_NOTE"),
		reply: () => ({ text: "DENY_ACK: adjusting to allowed/." }),
	});
	await callTool("subagent_send", { to: "builder/main", text: "WRITE_OUT: write the file outside your scope" });
	await waitUntil(
		() => mailbox.readPending(layout.mainMailboxDir).some((p) => p.envelope.type === "escalation"),
		"escalation envelope queued for main",
	);
	await waitUntil(() => stateOf("builder/main") === "waiting", "agent parked waiting");
	const esc = mailbox.readPending(layout.mainMailboxDir).find((p) => p.envelope.type === "escalation");
	escalationEnvelopeId = esc.envelope.id;
	assert.match(esc.envelope.payload.text, /only the human can/i);

	// Main's ONE escalation power: a correlated send = deny, text = the note.
	await callTool("subagent_send", {
		to: "builder/main", correlationId: escalationEnvelopeId,
		text: "Denied — keep outputs inside allowed/. DENY_NOTE",
	});
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "builder/main" && c.lastJson.includes("DENY_NOTE")),
		"deny note reached the blocked tool as an error",
	);
	assert.ok(!existsSync(join(project, "forbidden", "nope.txt")), "denied write never happened");
	await waitUntil(() => stateOf("builder/main") === "dormant", "builder resumed and went dormant");
	const records = readdirSync(layout.escalationsDir).filter((f) => f.endsWith(".json"));
	const denied = records
		.map((f) => JSON.parse(readFileSync(join(layout.escalationsDir, f), "utf8")))
		.find((r) => r.status === "denied" && r.envelopeId === escalationEnvelopeId);
	assert.ok(denied, "escalation record persisted as denied");
	assert.match(denied.note, /DENY_NOTE/);
	await drainMainViaUserTurn(); // clear the escalation envelope from the queue
});

let tokensBeforePause;
await test("7. settings live-reload → budget pause (queue, no turns) → /subagents resume drains", async () => {
	const detail = await callTool("subagent_status", { address: "builder/main" });
	tokensBeforePause = detail.vitals.tokens;
	assert.ok(tokensBeforePause > 0, "builder consumed tokens so far");

	// Shrink the pool to one turn via the PROJECT settings file; a real user
	// turn (before_agent_start) reloads it live and resets the pool.
	writeFileSync(projectSettingsFile, `${JSON.stringify({ autonomousTurns: 1 })}\n`);
	await drainMainViaUserTurn();

	scripts.push({
		match: (c) => c.agent === "helper/main" && c.lastUserText.includes("PAUSE_PING"),
		reply: () => ({ text: "helper turn ran; the pool is now spent." }),
	});
	await callTool("subagent_send", { to: "helper/main", text: "PAUSE_PING: one quick thing" });
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "helper/main" && c.lastUserText.includes("PAUSE_PING")),
		"helper's tripping turn",
	);
	await waitUntil(() => stateOf("helper/main") === "dormant", "helper dormant");

	// Paused: new mail queues on disk, NO turn starts (pause never kills).
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastUserText.includes("QUEUED_WHILE_PAUSED"),
		reply: () => ({ text: "resumed and processed the queued mail." }),
	});
	const before = llmCalls.length;
	await callTool("subagent_send", { to: "builder/main", text: "QUEUED_WHILE_PAUSED: do this next" });
	await sleep(400);
	assert.equal(llmCalls.length, before, "no turn started while paused");
	assert.equal(mailbox.pendingCount(layout.mailboxDir("builder", "main")), 1, "mail parked on disk");

	// The Phase-7 affordance: /subagents resume refills the pool and drains.
	await commands.get("subagents").handler("resume", ctx);
	assert.ok(
		notifications.some((n) => n.text.includes("refilled")),
		"resume acknowledged via notify",
	);
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "builder/main" && c.lastUserText.includes("QUEUED_WHILE_PAUSED")),
		"queued mail drained after resume",
	);
	await waitUntil(() => mailbox.pendingCount(layout.mailboxDir("builder", "main")) === 0, "builder mailbox drained");

	// resume when not paused says so (restore a roomy pool first).
	writeFileSync(projectSettingsFile, `${JSON.stringify({ autonomousTurns: 30 })}\n`);
	await drainMainViaUserTurn();
	notifications.length = 0;
	await commands.get("subagents").handler("resume", ctx);
	assert.ok(notifications.some((n) => n.text.includes("not paused")));
});

await test("7b. auto-wake starts a REAL turn (agent_settled semantics) and its agent_end usage charges the pool", async () => {
	// Flip autoWake on (project overrides the global false) and set a token cap
	// the auto-woken turn's REAL usage payload will hit exactly.
	writeFileSync(
		projectSettingsFile,
		`${JSON.stringify({ autonomousTurns: 30, autoWake: true, autonomousTokens: 1_000_000 })}\n`,
	);
	await drainMainViaUserTurn(); // live reload + pool reset

	// builder asks main → main is idle → D16 auto-wake.
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastUserText.includes("ASK_MAIN_BUDGET"),
		reply: () => ({ tools: [{ name: "ask", args: { text: "Main, may I spend more? WAKE_CHARGE_MARKER" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastRole === "toolResult",
		reply: () => ({ text: "waiting on main for budget." }),
	});
	const beforeWake = sentMessages.length;
	await callTool("subagent_send", { to: "builder/main", text: "ASK_MAIN_BUDGET: ask the human-side agent" });
	await waitUntil(() => sentMessages.length > beforeWake, "auto-wake for the builder question");
	const wake = sentMessages[sentMessages.length - 1];
	assert.equal(wake.options.triggerTurn, true, "wake requests a turn");
	assert.equal(wake.mode, "newTurn", "issued while NOT streaming — a real new turn, never a steer");
	assert.match(wake.message.content, /WAKE_CHARGE_MARKER/, "digest embedded in the trigger message");
	assert.equal(mailbox.pendingCount(layout.mainMailboxDir), 0, "main mail drained at trigger time");
	// Let the builder's asking turn finish before counting LLM calls below.
	await waitUntil(() => stateOf("builder/main") === "dormant", "builder dormant after asking");

	// The auto-woken main turn ends with a REALISTIC pi-ai usage payload
	// (input/output/cacheRead/cacheWrite) summing to exactly the 1M cap → the
	// D21 charge must trip the pause. Decoy usage on a non-assistant message
	// pins the role check (counting it would just pause too — but dropping any
	// of the four fields lands under the cap and the paused assertions fail).
	const usage = {
		input: 550_000, output: 150_000, cacheRead: 200_000, cacheWrite: 100_000,
		totalTokens: 1_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 },
	};
	await fireHostTurn([
		{ role: "user", content: [{ type: "text", text: "decoy" }], usage: { ...usage, input: 9_999_999 }, timestamp: Date.now() },
		{
			role: "assistant", api: "mock-api", provider: "mock", model: "mock-1",
			content: [{ type: "text", text: "answered the builder" }],
			usage, stopReason: "stop", timestamp: Date.now(),
		},
	]);

	// Paused (tokens tripped): new subagent work queues on disk, no turn starts.
	scripts.push({
		match: (c) => c.agent === "helper/main" && c.lastUserText.includes("PAUSED_PING2"),
		reply: () => ({ text: "processed after the charge-pause resumed." }),
	});
	const callsBefore = llmCalls.length;
	await callTool("subagent_send", { to: "helper/main", text: "PAUSED_PING2: are we paused?" });
	await sleep(400);
	assert.equal(llmCalls.length, callsBefore, "agent_end charge tripped the pool — no turn while paused");
	assert.equal(mailbox.pendingCount(layout.mailboxDir("helper", "main")), 1, "mail parked on disk");

	// Restore the story's settings; the user-turn reset resumes and drains.
	writeFileSync(projectSettingsFile, `${JSON.stringify({ autonomousTurns: 30 })}\n`);
	await drainMainViaUserTurn();
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "helper/main" && c.lastUserText.includes("PAUSED_PING2")),
		"queued mail drained after the reset",
	);
	await waitUntil(() => stateOf("helper/main") === "dormant", "helper dormant again");
	assert.equal(mailbox.pendingCount(layout.mailboxDir("helper", "main")), 0, "helper mailbox drained");
});

await test("8. cumulative vitals: grow across wakes AND survive restart + session-file rotation", async () => {
	await waitUntil(() => stateOf("builder/main") === "dormant", "builder settled");
	const detail = await callTool("subagent_status", { address: "builder/main" });
	const tokensAfterResume = detail.vitals.tokens;
	assert.ok(
		tokensAfterResume > tokensBeforePause,
		`tokens grew across the dormant→wake cycle (${tokensBeforePause} → ${tokensAfterResume})`,
	);

	// Host restart: dispose everything, then ROTATE the session file away —
	// the registry baseline must keep the whole-life totals (Phase 7).
	await fire("session_shutdown");
	const instanceDir = layout.agentInstanceDir("builder", "main");
	for (const f of readdirSync(instanceDir).filter((n) => n.endsWith(".jsonl"))) unlinkSync(join(instanceDir, f));
	await fire("session_start");

	scripts.push({
		match: (c) => c.agent === "builder/main" && c.lastUserText.includes("AFTER_RESTART_PING"),
		reply: () => ({ text: "fresh session file, same identity." }),
	});
	await callTool("subagent_send", { to: "builder/main", text: "AFTER_RESTART_PING: hello again" });
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "builder/main" && c.lastUserText.includes("AFTER_RESTART_PING")),
		"post-restart wake",
	);
	await waitUntil(() => stateOf("builder/main") === "dormant", "post-restart turn finished");
	const after = await callTool("subagent_status", { address: "builder/main" });
	assert.ok(
		after.vitals.tokens >= tokensAfterResume + 15,
		`registry baseline carried totals across the rotation (${tokensAfterResume} → ${after.vitals.tokens})`,
	);
});

await test("9. end state consistent: registry ⋈ teams ⋈ disk, no orphans", async () => {
	await drainMainViaUserTurn(); // clear any remaining quiet reports
	const registry = readRegistry(layout.registryFile);
	const addresses = Object.keys(registry.agents).sort();
	assert.deepEqual(addresses, ["builder/main", "helper/main"], "only the two persistent agents remain");
	for (const [address, record] of Object.entries(registry.agents)) {
		assert.equal(record.state, "dormant", `${address} parked dormant`);
		assert.ok(existsSync(layout.agentInstanceDir(record.type, record.id)), `${address} dir exists`);
		assert.equal(mailbox.pendingCount(layout.mailboxDir(record.type, record.id)), 0, `${address} mailbox drained`);
		assert.ok(record.vitals.tokens > 0, `${address} whole-life vitals persisted`);
	}
	const teams = readTeams(layout.teamsFile);
	for (const [team, members] of Object.entries(teams)) {
		for (const member of members) assert.ok(registry.agents[member], `team ${team} member ${member} exists`);
	}
	assert.deepEqual(teams.ship.sort(), ["builder/main", "helper/main"]);
	assert.equal(mailbox.pendingCount(layout.mainMailboxDir), 0, "main mailbox drained");
	// the oneshot is only in the archive
	const [rType, rId] = runnerAddress.split("/");
	assert.ok(existsSync(layout.archiveDir(rType, rId)));
	// no agent dirs without registry entries (D3: the directory is the truth)
	const RESERVED = new Set([".archive", ".main", "registry.json", "teams.json"]);
	for (const entry of readdirSync(layout.subagentsRoot)) {
		if (RESERVED.has(entry)) continue;
		for (const id of readdirSync(join(layout.subagentsRoot, entry))) {
			assert.ok(registry.agents[`${entry}/${id}`], `orphan dir ${entry}/${id}`);
		}
	}
	await fire("session_shutdown");
});

process.env.HOME = prevHome;
console.log(`\nall ${passed} phase-7 e2e tests passed`);
