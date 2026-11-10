import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { repository, addSubmodule, commitFixture } from "./helpers.mjs";
import { inspectCheckout } from "../extensions/swarm/host-approval.mjs";
import { SwarmController } from "../extensions/swarm/core.mjs";
import { WorkspaceFiles } from "../extensions/swarm/workspace-files.mjs";
import { WorkspaceRuntime } from "../extensions/swarm/workspace.mjs";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

test("submodule fingerprints cover dirty contents, HEAD and indexed commits without scanning ignored trees", async t => {
	const root = repository(t);
	const module = addSubmodule(t, root);
	const initial = await inspectCheckout(root);
	assert.equal(initial.submodules.length, 1);
	assert.equal(initial.submodules[0].path, "modules/shared");
	assert.equal(initial.submodules[0].initialized, true);
	assert.equal(initial.submodules[0].head, initial.submodules[0].indexedCommits[0].commit);
	assert.match(initial.fingerprintScope, /initialized submodules recursively/);
	assert.equal((await inspectCheckout(root)).fingerprint, initial.fingerprint);

	mkdirSync(join(module, "ignored"));
	writeFileSync(join(module, "ignored", "large.txt"), "x".repeat(1024 * 1024));
	assert.equal((await inspectCheckout(root)).fingerprint, initial.fingerprint);
	writeFileSync(join(module, "tracked.txt"), "first edit\n");
	const dirty = await inspectCheckout(root);
	assert.notEqual(dirty.fingerprint, initial.fingerprint);
	writeFileSync(join(module, "tracked.txt"), "other edit\n");
	const dirtyAgain = await inspectCheckout(root);
	assert.deepEqual(dirtyAgain.changes, dirty.changes);
	assert.notEqual(dirtyAgain.fingerprint, dirty.fingerprint, "dirty-to-dirty edits need content hashes, not status alone");

	writeFileSync(join(module, "new.txt"), "untracked");
	const untracked = await inspectCheckout(root);
	assert.notEqual(untracked.fingerprint, dirtyAgain.fingerprint);
	execFileSync("git", ["-C", module, "add", "."]);
	commitFixture(module);
	const committed = await inspectCheckout(root);
	assert.notEqual(committed.submodules[0].head, initial.submodules[0].head);
	assert.notEqual(committed.fingerprint, untracked.fingerprint);
	execFileSync("git", ["-C", root, "add", "modules/shared"]);
	const indexed = await inspectCheckout(root);
	assert.equal(indexed.submodules[0].head, indexed.submodules[0].indexedCommits[0].commit);
	assert.notEqual(indexed.fingerprint, committed.fingerprint);
});

test("nested submodules have independent recursive Git scopes", async t => {
	const root = repository(t);
	const module = addSubmodule(t, root);
	const nested = addSubmodule(t, module, "nested/leaf");
	const initial = await inspectCheckout(root);
	assert.deepEqual(initial.submodules.map(module => module.path), ["modules/shared", "modules/shared/nested/leaf"]);
	mkdirSync(join(nested, "ignored"));
	writeFileSync(join(nested, "ignored", "output.txt"), "ignored");
	assert.equal((await inspectCheckout(root)).fingerprint, initial.fingerprint);
	writeFileSync(join(nested, "tracked.txt"), "nested edit\n");
	const changed = await inspectCheckout(root);
	assert.notEqual(changed.fingerprint, initial.fingerprint);
	writeFileSync(join(nested, "tracked.txt"), "another edit\n");
	assert.notEqual((await inspectCheckout(root)).fingerprint, changed.fingerprint);
	await assert.rejects(inspectCheckout(root, { additionalPaths: ["modules/shared/nested/leaf/ignored/output.txt"] }), { code: "PATH" });
});

test("missing and empty uninitialized submodules are observed without initialization", async t => {
	const root = repository(t);
	const module = addSubmodule(t, root);
	execFileSync("git", ["-C", root, "submodule", "deinit", "--force", "--", "modules/shared"]);
	const uninitialized = await inspectCheckout(root);
	assert.equal(uninitialized.submodules[0].initialized, false);
	assert.equal(uninitialized.submodules[0].head, null);
	assert.equal(existsSync(join(module, ".git")), false);
	rmSync(module, { recursive: true });
	const missing = await inspectCheckout(root);
	assert.equal(missing.submodules[0].initialized, false);
	assert.notEqual(missing.fingerprint, uninitialized.fingerprint);
	assert.equal(existsSync(module), false);
	const files = new WorkspaceFiles(root, { submodulePaths: ["modules/shared"] });
	assert.throws(() => files.path("modules/shared/new.txt"), { code: "PATH" });
	if (process.platform === "win32") {
		for (const path of ["modules/shared./new.txt", "modules/shared /new.txt"]) {
			assert.throws(() => files.path(path), { code: "PATH" });
			await assert.rejects(inspectCheckout(root, { additionalPaths: [path] }), { code: "PATH" });
		}
	}
	mkdirSync(module);
	writeFileSync(join(module, "unexpected.txt"), "unknown checkout contents");
	await assert.rejects(inspectCheckout(root), { code: "PATH", phase: "inspection" });
});

test("nonempty uninitialized submodule inspection remains cancellable and off-thread", async t => {
	const root = repository(t);
	const module = addSubmodule(t, root);
	execFileSync("git", ["-C", root, "submodule", "deinit", "--force", "--", "modules/shared"]);
	for (let i = 0; i < 256; i++) writeFileSync(join(module, `${i}.txt`), "unknown checkout contents");
	let ticks = 0;
	const interval = setInterval(() => ticks++, 1);
	try { await assert.rejects(inspectCheckout(root), { code: "PATH", phase: "inspection" }); }
	finally { clearInterval(interval); }
	assert.ok(ticks > 0, "host timers must run during submodule validation");
	const cancel = new AbortController();
	const pending = inspectCheckout(root, { signal: cancel.signal });
	const rejected = assert.rejects(pending, { code: "CANCELLED", phase: "inspection" });
	setTimeout(() => cancel.abort(), 0);
	await rejected;
});

test("submodule aliases and replaced ancestors fail closed", async t => {
	const root = repository(t);
	const module = addSubmodule(t, root);
	const outside = repository(t);
	writeFileSync(join(outside, "tracked.txt"), "outside content");
	rmSync(module, { recursive: true });
	symlinkSync(outside, module, "junction");
	await assert.rejects(inspectCheckout(root), { code: "PATH", phase: "inspection" });
	rmSync(module);
	const modules = join(root, "modules");
	renameSync(modules, join(root, "saved-modules"));
	symlinkSync(outside, modules, "junction");
	await assert.rejects(inspectCheckout(root), { code: "PATH", phase: "inspection" });
	assert.equal(readFileSync(join(outside, "tracked.txt"), "utf8"), "outside content");
});

test("submodule worker reads are allowed but claims, edits and writes remain outside the parent workspace", async t => {
	const root = repository(t);
	const module = addSubmodule(t, root);
	const original = readFileSync(join(module, "tracked.txt"), "utf8");
	const c = await SwarmController.open({ workspace: root, runId: "submodules", ownerSessionId: "owner", create: { objective: "Update parent", criteria: ["Works"], scope: ["."] } });
	t.after(async () => { await c.close(); });
	const runtime = await WorkspaceRuntime.attach(c, { authorize: async () => true });
	await c.owner("run.resume", { reconciled: true });
	await c.owner("worker.create", { id: "builder", specialization: "Implementation", brief: "Update parent", reason: "Independent implementation", workloadRevision: c.snapshot().revision });
	await c.owner("task.create", { id: "parent", title: "Update parent", criteria: [0], dependencies: [] });
	await c.worker("builder").dispatch("task.claim", { taskId: "parent", kind: "build", assignmentId: "build" });
	const worker = runtime.worker("builder");
	const target = "modules/shared/tracked.txt";
	const read = await worker.read(target);
	assert.match(JSON.stringify(read.content), /original/);
	assert.throws(() => worker.claim([target]), { code: "PATH" });
	await assert.rejects(worker.edit(target, [{ oldText: "original", newText: "changed" }]), { code: "PATH" });
	await assert.rejects(worker.write("modules/shared/new.txt", "changed"), { code: "PATH" });
	assert.equal(readFileSync(join(module, "tracked.txt"), "utf8"), original);
	assert.equal(existsSync(join(module, "new.txt")), false);
	assert.equal(c.snapshot().workspace.operations.length, 0);
	await c.owner("run.pause");
	await runtime.settle("parent");
	await c.system("run.settle");
});

test("newly introduced nested repositories cannot bypass mutation guards", t => {
	const root = repository(t);
	const files = new WorkspaceFiles(root);
	const module = addSubmodule(t, root);
	assert.throws(() => files.path("modules/shared/new.txt"), { code: "PATH" });
	assert.throws(() => files.path(join(module, "tracked.txt")), { code: "PATH" });
	assert.equal(files.path("modules/shared/tracked.txt", { allowSubmodules: true }), "modules/shared/tracked.txt");
	if (process.platform === "win32") {
		const scoped = new WorkspaceFiles(root, { submodulePaths: ["modules/shared"] });
		assert.throws(() => scoped.path("MODULES\\SHARED\\new.txt"), { code: "PATH" });
	}
});

test("deep submodule snapshots make two whole-tree passes rather than exponential nested passes", t => {
	const root = repository(t);
	const depth = 12;
	let current = root;
	const modules = [];
	for (let i = 0; i < depth; i++) {
		current = join(current, "child");
		mkdirSync(join(current, ".git"), { recursive: true });
		writeFileSync(join(current, ".git", "HEAD"), "fixture\n");
		modules.push({ path: "child", entries: [{ commit: "a".repeat(40), stage: 0 }], head: "a".repeat(40), checkout: { paths: ["child"], submodules: [] } });
		if (i > 0) modules[i - 1].checkout.submodules.push(modules[i]);
	}
	writeFileSync(join(current, "leaf.txt"), "tracked leaf");
	modules.at(-1).checkout.paths = ["leaf.txt"];
	const files = new WorkspaceFiles(root);
	const options = { paths: ["child"], submodules: [modules[0]] };
	const original = WorkspaceFiles.prototype.submoduleRoot;
	let visits = 0;
	WorkspaceFiles.prototype.submoduleRoot = function (path) { visits++; return original.call(this, path); };
	try {
		const before = files.snapshot(options);
		assert.equal(visits, depth * 2, "each submodule is visited once per complete-tree pass");
		writeFileSync(join(current, "leaf.txt"), "changed leaf");
		assert.notEqual(files.snapshot(options), before);
	} finally { WorkspaceFiles.prototype.submoduleRoot = original; }
});

test("ordinary tracked files replaced with directories are not mistaken for submodules", async t => {
	const root = repository(t);
	writeFileSync(join(root, "tracked.txt"), "tracked");
	execFileSync("git", ["-C", root, "add", "tracked.txt"]);
	rmSync(join(root, "tracked.txt"));
	mkdirSync(join(root, "tracked.txt"));
	writeFileSync(join(root, "tracked.txt", "nested.txt"), "unexpected directory");
	await assert.rejects(inspectCheckout(root), { code: "PATH", phase: "inspection" });
});
