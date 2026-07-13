import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { EXT, WORLDS, jiti } from "./env.mjs";

const { createCore, reconcileMainMailFor } = await jiti.import(join(EXT, "core.ts"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { addTo, updateTeams } = await jiti.import(join(EXT, "store/teams.ts"));
const { emptyVitals, updateRegistry, upsertAgent } = await jiti.import(join(EXT, "store/registry.ts"));
const { SessionScopeLockedError } = await jiti.import(join(EXT, "store/session-scope.ts"));

const scratch = join(WORLDS, "phase-session-scope-await");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
const project = join(scratch, "project");
mkdirSync(project, { recursive: true });

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}
function seedAgent(layout, id, state = "dormant") {
	updateRegistry(layout.registryFile, (registry) =>
		upsertAgent(registry, {
			type: "worker",
			id,
			lifetime: "persistent",
			purview: id,
			typeFileHash: "test",
			state,
		}),
	);
	mkdirSync(layout.filesDir("worker", id), { recursive: true });
}

console.log("session scope:");
const layoutA = createLayout(project, { home, sessionId: "session-a" });
const layoutB = createLayout(project, { home, sessionId: "session-b" });
const coreA = createCore({ cwd: project, home, sessionId: "session-a" });
const coreB = createCore({ cwd: project, home, sessionId: "session-b" });

await test("two main sessions in one cwd have disjoint mutable roots", async () => {
	assert.notEqual(layoutA.subagentsRoot, layoutB.subagentsRoot);
	assert.equal(layoutA.projectTypeDefsDir, layoutB.projectTypeDefsDir);
	seedAgent(layoutA, "same-id");
	assert.deepEqual((await coreA.status()).map((row) => row.address), ["worker/same-id"]);
	assert.deepEqual(await coreB.status(), []);
	assert.ok(existsSync(layoutA.scopeManifestFile));
	assert.ok(existsSync(layoutB.scopeManifestFile));
});

await test("a second live host cannot own the same main-session scope", async () => {
	const owner = JSON.parse(readFileSync(layoutA.hostOwnerFile, "utf8"));
	writeFileSync(
		layoutA.hostOwnerFile,
		`${JSON.stringify({ ...owner, heartbeatAt: new Date(0).toISOString() })}\n`,
	);
	assert.throws(
		() => createCore({ cwd: project, home, sessionId: "session-a" }),
		(error) => error instanceof SessionScopeLockedError,
		"a stale heartbeat alone never steals from the same live process identity",
	);
});

await test("process-start token permits PID-reuse recovery without stealing a paused live owner", async () => {
	const staleLayout = createLayout(project, { home, sessionId: "stale-host-session" });
	mkdirSync(staleLayout.subagentsRoot, { recursive: true });
	writeFileSync(
		staleLayout.hostOwnerFile,
		`${JSON.stringify({
			pid: process.pid,
			runtimeId: "dead-runtime-with-reused-pid",
			sessionId: staleLayout.ownerSessionId,
			processStartToken: "definitely-not-the-current-process-start",
			claimedAt: new Date(Date.now() - 700_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 700_000).toISOString(),
		})}\n`,
	);
	const recovered = createCore({ cwd: project, home, sessionId: "stale-host-session" });
	await recovered.dispose();
});

await test("two processes racing a stale host/claim marker elect exactly one owner", async () => {
	const raceLayout = createLayout(project, { home, sessionId: "stale-race-session" });
	mkdirSync(raceLayout.subagentsRoot, { recursive: true });
	writeFileSync(
		raceLayout.hostOwnerFile,
		`${JSON.stringify({ pid: 99999999, runtimeId: "dead", claimedAt: new Date(0).toISOString() })}\n`,
	);
	writeFileSync(
		join(raceLayout.subagentsRoot, ".host-owner-claim.lock"),
		`${JSON.stringify({ pid: 99999999, createdAt: new Date(0).toISOString() })}\n`,
	);
	const contender = join(scratch, "host-contender.mjs");
	writeFileSync(
		contender,
		`import { join } from "node:path";\n` +
			`import { EXT, jiti } from ${JSON.stringify(join(EXT, "..", "..", "test", "e2e", "env.mjs"))};\n` +
			`const { createCore } = await jiti.import(join(EXT, "core.ts"));\n` +
			`try { const core = createCore(${JSON.stringify({ cwd: project, home, sessionId: "stale-race-session" })}); ` +
			`await new Promise(r => setTimeout(r, 500)); await core.dispose(); console.log("WON"); } ` +
			`catch { console.log("LOST"); }\n`,
	);
	const run = () =>
		new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [contender], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("error", reject);
			child.on("close", (code) =>
				code === 0 ? resolve(stdout.trim()) : reject(new Error(`contender failed: ${stderr}`)),
			);
		});
	const outcomes = await Promise.all([run(), run()]);
	assert.deepEqual(outcomes.sort(), ["LOST", "WON"]);
});

await test("failed scope validation releases the host lease", async () => {
	const brokenLayout = createLayout(project, { home, sessionId: "broken-session" });
	mkdirSync(join(brokenLayout.scopeManifestFile, ".."), { recursive: true });
	writeFileSync(
		brokenLayout.scopeManifestFile,
		`${JSON.stringify({
			version: 2,
			cwd: project,
			ownerSessionId: "broken-session",
			persisted: false,
			createdAt: new Date().toISOString(),
		})}\n`,
	);
	assert.throws(() => createCore({ cwd: project, home, sessionId: "broken-session" }), /metadata does not match/);
	rmSync(brokenLayout.scopeManifestFile, { force: true });
	const recovered = createCore({ cwd: project, home, sessionId: "broken-session" });
	await recovered.dispose();
});

await test("autonomy and roster survive dispose/resume in the same scope", async () => {
	coreA.autonomy.noteTurnStart();
	coreA.autonomy.noteTokens(77);
	await coreA.dispose();
	const resumed = createCore({ cwd: project, home, sessionId: "session-a" });
	assert.equal((await resumed.status())[0].address, "worker/same-id");
	assert.equal(resumed.autonomy.status().turnsUsed, 1);
	assert.equal(resumed.autonomy.status().tokensUsed, 77);
	await resumed.dispose();
});
await coreB.dispose();

console.log("await:");
const core = createCore({ cwd: project, home, sessionId: "await-session" });
const layout = core.layout;
seedAgent(layout, "review");

await test("a task arriving mid-turn cannot steal the current task's report correlation", async () => {
	const taskA = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "task A" });
	const taskB = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "task B" });
	core.runtime._recordAssignmentAnchor("worker/review", taskB.id);
	core.runtime._handles.set("worker/review", { trigger: [taskA] });
	const outcome = await core.runtime._mailPort.sendFromAgent({
		from: "worker/review",
		to: "main",
		type: "report",
		text: "A result",
		final: true,
	});
	core.runtime._handles.delete("worker/review");
	assert.equal(outcome.disposition, "main");
	const report = mailbox
		.readPending(layout.mainMailboxDir)
		.find(({ envelope }) => envelope.payload.text === "A result").envelope;
	assert.equal(report.correlationId, taskA.id);
	assert.equal(readFileSync(layout.assignmentAnchorFile("worker", "review"), "utf8").trim(), taskB.id);
	mailbox.markDone(layout.mainMailboxDir, [report.id]);
});

await test("final await excludes stale reports and consumes the anchored result", async () => {
	const stale = makeEnvelope({ from: "worker/review", to: "main", type: "report", text: "old", final: true });
	mailbox.writeEnvelope(layout.mainMailboxDir, stale);
	const anchor = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "review this" });
	const unrelatedAnchor = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "other task" });
	const unrelatedFinal = makeEnvelope({
		from: "worker/review",
		to: "main",
		type: "report",
		text: "other task result",
		final: true,
		correlationId: unrelatedAnchor.id,
	});
	const final = makeEnvelope({
		from: "worker/review",
		to: "main",
		type: "report",
		text: "verdict: clean",
		final: true,
		correlationId: anchor.id,
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, unrelatedFinal);
	mailbox.writeEnvelope(layout.mainMailboxDir, final);
	const result = await core.awaitResult({
		to: "worker/review",
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile: null,
	});
	assert.equal(result.status, "completed");
	assert.equal(result.report.id, final.id);
	assert.equal(result.report.final, true);
	const leftPending = mailbox.readPending(layout.mainMailboxDir).map((pending) => pending.envelope.id);
	assert.ok(leftPending.includes(stale.id));
	assert.ok(leftPending.includes(unrelatedFinal.id), "another task's final is not consumed as progress");
});

await test("question returns attention early and can be answered before awaiting again", async () => {
	const anchor = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "second review" });
	const question = makeEnvelope({ from: "worker/review", to: "main", type: "question", text: "Which baseline?" });
	mailbox.writeEnvelope(layout.mainMailboxDir, question);
	const result = await core.awaitResult({
		to: "worker/review",
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile: null,
	});
	assert.equal(result.status, "attention");
	assert.equal(result.attention.type, "question");
	assert.equal(result.attention.id, question.id);
});

await test("collect await validates the correlated structured result", async () => {
	const request = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "collect" });
	const schema = {
		type: "object",
		properties: { verdict: { type: "string" } },
		required: ["verdict"],
		additionalProperties: false,
	};
	mailbox.recordCollectRequest(layout.mainMailboxDir, request.id, schema, "worker/review");
	const report = makeEnvelope({
		from: "worker/review",
		to: "main",
		type: "report",
		text: "structured",
		data: { verdict: "pass" },
		correlationId: request.id,
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, report);
	const result = await core.awaitResult({
		to: "worker/review",
		waitFor: "collect",
		anchorId: request.id,
		timeoutSeconds: 2,
		sessionFile: null,
	});
	assert.equal(result.status, "completed");
	assert.deepEqual(result.validation, { valid: true, errors: [] });
});

await test("await tool-result parking reconciles only after the host JSONL append", async () => {
	const sessionFile = join(layout.projectSessionDir, "await-host.jsonl");
	mkdirSync(layout.projectSessionDir, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	const anchor = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "durable" });
	const report = makeEnvelope({
		from: "worker/review",
		to: "main",
		type: "report",
		text: "durable result",
		final: true,
		correlationId: anchor.id,
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, report);
	const result = await core.awaitResult({
		to: "worker/review",
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile,
	});
	assert.equal(result.status, "completed");
	assert.ok(existsSync(join(layout.mainMailboxDeliveringDir, `${report.id}.json`)));
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ role: "toolResult", toolName: "subagent_await", content: JSON.stringify(result) })}\n`,
		{ flag: "a" },
	);
	const reconciled = reconcileMainMailFor(project, { home, sessionId: "await-session" });
	assert.deepEqual(reconciled.finalized, [report.id]);
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, `${report.id}.json`)));
});

await test("timeout and cancellation consume no result mail", async () => {
	const anchor = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "slow" });
	const timedOut = await core.awaitResult({
		to: "worker/review",
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 1,
		sessionFile: null,
	});
	assert.equal(timedOut.status, "timeout");
	const controller = new AbortController();
	const wait = core.awaitResult({
		to: "worker/review",
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 10,
		sessionFile: null,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(wait, /cancelled/);
});

await test("retirement cancels owner mail quietly but still bounces peer questions", async () => {
	seedAgent(layout, "doomed");
	seedAgent(layout, "asker", "waiting");
	updateTeams(layout.teamsFile, (teams) => {
		addTo(teams, "reviewers", "worker/doomed");
		addTo(teams, "reviewers", "worker/asker");
	});
	const mainTask = makeEnvelope({ from: "main", to: "worker/doomed", type: "message", text: "now obsolete" });
	const peerQuestion = makeEnvelope({
		from: "worker/asker",
		to: "worker/doomed",
		type: "question",
		text: "did it finish?",
		team: "reviewers",
	});
	mailbox.writeEnvelope(layout.mailboxDir("worker", "doomed"), mainTask);
	mailbox.writeEnvelope(layout.mailboxDir("worker", "doomed"), peerQuestion);
	const escalationWait = core.runtime._escalations
		.request(
			{
				agent: "worker/doomed",
				tool: "write",
				inputSummary: "outside.txt",
				reason: "outside scope",
			},
			undefined,
		)
		.catch(() => undefined);
	const escalationEnvelopeId = core.escalations.pending()[0].envelopeId;
	const retired = await core.retire("worker/doomed");
	await escalationWait;
	assert.ok(retired.archiveDir);
	const archivedDone = join(retired.archiveDir, "mailbox", ".done", `${mainTask.id}.json`);
	assert.ok(existsSync(archivedDone), "owner task retained as a quiet cancellation audit");
	const mainErrors = mailbox
		.readPending(layout.mainMailboxDir)
		.filter(({ envelope }) => envelope.type === "error" && envelope.correlationId === mainTask.id);
	assert.equal(mainErrors.length, 0, "no bounce spam back to the retiring owner");
	assert.ok(
		!mailbox.readPending(layout.mainMailboxDir).some(({ envelope }) => envelope.id === escalationEnvelopeId),
		"cancelled escalation mail cannot prompt after retirement",
	);
	const askerMail = mailbox.readPending(layout.mailboxDir("worker", "asker")).map(({ envelope }) => envelope);
	assert.ok(askerMail.some((envelope) => envelope.type === "error" && envelope.correlationId === peerQuestion.id));
});

await core.dispose();

await test("crash-recovered retirement does not duplicate an already-written peer bounce", async () => {
	const crashLayout = createLayout(project, { home, sessionId: "retire-crash-session" });
	seedAgent(crashLayout, "doomed");
	seedAgent(crashLayout, "asker", "waiting");
	updateTeams(crashLayout.teamsFile, (teams) => {
		addTo(teams, "crash-team", "worker/doomed");
		addTo(teams, "crash-team", "worker/asker");
	});
	const question = makeEnvelope({
		from: "worker/asker",
		to: "worker/doomed",
		type: "question",
		text: "already bounced?",
		team: "crash-team",
	});
	const existingBounce = makeEnvelope({
		from: "worker/doomed",
		to: "worker/asker",
		type: "error",
		text: "not processed",
		correlationId: question.id,
	});
	mailbox.writeEnvelope(crashLayout.mailboxDir("worker", "doomed"), question);
	mailbox.writeEnvelope(crashLayout.mailboxDir("worker", "asker"), existingBounce);
	writeFileSync(crashLayout.retireRequestedFile("worker", "doomed"), "retire started\n");
	const recovered = createCore({ cwd: project, home, sessionId: "retire-crash-session" });
	const errors = mailbox
		.readPending(crashLayout.mailboxDir("worker", "asker"))
		.map(({ envelope }) => envelope)
		.filter((envelope) => envelope.type === "error" && envelope.correlationId === question.id);
	assert.equal(errors.length, 1);
	assert.ok(existsSync(join(crashLayout.archiveDir("worker", "doomed"), "mailbox", ".done", `${question.id}.json`)));
	await recovered.dispose();
});

await test("pre-route oneshot intent without report evidence is cleared after a crash", async () => {
	const crashLayout = createLayout(project, { home, sessionId: "oneshot-presend-crash" });
	updateRegistry(crashLayout.registryFile, (registry) =>
		upsertAgent(registry, {
			type: "worker",
			id: "tmp-presend",
			lifetime: "oneshot",
			purview: "tmp-presend",
			typeFileHash: "test",
			state: "dormant",
		}),
	);
	mkdirSync(crashLayout.filesDir("worker", "tmp-presend"), { recursive: true });
	writeFileSync(
		crashLayout.retireRequestedFile("worker", "tmp-presend"),
		`${JSON.stringify({ kind: "oneshot-auto", requestedAt: new Date().toISOString() })}\n`,
	);
	const recovered = createCore({ cwd: project, home, sessionId: "oneshot-presend-crash" });
	assert.equal((await recovered.status())[0].address, "worker/tmp-presend");
	assert.ok(!existsSync(crashLayout.retireRequestedFile("worker", "tmp-presend")));
	await recovered.dispose();
});

await test("durable oneshot retirement intent completes its funeral after restart", async () => {
	const crashLayout = createLayout(project, { home, sessionId: "oneshot-crash-session" });
	updateRegistry(crashLayout.registryFile, (registry) =>
		upsertAgent(registry, {
			type: "worker",
			id: "tmp-crash",
			lifetime: "oneshot",
			purview: "tmp-crash",
			typeFileHash: "test",
			state: "dormant",
		}),
	);
	mkdirSync(crashLayout.filesDir("worker", "tmp-crash"), { recursive: true });
	const finalEvidence = makeEnvelope({
		from: "worker/tmp-crash",
		to: "main",
		type: "report",
		text: "final report delivered",
		final: true,
	});
	mailbox.writeEnvelope(crashLayout.mainMailboxDir, finalEvidence);
	writeFileSync(
		crashLayout.retireRequestedFile("worker", "tmp-crash"),
		`${JSON.stringify({ kind: "oneshot-auto", requestedAt: new Date().toISOString() })}\n`,
	);
	const recovered = createCore({ cwd: project, home, sessionId: "oneshot-crash-session" });
	assert.deepEqual(await recovered.status(), []);
	assert.ok(existsSync(crashLayout.archiveDir("worker", "tmp-crash")));
	await recovered.dispose();
});

await test("ephemeral hosts reject persistent agents", async () => {
	const stateContainerRoot = join(scratch, "ephemeral-state");
	const ephemeral = createCore({
		cwd: project,
		home,
		sessionId: "ephemeral-session",
		persisted: false,
		stateContainerRoot,
	});
	await assert.rejects(ephemeral.spawn({ type: "worker" }), /require a persisted main Pi session/);
	await ephemeral.dispose();
});

console.log(`\nall ${passed} session-scope/await tests passed`);
