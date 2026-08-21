/**
 * Phase-8 regression e2e: locks in the review-fix behaviors so they can't silently
 * regress. Covers the pure/deterministic surface of the fixes (H1 bash deny, H7
 * collect digest, M2 hop escape, M15 ULID seed, M17 index quarantine, ST-4 archive
 * address, ST-6 registry repair, MAIL-5/6 mailbox, MAIL-7 bounce, M18 no leak,
 * SEC-9 frontmatter fence, M10 containment).
 *
 * Run: node phase8-review-fixes.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { EXT, WORLDS, jiti } from "./env.mjs";

const systemDeny = await jiti.import(join(EXT, "sandbox/system-deny.ts"));
const { parseTypeFile } = await jiti.import(join(EXT, "typedefs/parse.ts"));
const envelope = await jiti.import(join(EXT, "mail/envelope.ts"));
const digest = await jiti.import(join(EXT, "mail/digest.ts"));
const hops = await jiti.import(join(EXT, "rails/hops.ts"));
const registry = await jiti.import(join(EXT, "store/registry.ts"));
const archive = await jiti.import(join(EXT, "store/archive.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { Deliverer } = await jiti.import(join(EXT, "mail/deliver.ts"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const mainTools = await jiti.import(join(EXT, "tools/main-agent.ts"));

const scratch = join(WORLDS, "phase8-world");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

let passed = 0;
function ok(name, fn) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}
async function okA(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ------------------------------------------------------- H1: bash command deny
console.log("system-deny bash text scan (H1):");
ok("denies a bash command referencing a protected root", () => {
	const home = join(sep, "home", "u");
	const protectedDir = join(home, ".pi", "agent", "subagents");
	const check = systemDeny.makeCommandDenyCheck([protectedDir], (p) => p, home);
	assert.equal(check(`echo pwned > ${protectedDir}${sep}self.md`).denied, true);
	assert.equal(check("echo pwned > ~/.pi/agent/subagents/self.md").denied, true, "tilde spelling caught");
	assert.equal(check("$HOME/.pi/agent/subagents/x").denied, true, "$HOME spelling caught");
	assert.equal(check("ls src/").denied, false, "an unrelated command is allowed");
});

// ------------------------------------------------------- M10: NF-C containment
console.log("system-deny containment (M10):");
ok("an NFD spelling of the same protected path is still denied", () => {
	// "café" as NFC vs NFD (e + combining accent). Same file, different bytes.
	const project = join(sep, "proj");
	const nfc = join(project, "café", "subagents");
	const nfd = join(project, "café", "subagents", "self.md");
	const check = systemDeny.makeSystemDenyCheck([nfc], (p) => p);
	assert.equal(check(nfd).denied, true);
});

// ------------------------------------------------------- SEC-9: frontmatter fence
console.log("frontmatter fence (SEC-9):");
ok("a body line starting with --- is not mistaken for the closing fence", () => {
	const md = ["---", "name: t", "description: d", "---", "body line", "----- a rule", "more"].join("\n");
	const parsed = parseTypeFile(md, "t");
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
	assert.ok(parsed.definition.body.includes("----- a rule"), "the ---- line stays in the body");
});
ok("still rejects an unterminated frontmatter block", () => {
	const parsed = parseTypeFile("---\nname: t\ndescription: d\n", "t");
	assert.equal(parsed.ok, false);
});

// ------------------------------------------------------- M15: ULID seed from disk
console.log("ULID seed (M15):");
ok("a seeded id makes the next mint sort strictly after it", () => {
	// Seed from a far-future time-prefix; a fresh id (real clock) must still sort after.
	const future = `msg_${"Z".repeat(10)}${"0".repeat(16)}`; // max time prefix
	envelope.seedUlidClock(future);
	const next = `msg_${envelope.ulid(1)}`; // tiny wall clock → must be forced past the seed
	assert.ok(next > future, `${next} should sort after ${future}`);
});

// ------------------------------------------------------- H7: collect schema in digest
console.log("collect digest (H7):");
ok("a collect request renders its schema block in the wake digest", () => {
	const env = envelope.makeEnvelope({
		from: "main",
		to: "worker/main",
		type: "message",
		text: "please fulfil",
		data: { collectSchema: { type: "object", properties: { n: { type: "integer" } } } },
	});
	const out = digest.composeWakeDigest({ items: [{ envelope: env, redelivered: false }], questionLookup: () => undefined });
	assert.ok(out.includes("collectSchema"), "the schema is shown");
	assert.ok(out.includes("conforming to the `collectSchema` shown above"), "instruction references it");
});

// ------------------------------------------------------- M2: question-to-main escape
console.log("hops escape (M2):");
ok("a question addressed to main is never hop-limited", () => {
	const guard = hops.makeHopsGuard(8);
	const q = envelope.makeEnvelope({ from: "a/1", to: "main", type: "question", text: "stuck?", hops: 20 });
	assert.equal(guard(q), null, "deep question to main is allowed");
	const peerQ = envelope.makeEnvelope({ from: "a/1", to: "b/1", type: "question", text: "?", hops: 20 });
	assert.ok(guard(peerQ) !== null, "a deep peer question is still bounced");
});

// ------------------------------------------------------- ST-6: registry repair
console.log("registry repair (ST-6):");
ok("a record with corrupt vitals is repaired, not dropped", () => {
	const path = join(scratch, "registry.json");
	const gen = registry.newGenerationId();
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			agents: {
				"worker/main": {
					type: "worker",
					id: "main",
					lifetime: "persistent",
					generationId: gen,
					typeFileHash: "abc",
					createdAt: "2026-01-01T00:00:00Z",
					lastActiveAt: "2026-01-01T00:00:00Z",
					vitals: "corrupt-not-an-object",
				},
			},
		}),
	);
	const reg = registry.readRegistry(path);
	const rec = registry.getAgent(reg, "worker/main");
	assert.ok(rec, "record kept (dir not orphaned)");
	assert.equal(rec.vitals.state, "dormant", "vitals repaired to defaults");
});

// ------------------------------------------------------- ST-4: archive true address
console.log("archive address (ST-4):");
ok("an id ending in -digits is reported with its true address", () => {
	const layout = createLayout("/proj/x", { sessionId: "sess1", home: join(scratch, "arc-home") });
	mkdirSync(layout.agentInstanceDir("worker", "shard-2"), { recursive: true });
	writeFileSync(join(layout.agentInstanceDir("worker", "shard-2"), "x.jsonl"), "{}");
	archive.archiveAgentDir(layout, "worker", "shard-2", "2026-07-14T00:00:00Z");
	const list = archive.readArchived(layout);
	assert.ok(
		list.some((a) => a.address === "worker/shard-2"),
		`expected worker/shard-2, got ${JSON.stringify(list.map((a) => a.address))}`,
	);
});

// ------------------------------------------------------- retention GC (D13)
console.log("retention GC (archiveGcDays):");
ok("gcArchive removes old retired dirs, keeps fresh ones; days<=0 disables", () => {
	const layout = createLayout("/proj/gc", { sessionId: "sess-gc", home: join(scratch, "gc-home") });
	const now = Date.parse("2026-07-15T00:00:00Z");
	for (const [id, retiredAt] of [["old", "2026-07-01T00:00:00Z"], ["fresh", "2026-07-14T00:00:00Z"]]) {
		mkdirSync(layout.agentInstanceDir("w", id), { recursive: true });
		archive.archiveAgentDir(layout, "w", id, retiredAt);
	}
	assert.equal(archive.gcArchive(layout, 0, now), 0, "days<=0 disables");
	assert.equal(archive.gcArchive(layout, 7, now), 1, "one dir past the 7-day cutoff");
	const left = archive.readArchived(layout).map((a) => a.address);
	assert.deepEqual(left, ["w/fresh"], "fresh archive survives");
});
ok("gcDoneMail removes old processed envelopes, keeps fresh and pending ones", () => {
	const box = join(scratch, "gc-mbox");
	const done = join(box, ".done");
	mkdirSync(done, { recursive: true });
	const now = Date.now();
	writeFileSync(join(done, "msg_old.json"), "{}");
	utimesSync(join(done, "msg_old.json"), new Date(now - 10 * 86_400_000), new Date(now - 10 * 86_400_000));
	writeFileSync(join(done, "msg_fresh.json"), "{}");
	writeFileSync(join(box, "msg_pending.json"), "{}"); // live mail is never touched
	assert.equal(archive.gcDoneMail([box], 0, now), 0, "days<=0 disables");
	assert.equal(archive.gcDoneMail([box], 7, now), 1);
	assert.deepEqual(readdirSync(done).sort(), ["msg_fresh.json"]);
	assert.ok(existsSync(join(box, "msg_pending.json")));
});

// ------------------------------------------------------- MAIL-5/6/M17: mailbox
console.log("mailbox hygiene (MAIL-5/6, M17):");
ok("markDone renames before dropping the marker; pendingCount has no side effects", () => {
	const box = join(scratch, "mbox");
	const env = envelope.makeEnvelope({ from: "main", to: "worker/main", type: "message", text: "hi" });
	mailbox.writeEnvelope(box, env);
	mailbox.beginDelivery(box, env.id);
	assert.equal(mailbox.pendingCount(box), 1);
	mailbox.markDone(box, env.id);
	const leftover = readdirSync(box).filter((n) => n.endsWith(".attempt"));
	assert.equal(leftover.length, 0, "no orphaned attempt marker in the normal path");
	assert.equal(mailbox.pendingCount(box), 0);
});
ok("an orphaned .attempt marker (crash between rename and rm) is inert", () => {
	// markDone moves the envelope to .done BEFORE removing the marker; a crash in
	// between leaves only the marker. It must not count as, or redeliver as, mail —
	// the reverse ordering would instead leave the ENVELOPE with no marker, which
	// redelivers unlabeled (redelivered:false).
	const box = join(scratch, "mbox-orphan");
	mkdirSync(box, { recursive: true });
	const orphanId = "msg_" + "0".repeat(26);
	writeFileSync(join(box, `${orphanId}.json.attempt`), "");
	assert.equal(mailbox.pendingCount(box), 0, "marker not counted as pending");
	assert.deepEqual(mailbox.readPending(box), [], "marker not read as an envelope");
	assert.equal(mailbox.maxEnvelopeId(box), null, "marker not counted as an id");
	// And a redelivery after a crash BEFORE the rename is labeled honestly.
	const env = envelope.makeEnvelope({ from: "main", to: "worker/main", type: "message", text: "again" });
	mailbox.writeEnvelope(box, env);
	mailbox.beginDelivery(box, env.id);
	const pending = mailbox.readPending(box);
	assert.equal(pending.length, 1);
	assert.equal(pending[0].redelivered, true, "attempt marker present → labeled redelivered");
});
ok("a corrupt sender-index is quarantined, not silently overwritten", () => {
	const box = join(scratch, "mbox2");
	mkdirSync(box, { recursive: true });
	const idxPath = join(box, ".sent-questions.json");
	writeFileSync(idxPath, "{ this is : not json");
	// Recording a new question triggers a read → quarantine of the corrupt file.
	mailbox.recordSentQuestion(box, "msg_" + "0".repeat(26), "q?", "worker/main");
	const quarantined = readdirSync(box).some((n) => n.startsWith(".sent-questions.json.corrupt-"));
	assert.ok(quarantined, "corrupt index moved aside");
});

// ------------------------------------------------------- MAIL-7 / M18: bounce + no leak
console.log("delivery bounce (MAIL-7, M18):");
ok("a question to an unknown agent bounces without leaking a sent-question entry", () => {
	const box = join(scratch, "sender-box");
	mkdirSync(box, { recursive: true });
	const deliverer = new Deliverer(
		{
			mainMailboxDir: join(scratch, "main-box"),
			// The sender a/1 exists (so its bounce is deliverable); the recipient ghost/main does not.
			agentMailboxDir: (type, id) => (type === "a" && id === "1" ? box : undefined),
			agentState: (addr) => (addr === "a/1" ? "running" : undefined),
			generationOf: () => undefined,
			wake: () => {},
			senderMailboxDir: (from) => (from.kind === "agent" ? box : undefined),
		},
		() => null,
	);
	const outcome = deliverer.send({ from: { kind: "agent", type: "a", id: "1" }, to: "ghost/main", type: "question", text: "?" });
	assert.equal(outcome.delivered, false);
	assert.equal(outcome.disposition, "bounced");
	// The sent-questions index must NOT have recorded the un-deliverable question.
	assert.ok(!existsSync(join(box, ".sent-questions.json")), "no leaked sent-question entry");
});

// ------------------------------------------------------- M16 / SEND-5: tool guards
console.log("main-agent tool guards (M16, SEND-5):");
await (async () => {
	let sendCalled = false;
	const stubCore = {
		send: async () => {
			sendCalled = true;
			return { delivery: "queued", disposition: "bounced", envelopeId: "x", bounceReason: "no such agent" };
		},
	};
	const sendTool = mainTools.createSendTool(() => stubCore);
	await okA("team_send rejects a non-agent target before hitting the core", async () => {
		const res = await sendTool.execute("id", { to: "main", text: "hi" }, undefined, undefined, {});
		assert.equal(res.isError, true);
		assert.equal(sendCalled, false, "core.send not reached for an invalid target");
	});
	await okA("team_send surfaces a bounce as an error", async () => {
		const res = await sendTool.execute("id", { to: "worker/main", text: "hi" }, undefined, undefined, {});
		assert.equal(res.isError, true);
		assert.ok(res.content[0].text.includes("bounced"));
	});
})();

console.log(`\nPhase 8 (review fixes): ${passed} checks passed.`);
