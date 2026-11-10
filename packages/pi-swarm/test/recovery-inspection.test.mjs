import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { machine, repository } from "./helpers.mjs";
import { acquireLease } from "../extensions/swarm/store/lease.mjs";
import { prepareLayout } from "../extensions/swarm/store/layout.mjs";
import { privateDirectory } from "../extensions/swarm/store/files.mjs";
import { inspectRecovery } from "../extensions/swarm/recovery-inspection.mjs";
import { openJournal, inspectJournal } from "../extensions/swarm/store/journal.mjs";

function fixture(t) {
	const root = repository(t);
	const layout = prepareLayout(root, "run1");
	const lease = acquireLease(layout, { ownerSessionId: "session1" });
	privateDirectory(layout.runRoot);
	const event = structuredClone(machine().events[0]);
	event.payload.workspaceRoot = root;
	const journal = openJournal(layout.journalPath, lease.assertOwned);
	journal.append(event);
	journal.close();
	return { root, layout, lease, event };
}

function patchFs(t, replacements) {
	const originals = {};
	for (const [key, value] of Object.entries(replacements)) { originals[key] = fs[key]; fs[key] = value; }
	syncBuiltinESMExports();
	const restore = () => { Object.assign(fs, originals); syncBuiltinESMExports(); };
	t.after(restore);
	return restore;
}

test("recovery inspection only opens read-only files and never invokes mutation APIs", t => {
	const { root, layout } = fixture(t);
	const open = fs.openSync;
	const replacements = { openSync(path, flags, ...args) {
		assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND), 0);
		return open(path, flags, ...args);
	} };
	for (const key of ["writeSync", "writeFileSync", "appendFileSync", "fsyncSync", "mkdirSync", "unlinkSync", "rmdirSync", "renameSync", "chmodSync"]) replacements[key] = () => { throw new Error(`Forbidden mutation: ${key}`); };
	const restore = patchFs(t, replacements);
	try {
		const snapshot = inspectRecovery(root, "run1");
		assert.equal(snapshot.state.status, "paused");
		assert.equal(snapshot.state.revision, 1);
		assert.equal(snapshot.lease.runId, "run1");
		assert.equal(snapshot.leaseIdentity.ino, fs.lstatSync(layout.ownerPath).ino);
		assert.match(snapshot.journalFingerprint, /^[a-f0-9]{64}$/);
		assert.match(snapshot.reservationFingerprint, /^[a-f0-9]{64}$/);
		assert.deepEqual(inspectRecovery(root, "run1"), snapshot);
	} finally { restore(); }
});

test("missing and legacy runs retain diagnostics without creating state", t => {
	const root = repository(t);
	const layout = prepareLayout(root, "run1");
	assert.throws(() => inspectRecovery(root, "run1"), { code: "NOT_FOUND" });
	assert.equal(fs.existsSync(layout.stateRoot), false);
	fs.mkdirSync(join(root, ".swarms", "run1"), { recursive: true });
	assert.throws(() => inspectRecovery(root, "run1"), { code: "LEGACY_RUN" });
	assert.equal(fs.existsSync(layout.stateRoot), false);
});

for (const corruption of ["incomplete", "checksum", "utf8", "hardlink", "symlink", "private-file", "private-parent"]) {
	test(`inspection rejects ${corruption} without repair`, t => {
		const { root, layout } = fixture(t);
		let bytes = fs.readFileSync(layout.journalPath);
		if (corruption === "incomplete") fs.writeFileSync(layout.journalPath, bytes.subarray(0, -1));
		if (corruption === "checksum") { const record = JSON.parse(bytes); record.payload.actor = "changed"; fs.writeFileSync(layout.journalPath, JSON.stringify(record) + "\n"); }
		if (corruption === "utf8") fs.writeFileSync(layout.journalPath, Buffer.from([255, 10]));
		if (corruption === "hardlink") fs.linkSync(layout.journalPath, join(layout.runRoot, "alias"));
		if (corruption === "symlink") { fs.renameSync(layout.journalPath, layout.journalPath + ".original"); fs.symlinkSync(layout.journalPath + ".original", layout.journalPath); }
		if (corruption === "private-file") fs.chmodSync(layout.journalPath, 0o644);
		if (corruption === "private-parent") fs.chmodSync(dirname(layout.runRoot), 0o755);
		if (process.platform === "win32" && corruption.startsWith("private")) return;
		bytes = fs.readFileSync(layout.journalPath);
		assert.throws(() => inspectRecovery(root, "run1"));
		assert.deepEqual(fs.readFileSync(layout.journalPath), bytes);
	});
}

test("journal and recovery refuse symlink directory ancestry", t => {
	const { root, layout } = fixture(t);
	fs.renameSync(layout.runRoot, layout.runRoot + "-actual");
	fs.symlinkSync(layout.runRoot + "-actual", layout.runRoot);
	assert.throws(() => inspectJournal(layout.journalPath), /ancestry/);
	assert.throws(() => inspectRecovery(root, "run1"), /ancestry/);
});

test("closed runs can be inspected without a lease or reservation", t => {
	const { root, lease } = fixture(t);
	lease.release({ retainReservation: false });
	const result = inspectRecovery(root, "run1");
	assert.equal(result.lease, null);
	assert.equal(result.leaseIdentity, null);
	assert.equal(result.reservation, null);
});

test("replay validates workspace/run identity and duplicate operation IDs", t => {
	const { root, layout, lease, event } = fixture(t);
	const journal = openJournal(layout.journalPath, lease.assertOwned);
	journal.append(event); journal.close();
	assert.throws(() => inspectRecovery(root, "run1"), { code: "DUPLICATE" });
	fs.unlinkSync(layout.journalPath);
	const foreign = openJournal(layout.journalPath, lease.assertOwned);
	foreign.append({ ...event, payload: { ...event.payload, workspaceRoot: root + "-other" } }); foreign.close();
	assert.throws(() => inspectRecovery(root, "run1"), { code: "IDENTITY" });
});

for (const kind of ["foreign-reservation", "invalid-reservation", "foreign-lease", "invalid-lease", "invalid-pid", "missing-owner", "legacy-owner"]) {
	test(`recovery ownership validation: ${kind}`, t => {
		const { root, layout } = fixture(t);
		const ownerPath = join(layout.ownerPath, "owner.json");
		const owner = JSON.parse(fs.readFileSync(ownerPath));
		if (kind === "foreign-reservation") fs.writeFileSync(layout.reservationPath, JSON.stringify({ version: 1, runId: "other" }));
		if (kind === "invalid-reservation") fs.writeFileSync(layout.reservationPath, JSON.stringify({ version: 1, runId: "run1", extra: true }));
		if (kind === "foreign-lease") fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, runId: "other" }));
		if (kind === "invalid-lease") fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, token: "" }));
		if (kind === "invalid-pid") fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: -1 }));
		if (kind === "missing-owner") fs.unlinkSync(ownerPath);
		if (kind === "legacy-owner") { delete owner.ownerSessionId; delete owner.pid; fs.writeFileSync(ownerPath, JSON.stringify(owner)); assert.equal(inspectRecovery(root, "run1").lease.ownerSessionId, undefined); }
		else assert.throws(() => inspectRecovery(root, "run1"));
	});
}

test("journal inspection refuses content drift while reading", t => {
	const { layout } = fixture(t);
	const read = fs.readFileSync;
	const append = fs.appendFileSync;
	let first = true;
	patchFs(t, { readFileSync(...args) {
		const bytes = read(...args);
		if (first) { first = false; append(layout.journalPath, "\n"); }
		return bytes;
	} });
	assert.throws(() => inspectJournal(layout.journalPath), /changed during inspection/);
});

for (const mutation of ["replace-path", "rewrite-content", "chmod"]) {
	test(`journal refuses ${mutation} during read`, t => {
		const { layout } = fixture(t);
		const read = fs.readFileSync;
		const write = fs.writeFileSync;
		const rename = fs.renameSync;
		const chmod = fs.chmodSync;
		let first = true;
		patchFs(t, { readFileSync(...args) {
			const bytes = read(...args);
			if (first) {
				first = false;
				if (mutation === "replace-path") { rename(layout.journalPath, layout.journalPath + ".old"); write(layout.journalPath, bytes, { mode: 0o600 }); }
				if (mutation === "rewrite-content") write(layout.journalPath, bytes);
				if (mutation === "chmod") chmod(layout.journalPath, 0o644);
			}
			return bytes;
		} });
		assert.throws(() => inspectJournal(layout.journalPath));
	});
}

test("recovery rejects journal drift between replay and final snapshot", t => {
	const { root, layout } = fixture(t);
	const read = fs.readFileSync;
	const write = fs.writeFileSync;
	let reads = 0;
	patchFs(t, { readFileSync(...args) {
		const bytes = read(...args);
		if (++reads === 3) write(layout.journalPath, read(layout.journalPath));
		return bytes;
	} });
	assert.throws(() => inspectRecovery(root, "run1"), /Journal changed during recovery inspection/);
});

test("recovery rejects reservation drift while reading", t => {
	const { root, layout } = fixture(t);
	const read = fs.readFileSync;
	const write = fs.writeFileSync;
	let reads = 0;
	patchFs(t, { readFileSync(...args) {
		const bytes = read(...args);
		if (++reads === 4) write(layout.reservationPath, bytes);
		return bytes;
	} });
	assert.throws(() => inspectRecovery(root, "run1"), /changed during inspection/);
});

test("recovery rereads ownership and detects lease changes", t => {
	const { root, layout } = fixture(t);
	const read = fs.readFileSync;
	const write = fs.writeFileSync;
	const ownerPath = join(layout.ownerPath, "owner.json");
	let reads = 0;
	patchFs(t, { readFileSync(...args) {
		const bytes = read(...args);
		if (++reads === 3) { const owner = JSON.parse(bytes); write(ownerPath, JSON.stringify({ ...owner, token: "changed" })); }
		return bytes;
	} });
	assert.throws(() => inspectRecovery(root, "run1"), /changed during inspection/);
});
