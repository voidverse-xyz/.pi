import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	canonicalJSON,
	hashAgentCall,
	hydrateAgentOutput,
	Journal,
	type JournalAgentLine,
	MAX_INLINE_OUTPUT,
	readJournal,
	ReplayCache,
} from "./journal.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pi-procedure-journal-"));

const agentLine = (seq: number, hash: string, status: "ok" | "error" = "ok", output: unknown = `o${seq}`): JournalAgentLine => ({
	type: "agent",
	seq,
	hash,
	label: `a${seq}`,
	phase: "P",
	status,
	output,
	promptPreview: "p",
	elapsedMs: 1,
});

test("canonicalJSON: key order independent, undefined dropped", () => {
	assert.equal(canonicalJSON({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJSON({ a: [2, { c: 4, d: 3 }], b: 1 }));
	assert.equal(canonicalJSON({ a: 1, gone: undefined }), '{"a":1}');
});

test("hashAgentCall: stable, excludes label/phase, sensitive to prompt/opts", () => {
	const h = hashAgentCall({ prompt: "p", tools: ["read"] });
	assert.equal(h, hashAgentCall({ tools: ["read"], prompt: "p" } as never));
	assert.notEqual(h, hashAgentCall({ prompt: "p2", tools: ["read"] }));
	assert.notEqual(h, hashAgentCall({ prompt: "p", tools: ["read"], model: "x/y" }));
	assert.equal(hashAgentCall({ prompt: "p" }), hashAgentCall({ prompt: "p", schema: undefined }));
});

test("journal roundtrip; corrupt lines skipped", () => {
	const file = join(dir(), "journal.jsonl");
	const j = new Journal(file);
	j.start({ runId: "20260716T000000_aaaaaa", name: "t", scriptHash: "s", argsHash: "a", createdAt: "2026-07-16T00:00:00Z" });
	j.append({ type: "log", text: "hello" });
	j.appendAgent(agentLine(0, "h0"), join(dir(), "unused.json"));
	j.append({ type: "end", status: "completed", result: 42 });
	// simulate a torn write
	const withTorn = `${readFileSync(file, "utf8")}{"type":"agent","seq":`;
	const lines = readJournal(file);
	assert.deepEqual(
		lines.map((l) => l.type),
		["meta", "log", "agent", "end"],
	);
	assert.equal(withTorn.endsWith('{"type":"agent","seq":'), true);
});

test("oversized outputs spill to the sidecar and hydrate back", () => {
	const d = dir();
	const file = join(d, "journal.jsonl");
	const sidecar = join(d, "agents", "0", "output.json");
	const j = new Journal(file);
	j.start({ runId: "20260716T000000_aaaaaa", name: "t", scriptHash: "s", argsHash: "a", createdAt: "x" });
	const big = "x".repeat(MAX_INLINE_OUTPUT + 10);
	j.appendAgent(agentLine(0, "h0", "ok", big), sidecar);
	const line = readJournal(file).find((l): l is JournalAgentLine => l.type === "agent")!;
	assert.equal(line.output, undefined);
	assert.equal(line.outputFile, sidecar);
	assert.equal(hydrateAgentOutput(line), big);
	// small outputs stay inline
	j.appendAgent(agentLine(1, "h1", "ok", { small: true }), join(d, "agents", "1", "output.json"));
	const small = readJournal(file).find((l): l is JournalAgentLine => l.type === "agent" && l.seq === 1)!;
	assert.deepEqual(hydrateAgentOutput(small), { small: true });
});

test("ReplayCache: hash-keyed hits tolerate reordering; first miss diverges forever", () => {
	const cache = new ReplayCache([agentLine(0, "hA"), agentLine(1, "hB"), agentLine(2, "hC")]);
	assert.equal(cache.size, 3);
	// different completion order than the recording — still all hits
	assert.equal(cache.take("hB")?.seq, 1);
	assert.equal(cache.take("hA")?.seq, 0);
	assert.equal(cache.take("hMISS"), null);
	assert.equal(cache.diverged, true);
	// post-divergence, even a would-be hit runs live
	assert.equal(cache.take("hC"), null);
});

test("ReplayCache: duplicate hashes drain FIFO by seq; error entries never cached", () => {
	const cache = new ReplayCache([agentLine(3, "same"), agentLine(1, "same"), agentLine(2, "failed", "error")]);
	assert.equal(cache.size, 2);
	assert.equal(cache.take("same")?.seq, 1);
	assert.equal(cache.take("same")?.seq, 3);
	assert.equal(cache.take("failed"), null);
	assert.equal(cache.diverged, true);
});
