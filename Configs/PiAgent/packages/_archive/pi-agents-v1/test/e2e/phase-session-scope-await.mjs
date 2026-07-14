import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { EXT, WORLDS, jiti } from "./env.mjs";

const { createCore, reconcileMainMailFor } = await jiti.import(join(EXT, "core.ts"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { addTo, updateTeams } = await jiti.import(join(EXT, "store/teams.ts"));
const { emptyVitals, getAgent, readRegistry, removeAgent, updateRegistry, upsertAgent } = await jiti.import(join(EXT, "store/registry.ts"));
const { adoptLegacyState, rollbackLegacyAdoption, SessionScopeLockedError } = await jiti.import(join(EXT, "store/session-scope.ts"));

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
	// A legacy crash after creating its append-only reclaim marker must no
	// longer brick this same stale owner generation.
	const oldReclaimDir = join(staleLayout.stateContainerRoot, ".host-owner-reclaims", staleLayout.ownerSessionId);
	mkdirSync(oldReclaimDir, { recursive: true });
	writeFileSync(join(oldReclaimDir, "old-generation.json"), '{"pid":99999999}\n');
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
	const readyDir = join(scratch, "host-contender-ready");
	const startFile = join(scratch, "host-contender-start");
	mkdirSync(readyDir, { recursive: true });
	writeFileSync(
		contender,
		`import { existsSync, writeFileSync } from "node:fs";\n` +
			`import { join } from "node:path";\n` +
			`import { EXT, jiti } from ${JSON.stringify(join(EXT, "..", "..", "test", "e2e", "env.mjs"))};\n` +
			`const { createCore } = await jiti.import(join(EXT, "core.ts"));\n` +
			`writeFileSync(join(${JSON.stringify(readyDir)}, String(process.pid)), "ready\\n");\n` +
			`while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n` +
			`try { const core = createCore(${JSON.stringify({ cwd: project, home, sessionId: "stale-race-session" })}); ` +
			`await new Promise(r => setTimeout(r, 800)); await core.dispose(); console.log("WON"); } ` +
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
	const contenders = [run(), run()];
	for (let i = 0; i < 400 && readdirSync(readyDir).length < 2; i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(readdirSync(readyDir).length, 2, "both host contenders reached the start barrier");
	writeFileSync(startFile, "go\n");
	const outcomes = await Promise.all(contenders);
	assert.deepEqual(outcomes.sort(), ["LOST", "WON"]);
});

await test("legacy adoption fences run-owner validation with the legacy lifecycle lock", async () => {
	const migrationHome = join(scratch, "migration-lock-home");
	const migrationProject = join(scratch, "migration-lock-project");
	const migrationLayout = createLayout(migrationProject, {
		home: migrationHome,
		sessionId: "migration-lock-session",
	});
	const legacyAgent = join(migrationLayout.legacySubagentsRoot, "worker", "live");
	mkdirSync(legacyAgent, { recursive: true });
	writeFileSync(join(migrationLayout.legacySubagentsRoot, "registry.json"), '{"agents":{}}\n');
	const ready = join(scratch, "legacy-lifecycle-ready");
	const holder = join(scratch, "legacy-lifecycle-holder.mjs");
	writeFileSync(
		holder,
		`import { mkdirSync, writeFileSync } from "node:fs";\n` +
			`import { join } from "node:path";\n` +
			`import { EXT, jiti } from ${JSON.stringify(join(EXT, "..", "..", "test", "e2e", "env.mjs"))};\n` +
			`const { withFileLockSync } = await jiti.import(join(EXT, "store/registry.ts"));\n` +
			`withFileLockSync(${JSON.stringify(join(migrationLayout.legacySubagentsRoot, ".lifecycle"))}, () => { ` +
			`mkdirSync(${JSON.stringify(legacyAgent)}, { recursive: true }); ` +
			`writeFileSync(${JSON.stringify(join(legacyAgent, ".run-owner.json"))}, JSON.stringify({ pid: process.pid }) + "\\n"); ` +
			`writeFileSync(${JSON.stringify(ready)}, "ready\\n"); ` +
			`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); });\n` +
			`await new Promise(resolve => setTimeout(resolve, 1000));\n`,
	);
	const child = spawn(process.execPath, [holder], { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const childDone = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => code === 0 || signal === "SIGTERM" ? resolve() : reject(new Error(stderr)));
	});
	for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(existsSync(ready), `legacy holder did not start: ${stderr}`);
	const startedAt = Date.now();
	assert.throws(() => adoptLegacyState(migrationLayout), /still run-owned by live Pi process/);
	assert.ok(Date.now() - startedAt >= 500, "adoption waited for the legacy lifecycle claim");
	child.kill("SIGTERM");
	await childDone;
	rmSync(join(legacyAgent, ".run-owner.json"), { force: true });
	adoptLegacyState(migrationLayout);
	rollbackLegacyAdoption(migrationLayout);
});

await test("host claim serializes with the adoption/rollback lock", async () => {
	const lockedLayout = createLayout(project, { home, sessionId: "adoption-lock-session" });
	const lockTarget = join(lockedLayout.stateContainerRoot, ".adoption");
	const ready = join(scratch, "adoption-lock-ready");
	const holder = join(scratch, "adoption-lock-holder.mjs");
	writeFileSync(
		holder,
		`import { writeFileSync } from "node:fs";\n` +
			`import { join } from "node:path";\n` +
			`import { EXT, jiti } from ${JSON.stringify(join(EXT, "..", "..", "test", "e2e", "env.mjs"))};\n` +
			`const { withFileLockSync } = await jiti.import(join(EXT, "store/registry.ts"));\n` +
			`withFileLockSync(${JSON.stringify(lockTarget)}, () => { ` +
			`writeFileSync(${JSON.stringify(ready)}, "ready\\n"); ` +
			`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); });\n`,
	);
	const child = spawn(process.execPath, [holder], { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const childDone = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
	});
	for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(existsSync(ready), `lock holder did not start: ${stderr}`);
	const startedAt = Date.now();
	const core = createCore({ cwd: project, home, sessionId: "adoption-lock-session" });
	const elapsed = Date.now() - startedAt;
	assert.ok(elapsed >= 500, `host claim bypassed adoption lock (${elapsed}ms)`);
	await core.dispose();
	await childDone;
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
	assert.equal(core.runtime._readAssignmentAnchor("worker/review"), taskB.id);
	mailbox.markDone(layout.mainMailboxDir, [report.id]);
});

await test("an answer resuming task A cannot auto-correlate A's final to queued task B", async () => {
	seedAgent(layout, "resume-correlation");
	const address = "worker/resume-correlation";
	const taskA = makeEnvelope({ from: "main", to: address, type: "message", text: "task A" });
	const generatedTaskB = makeEnvelope({ from: "main", to: address, type: "message", text: "task B" });
	const taskB = { ...generatedTaskB, id: `msg_${"0".repeat(25)}1` };
	assert.ok(taskB.id < taskA.id, "clock-rollback task B sorts below active task A");
	const question = makeEnvelope({ from: address, to: "main", type: "question", text: "clarify A" });
	const answer = makeEnvelope({
		from: "main",
		to: address,
		type: "answer",
		text: "A clarification",
		correlationId: question.id,
	});
	core.runtime._recordAssignmentAnchor(address, taskA.id);
	core.runtime._recordAssignmentAnchor(address, taskB.id);
	core.runtime._handles.set(address, { trigger: [taskB, answer] });
	const outcome = await core.runtime._mailPort.sendFromAgent({
		from: address,
		to: "main",
		type: "report",
		text: "A resumed result",
		final: true,
	});
	core.runtime._handles.delete(address);
	assert.equal(outcome.disposition, "main");
	const report = mailbox.readPending(layout.mainMailboxDir)
		.find(({ envelope }) => envelope.payload.text === "A resumed result").envelope;
	assert.equal(report.correlationId, taskA.id);
	assert.equal(report.fromGenerationId, getAgent(readRegistry(layout.registryFile), address).generationId);
	assert.equal(core.runtime._readAssignmentAnchor(address), taskB.id, "B is promoted only after A completes");
	mailbox.markDone(layout.mainMailboxDir, [report.id]);
});

await test("a sole queued task trigger correlates to that task without resume mail", async () => {
	seedAgent(layout, "queued-task");
	const address = "worker/queued-task";
	const taskA = makeEnvelope({ from: "main", to: address, type: "message", text: "task A" });
	const taskB = makeEnvelope({ from: "main", to: address, type: "message", text: "task B" });
	core.runtime._recordAssignmentAnchor(address, taskA.id);
	core.runtime._recordAssignmentAnchor(address, taskB.id);
	core.runtime._handles.set(address, { trigger: [taskB] });
	const outcome = await core.runtime._mailPort.sendFromAgent({
		from: address,
		to: "main",
		type: "report",
		text: "task B result",
		final: true,
	});
	assert.equal(outcome.disposition, "main");
	const report = mailbox.readPending(layout.mainMailboxDir)
		.find(({ envelope }) => envelope.payload.text === "task B result").envelope;
	assert.equal(report.correlationId, taskB.id);
	assert.equal(core.runtime._readAssignmentAnchor(address), taskA.id, "finishing queued B leaves older A active");
	mailbox.markDone(layout.mainMailboxDir, [report.id]);
	core.runtime._handles.delete(address);
});

await test("direct user tasks retain a durable anchor across later wake turns", async () => {
	seedAgent(layout, "user-task", "running");
	const address = "worker/user-task";
	const sent = await core.sendAsUser({ to: address, text: "user task A" });
	assert.equal(core.runtime._readAssignmentAnchor(address), sent.envelopeId);
	const answer = makeEnvelope({
		from: "main",
		to: address,
		type: "answer",
		text: "resume the user task",
		correlationId: makeEnvelope({ from: address, to: "main", type: "question", text: "q" }).id,
	});
	core.runtime._handles.set(address, { trigger: [answer] });
	const outcome = await core.runtime._mailPort.sendFromAgent({
		from: address,
		to: "main",
		type: "report",
		text: "user task result",
		final: true,
	});
	core.runtime._handles.delete(address);
	assert.equal(outcome.disposition, "main");
	const report = mailbox.readPending(layout.mainMailboxDir)
		.find(({ envelope }) => envelope.payload.text === "user task result").envelope;
	assert.equal(report.correlationId, sent.envelopeId);
	mailbox.markDone(layout.mainMailboxDir, [
		report.id,
		...mailbox.readPending(layout.mainMailboxDir)
			.filter(({ envelope }) => envelope.payload.text.includes("FYI: the user messaged"))
			.map(({ envelope }) => envelope.id),
	]);
	mailbox.markDone(layout.mailboxDir("worker", "user-task"), [sent.envelopeId]);
});

await test("restart promotes queued assignment after a final-report-to-anchor-clear crash", async () => {
	const crashSessionId = "assignment-clear-crash";
	const crashLayout = createLayout(project, { home, sessionId: crashSessionId });
	const first = createCore({ cwd: project, home, sessionId: crashSessionId });
	seedAgent(crashLayout, "assignment-crash");
	const address = "worker/assignment-crash";
	const taskA = makeEnvelope({ from: "main", to: address, type: "message", text: "A" });
	const taskB = makeEnvelope({ from: "main", to: address, type: "message", text: "B" });
	first.runtime._recordAssignmentAnchor(address, taskA.id);
	first.runtime._recordAssignmentAnchor(address, taskB.id);
	const generationId = getAgent(readRegistry(crashLayout.registryFile), address).generationId;
	const finalA = makeEnvelope({
		from: address,
		fromGenerationId: generationId,
		to: "main",
		type: "report",
		text: "A was durably delivered before the crash",
		final: true,
		correlationId: taskA.id,
	});
	mailbox.writeEnvelope(crashLayout.mainMailboxDir, finalA);
	await first.dispose();

	const resumed = createCore({ cwd: project, home, sessionId: crashSessionId });
	assert.equal(resumed.runtime._readAssignmentAnchor(address), taskB.id);
	mailbox.markDone(crashLayout.mainMailboxDir, [finalA.id]);
	await resumed.dispose();
});

await test("restart reconstructs an assignment whose delivery beat anchor persistence", async () => {
	const crashSessionId = "assignment-delivery-crash";
	const crashLayout = createLayout(project, { home, sessionId: crashSessionId });
	const first = createCore({ cwd: project, home, sessionId: crashSessionId });
	seedAgent(crashLayout, "delivery-crash");
	const address = "worker/delivery-crash";
	const taskA = makeEnvelope({ from: "main", to: address, type: "message", text: "delivered A" });
	mailbox.writeEnvelope(crashLayout.mailboxDir("worker", "delivery-crash"), taskA);
	mailbox.markDone(crashLayout.mailboxDir("worker", "delivery-crash"), [taskA.id]);
	await first.dispose();

	const resumed = createCore({ cwd: project, home, sessionId: crashSessionId });
	assert.equal(resumed.runtime._readAssignmentAnchor(address), taskA.id);
	assert.equal(
		mailbox.lookupAwaitAnchorGeneration(crashLayout.mainMailboxDir, taskA.id, address),
		getAgent(readRegistry(crashLayout.registryFile), address).generationId,
	);
	await resumed.dispose();
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
	const retry = await core.awaitResult({
		to: "worker/review",
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile: null,
	});
	assert.equal(retry.status, "completed");
	assert.equal(retry.report.id, final.id, "exact durable result is retryable from .done");
	const leftPending = mailbox.readPending(layout.mainMailboxDir).map((pending) => pending.envelope.id);
	assert.ok(leftPending.includes(stale.id));
	assert.ok(leftPending.includes(unrelatedFinal.id), "another task's final is not consumed as progress");
	mailbox.markDone(layout.mainMailboxDir, [stale.id, unrelatedFinal.id]);
});

await test("exact correlation survives restart clock rollback even when report id sorts below anchor", async () => {
	const anchor = makeEnvelope({ from: "main", to: "worker/review", type: "message", text: "clock rollback task" });
	const generated = makeEnvelope({
		from: "worker/review",
		to: "main",
		type: "report",
		text: "causally later despite lower ULID",
		final: true,
		correlationId: anchor.id,
	});
	const lowerIdFinal = { ...generated, id: `msg_${"0".repeat(26)}` };
	assert.ok(lowerIdFinal.id < anchor.id);
	mailbox.writeEnvelope(layout.mainMailboxDir, lowerIdFinal);
	const result = await core.awaitResult({
		to: "worker/review",
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile: null,
	});
	assert.equal(result.status, "completed");
	assert.equal(result.report.id, lowerIdFinal.id);
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

await test("a persisted attention result cannot starve a later final on retry", async () => {
	const address = "worker/review";
	const generationId = getAgent(readRegistry(layout.registryFile), address).generationId;
	const sessionFile = join(layout.projectSessionDir, "await-attention-retry.jsonl");
	mkdirSync(layout.projectSessionDir, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	const anchor = makeEnvelope({ from: "main", to: address, type: "message", text: "question then final" });
	const question = makeEnvelope({
		from: address,
		fromGenerationId: generationId,
		to: "main",
		type: "question",
		text: "need an answer first",
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, question);
	const first = await core.awaitResult({
		to: address,
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile,
	});
	assert.equal(first.status, "attention");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ role: "toolResult", toolName: "subagent_await", content: JSON.stringify(first) })}\n`,
		{ flag: "a" },
	);
	const final = makeEnvelope({
		from: address,
		fromGenerationId: generationId,
		to: "main",
		type: "report",
		text: "final after answer",
		final: true,
		correlationId: anchor.id,
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, final);
	const second = await core.awaitResult({
		to: address,
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile,
	});
	assert.equal(second.status, "completed");
	assert.equal(second.report.id, final.id);
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, `${question.id}.json`)));
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ role: "toolResult", toolName: "subagent_await", content: JSON.stringify(second) })}\n`,
		{ flag: "a" },
	);
	reconcileMainMailFor(project, { home, sessionId: "await-session" });
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
		`${JSON.stringify({ type: "custom-message", customType: "subagent-mail", content: `unrelated marker leak ${report.id}` })}\n`,
		{ flag: "a" },
	);
	assert.deepEqual(
		reconcileMainMailFor(project, { home, sessionId: "await-session" }),
		{ finalized: [], requeued: [], inFlight: [report.id] },
		"ordinary digest marker cannot finalize an await-owned claim",
	);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ role: "toolResult", toolName: "subagent_await", content: JSON.stringify(result) })}\n`,
		{ flag: "a" },
	);
	const reconciled = reconcileMainMailFor(project, { home, sessionId: "await-session" });
	assert.deepEqual(reconciled.finalized, [report.id]);
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, `${report.id}.json`)));
});

await test("await observes a terminal report claimed first by the ordinary main drain", async () => {
	seedAgent(layout, "drain-race");
	const address = "worker/drain-race";
	const generationId = getAgent(readRegistry(layout.registryFile), address).generationId;
	const sessionFile = join(layout.projectSessionDir, "await-drain-race.jsonl");
	mkdirSync(layout.projectSessionDir, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	const anchor = makeEnvelope({ from: "main", to: address, type: "message", text: "race the drain" });
	mailbox.recordCollectRequest(layout.mainMailboxDir, anchor.id, { type: "object" }, address);
	const waiting = core.awaitResult({
		to: address,
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile,
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	const progress = makeEnvelope({
		from: address,
		fromGenerationId: generationId,
		to: "main",
		type: "report",
		text: "parked progress",
		correlationId: anchor.id,
	});
	const report = makeEnvelope({
		from: address,
		fromGenerationId: generationId,
		to: "main",
		type: "report",
		text: "claimed between await polls",
		final: true,
		correlationId: anchor.id,
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, progress);
	mailbox.writeEnvelope(layout.mainMailboxDir, report);
	const digest = core.drainMainMail(sessionFile);
	assert.match(digest, /claimed between await polls/);
	assert.ok(existsSync(join(layout.mainMailboxDeliveringDir, `${report.id}.json`)));
	updateRegistry(layout.registryFile, (registry) => removeAgent(registry, address));

	const result = await waiting;
	assert.equal(result.status, "completed");
	assert.equal(result.report.id, report.id);
	assert.deepEqual(result.progress.map((item) => item.id), [progress.id]);
	const meta = JSON.parse(readFileSync(join(layout.mainMailboxDeliveringDir, `${report.id}.json.meta`), "utf8"));
	const progressMeta = JSON.parse(readFileSync(join(layout.mainMailboxDeliveringDir, `${progress.id}.json.meta`), "utf8"));
	assert.deepEqual(meta.markers, ["subagent-mail", "subagent_await"]);
	assert.deepEqual(progressMeta.markers, ["subagent-mail", "subagent_await"]);

	// Only the await tool result is appended. Its alternate marker must be
	// sufficient to finalize the envelope; a crash must not requeue it merely
	// because the racing digest append never landed.
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ role: "toolResult", toolName: "subagent_await", content: JSON.stringify(result) })}\n`,
		{ flag: "a" },
	);
	assert.deepEqual(
		reconcileMainMailFor(project, { home, sessionId: "await-session" }).finalized,
		[progress.id, report.id],
	);
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, `${progress.id}.json`)));
	assert.ok(existsSync(join(layout.mainMailboxDoneDir, `${report.id}.json`)));
	assert.equal(mailbox.peekCollectRequest(layout.mainMailboxDir, anchor.id, address), undefined);
	core.rollbackMainMailDrain();
	assert.equal(
		mailbox.peekCollectRequest(layout.mainMailboxDir, anchor.id, address),
		undefined,
		"failed racing digest must not resurrect collect metadata after await finalized the report",
	);
	assert.ok(!mailbox.readPending(layout.mainMailboxDir).some(({ envelope }) => envelope.id === report.id));
});

await test("await is generation-fenced against attention from a reused address", async () => {
	seedAgent(layout, "await-aba");
	const address = "worker/await-aba";
	const oldGeneration = getAgent(readRegistry(layout.registryFile), address).generationId;
	const anchor = makeEnvelope({ from: "main", to: address, type: "message", text: "old generation task" });
	const waiting = core.awaitResult({
		to: address,
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile: null,
	});
	updateRegistry(layout.registryFile, (registry) => {
		removeAgent(registry, address);
		upsertAgent(registry, {
			type: "worker",
			id: "await-aba",
			lifetime: "persistent",
			purview: "replacement",
			typeFileHash: "test",
			state: "dormant",
		});
	});
	const replacementGeneration = getAgent(readRegistry(layout.registryFile), address).generationId;
	assert.notEqual(replacementGeneration, oldGeneration);
	const replacementQuestion = makeEnvelope({
		from: address,
		fromGenerationId: replacementGeneration,
		to: "main",
		type: "question",
		text: "unrelated replacement question",
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, replacementQuestion);
	const result = await waiting;
	assert.equal(result.status, "retired");
	assert.ok(
		mailbox.readPending(layout.mainMailboxDir).some(({ envelope }) => envelope.id === replacementQuestion.id),
		"replacement traffic is not consumed by the old await",
	);
	mailbox.markDone(layout.mainMailboxDir, [replacementQuestion.id]);
});

await test("crash-resumed await rejects stamped attention from an absent reused generation", async () => {
	seedAgent(layout, "await-absent-aba");
	const address = "worker/await-absent-aba";
	const generation1 = getAgent(readRegistry(layout.registryFile), address).generationId;
	const anchor = makeEnvelope({ from: "main", to: address, type: "message", text: "G1 task" });
	mailbox.recordAwaitAnchor(layout.mainMailboxDir, anchor.id, address, generation1);
	updateRegistry(layout.registryFile, (registry) => {
		removeAgent(registry, address);
		upsertAgent(registry, {
			type: "worker", id: "await-absent-aba", lifetime: "persistent",
			purview: "G2", typeFileHash: "test", state: "dormant",
		});
	});
	const generation2 = getAgent(readRegistry(layout.registryFile), address).generationId;
	const question = makeEnvelope({
		from: address,
		fromGenerationId: generation2,
		to: "main",
		type: "question",
		text: "G2 unrelated then retired",
	});
	mailbox.writeEnvelope(layout.mainMailboxDir, question);
	updateRegistry(layout.registryFile, (registry) => removeAgent(registry, address));
	const result = await core.awaitResult({
		to: address,
		waitFor: "final",
		anchorId: anchor.id,
		timeoutSeconds: 2,
		sessionFile: null,
	});
	assert.equal(result.status, "retired");
	assert.ok(mailbox.readPending(layout.mainMailboxDir).some(({ envelope }) => envelope.id === question.id));
	mailbox.markDone(layout.mainMailboxDir, [question.id]);
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

await test("clean shutdown cancels escalation waits and settles host-parked prompts", async () => {
	const shutdownCore = createCore({ cwd: project, home, sessionId: "shutdown-escalation-session" });
	const shutdownLayout = shutdownCore.layout;
	seedAgent(shutdownLayout, "shutdown-waiter");
	const wait = shutdownCore.runtime._escalations
		.request(
			{
				agent: "worker/shutdown-waiter",
				tool: "write",
				inputSummary: "outside.txt",
				reason: "outside scope",
			},
			undefined,
		)
		.catch((error) => error);
	const record = shutdownCore.escalations.pending()[0];
	assert.ok(record.envelopeId);
	const sessionFile = join(shutdownLayout.projectSessionDir, "shutdown-host.jsonl");
	mkdirSync(shutdownLayout.projectSessionDir, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
	mailbox.claimPendingForHost(
		shutdownLayout.mainMailboxDir,
		({ envelope }) => envelope.id === record.envelopeId,
		sessionFile,
		"subagent-mail",
	);
	assert.ok(existsSync(join(shutdownLayout.mainMailboxDeliveringDir, `${record.envelopeId}.json`)));
	await shutdownCore.dispose();
	const cancellation = await wait;
	assert.match(cancellation.message, /shut down while the escalation was pending/);
	assert.ok(!existsSync(join(shutdownLayout.mainMailboxDeliveringDir, `${record.envelopeId}.json`)));
	assert.ok(existsSync(join(shutdownLayout.mainMailboxDoneDir, `${record.envelopeId}.json`)));
	const persisted = JSON.parse(readFileSync(shutdownLayout.escalationFile(record.id), "utf8"));
	assert.equal(persisted.status, "cancelled");
});

await test("shutdown captures an escalation raised while an earlier handle abort is awaited", async () => {
	const shutdownCore = createCore({ cwd: project, home, sessionId: "late-shutdown-escalation-session" });
	const shutdownLayout = shutdownCore.layout;
	seedAgent(shutdownLayout, "first");
	seedAgent(shutdownLayout, "late");
	let lateRecord;
	let lateWait;
	const firstSession = {
		isStreaming: true,
		abort: async () => {
			lateWait = shutdownCore.runtime._escalations
				.request(
					{
						agent: "worker/late",
						tool: "write",
						inputSummary: "late.txt",
						reason: "outside scope",
					},
					undefined,
				)
				.catch((error) => error);
			lateRecord = shutdownCore.escalations.pending()[0];
		},
		dispose: () => {},
	};
	const lateSession = { isStreaming: false, abort: async () => {}, dispose: () => {} };
	shutdownCore.runtime._handles.set("worker/first", { session: firstSession });
	shutdownCore.runtime._handles.set("worker/late", { session: lateSession });
	await shutdownCore.dispose();
	assert.ok(lateRecord?.envelopeId);
	const cancellation = await lateWait;
	assert.match(cancellation.message, /shut down while the escalation was pending/);
	assert.ok(existsSync(join(shutdownLayout.mainMailboxDoneDir, `${lateRecord.envelopeId}.json`)));
	assert.ok(!mailbox.readPending(shutdownLayout.mainMailboxDir).some(({ envelope }) => envelope.id === lateRecord.envelopeId));
});

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
	const historicalFinal = makeEnvelope({
		from: "worker/tmp-presend", to: "main", type: "report", text: "old generation", final: true,
	});
	mailbox.writeEnvelope(crashLayout.mainMailboxDir, historicalFinal);
	const expectedNewFinal = makeEnvelope({
		from: "worker/tmp-presend", to: "main", type: "report", text: "reserved but never sent", final: true,
	});
	writeFileSync(
		crashLayout.retireRequestedFile("worker", "tmp-presend"),
		`${JSON.stringify({
			kind: "oneshot-auto",
			requestedAt: new Date().toISOString(),
			evidenceEnvelopeId: expectedNewFinal.id,
		})}\n`,
	);
	const recovered = createCore({ cwd: project, home, sessionId: "oneshot-presend-crash" });
	assert.equal((await recovered.status())[0].address, "worker/tmp-presend");
	assert.ok(!existsSync(crashLayout.retireRequestedFile("worker", "tmp-presend")));
	await recovered.dispose();
});

await test("runtime-error intent replays exact missing evidence before crash-recovered funeral", async () => {
	const crashLayout = createLayout(project, { home, sessionId: "oneshot-error-gap-session" });
	updateRegistry(crashLayout.registryFile, (registry) =>
		upsertAgent(registry, {
			type: "worker",
			id: "tmp-error-gap",
			lifetime: "oneshot",
			purview: "tmp-error-gap",
			typeFileHash: "test",
			state: "dormant",
		}),
	);
	mkdirSync(crashLayout.filesDir("worker", "tmp-error-gap"), { recursive: true });
	const reserved = makeEnvelope({
		from: "worker/tmp-error-gap", to: "main", type: "error", text: "fatal turn replay",
	});
	writeFileSync(
		crashLayout.retireRequestedFile("worker", "tmp-error-gap"),
		`${JSON.stringify({
			kind: "oneshot-auto",
			requestedAt: new Date().toISOString(),
			evidenceEnvelopeId: reserved.id,
			source: "runtime-error",
			evidenceText: "fatal turn replay",
		})}\n`,
	);
	const recovered = createCore({ cwd: project, home, sessionId: "oneshot-error-gap-session" });
	assert.deepEqual(await recovered.status(), []);
	const replayed = mailbox.readPending(crashLayout.mainMailboxDir).map(({ envelope }) => envelope)
		.find((envelope) => envelope.id === reserved.id);
	assert.equal(replayed?.type, "error");
	assert.equal(replayed?.payload.text, "fatal turn replay");
	assert.ok(existsSync(crashLayout.archiveDir("worker", "tmp-error-gap")));
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
		`${JSON.stringify({
			kind: "oneshot-auto",
			requestedAt: new Date().toISOString(),
			evidenceEnvelopeId: finalEvidence.id,
		})}\n`,
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
