import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { repository } from "./helpers.mjs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { inspectCheckout } from "../extensions/swarm/host-approval.mjs";

function populated(t) {
	const root = repository(t);
	writeFileSync(join(root, ".gitignore"), "/node_modules/\n/build/\n/worktrees/\n");
	const directory = join(root, "node_modules", "build", "worktrees");
	mkdirSync(directory, { recursive: true });
	for (let i = 0; i < 128; i++) writeFileSync(join(directory, `${i}.txt`), "x".repeat(65536));
	return { root, directory };
}

test("checkout inspection remains responsive and discloses ignored-file scope",  async t => {
	const { root, directory } = populated(t);
	let ticks = 0;
	const interval = setInterval(() => ticks++, 1);
	let inspection;
	try { inspection = await inspectCheckout(root); }
	finally { clearInterval(interval); }
	assert.ok(ticks > 0, "host timers must run during inspection");
	assert.equal(inspection.repository, true);
	assert.ok(!inspection.changes.some(change => change.path.startsWith("node_modules/")));
	assert.match(inspection.fingerprintScope, /ignored files are checked per operation/);
	writeFileSync(join(directory, "0.txt"), "external ignored edit");
	assert.equal((await inspectCheckout(root)).fingerprint, inspection.fingerprint);
	writeFileSync(join(root, "owner-work.txt"), "non-ignored edit");
	const changed = await inspectCheckout(root);
	assert.notEqual(changed.fingerprint, inspection.fingerprint);
	writeFileSync(join(root, "owner-work.txt"), "same-length change");
	assert.notEqual((await inspectCheckout(root)).fingerprint, changed.fingerprint);
	// Tracked files stay covered even when an ignore rule matches them.
	execFileSync("git", ["-C", root, "add", "-f", "node_modules/build/worktrees/0.txt"]);
	const tracked = await inspectCheckout(root);
	writeFileSync(join(directory, "0.txt"), "tracked ignored edit");
	assert.notEqual((await inspectCheckout(root)).fingerprint, tracked.fingerprint);
});

test("inspection cancellation rejects without a late result and permits a fresh inspection", async t => {
	const { root } = populated(t);
	const cancel = new AbortController();
	const pending = inspectCheckout(root, { signal: cancel.signal });
	const rejected = assert.rejects(pending, { code: "CANCELLED" });
	setTimeout(() => cancel.abort(), 0);
	await rejected;
	assert.ok((await inspectCheckout(root)).fingerprint);
	await assert.rejects(inspectCheckout(root, { signal: cancel.signal }), { code: "CANCELLED" });
});

test("inspection deadline and worker filesystem errors fail closed", async t => {
	const { root } = populated(t);
	await assert.rejects(inspectCheckout(root, { timeoutMs: 1 }), { code: "INSPECTION_TIMEOUT" });
	await assert.rejects(inspectCheckout(join(root, "missing")), { code: "PATH", phase: "inspection" });
});


test("scoped snapshots refuse a replaced directory without reading external content", async t => {
	const root = repository(t);
	const nested = join(root, "src");
	mkdirSync(nested); writeFileSync(join(nested, "tracked.txt"), "inside");
	execFileSync("git", ["-C", root, "add", "src/tracked.txt"]);
	renameSync(nested, join(root, "saved"));
	const outside = mkdtempSync(join(tmpdir(), "swarm-inspection-outside-"));
	const { rmSync } = await import("node:fs");
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	writeFileSync(join(outside, "tracked.txt"), "external");
	symlinkSync(outside, nested, "junction");
	await assert.rejects(inspectCheckout(root), { code: "PATH", phase: "inspection" });
	assert.equal(readFileSync(join(outside, "tracked.txt"), "utf8"), "external");
});

test("Git output limits fail closed with actionable inspection diagnostics", async t => {
	const root = repository(t);
	for (let i = 0; i < 30; i++) writeFileSync(join(root, `${i}-${"long".repeat(30)}.txt`), "file");
	await assert.rejects(inspectCheckout(root, { maxOutputBytes: 256 }), { code: "INSPECTION_LIMIT", phase: "inspection" });
	assert.ok((await inspectCheckout(root)).fingerprint);
});

test("cancellation during a Git subprocess drains it with a consistent code", { skip: process.platform === "win32" }, async t => {
	const root = repository(t);
	const bin = join(root, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n"); chmodSync(join(bin, "git"), 0o700);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous}`;
	try {
		const cancel = new AbortController();
		const timer = setTimeout(() => cancel.abort(), 40);
		try { await assert.rejects(inspectCheckout(root, { signal: cancel.signal }), { code: "CANCELLED", phase: "inspection" }); }
		finally { clearTimeout(timer); }
	} finally { process.env.PATH = previous; }
	assert.ok((await inspectCheckout(root)).fingerprint);
});
