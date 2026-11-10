import test from "node:test";
import { join, parse } from "node:path";
import assert from "node:assert/strict";
import { repository } from "./helpers.mjs";
import { execFileSync } from "node:child_process";
import { WorkspaceFiles, hash } from "../extensions/swarm/workspace-files.mjs";
import { WorkspaceScheduler } from "../extensions/swarm/workspace-scheduler.mjs";
import { mkdirSync, writeFileSync, symlinkSync, linkSync, chmodSync, renameSync } from "node:fs";

test("read-only fingerprints cover files, modes, ignored files and Git index without writes", t => {
 const root = repository(t);
 const files = new WorkspaceFiles(root);
 writeFileSync(join(root, "source.txt"), "original");
 const first = files.fingerprint("source.txt");
 assert.equal(files.path("./source.txt"), "source.txt");
 assert.equal(files.fingerprint("source.txt"), first);
 writeFileSync(join(root, "source.txt"), "external");
 assert.notEqual(files.fingerprint("source.txt"), first);
 const beforeMode = files.snapshot(); chmodSync(join(root, "source.txt"), 0o600);
 if (process.platform !== "win32") assert.notEqual(files.snapshot(), beforeMode);
 const beforeIgnored = files.snapshot(); writeFileSync(join(root, "ignored.txt"), "work");
 assert.notEqual(files.snapshot(), beforeIgnored);
 const beforeIndex = files.snapshot(); execFileSync("git", ["-C", root, "add", "source.txt"]);
 assert.notEqual(files.snapshot(), beforeIndex);
 assert.equal(hash("hello"), hash(Buffer.from("hello")));
});

test("path guard refuses traversal, control files, symlinks and hardlinks", t => {
 const root = repository(t); const files = new WorkspaceFiles(root, { protectedPaths: ["private"] });
 writeFileSync(join(root, "file"), "data");
 symlinkSync(join(root, "file"), join(root, "alias"));
 linkSync(join(root, "file"), join(root, "hard"));
 for (const path of ["../outside", ".git/config", "private/a", "alias", "hard", ""]) assert.throws(() => files.path(path));
});

test("snapshots work without Git and detect a replaced root", t => {
 const root = repository(t); const project = join(root, "plain"); mkdirSync(project);
 const files = new WorkspaceFiles(project); const first = files.snapshot();
 writeFileSync(join(project, "work.txt"), "work"); assert.notEqual(files.snapshot(), first);
 renameSync(project, join(root, "previous")); mkdirSync(project);
 assert.throws(() => files.snapshot(), /identity changed/);
});

test("nested file paths produce scheduler identities while preserving IO spelling", async t => {
 const root = repository(t);
 const files = new WorkspaceFiles(root);
 mkdirSync(join(root, "Source"));
 writeFileSync(join(root, "Source", "File.txt"), "data");
 const target = join(root, "Source", "File.txt");
 assert.equal(files.path(target), "Source/File.txt");
 const identity = files.identity(target);
 assert.equal(identity, process.platform === "win32" ? "source/file.txt" : "Source/File.txt");
 const scheduler = new WorkspaceScheduler();
 scheduler.acquireClaims("owner", [identity]);
 assert.throws(() => scheduler.acquireClaims("other", [files.identity("Source/File.txt")]), { code: "CLAIM_CONFLICT" });
 await scheduler.withMutation("owner", [files.identity(target)], () => {});
 scheduler.releaseClaims("owner");
 scheduler.acquireClaims("ancestor", [files.identity("Missing")]);
 assert.throws(() => scheduler.acquireClaims("child", [files.identity(join("Missing", "child.txt"))]), { code: "CLAIM_CONFLICT" });
 if (process.platform === "win32") {
  assert.equal(files.identity("SOURCE\\File.txt"), identity);
  assert.throws(() => files.path(".GIT/config"), { code: "PATH" });
  assert.throws(() => files.path("\\\\server\\share\\outside.txt"), { code: "PATH" });
  const drive = parse(root).root.slice(0, 1).toUpperCase() === "Z" ? "Y" : "Z";
  assert.throws(() => files.path(`${drive}:\\outside.txt`), { code: "PATH" });
 }
});

test("native coding definitions retain SDK schemas, renderers and output metadata", async () => {
 const { codingDefinitions } = await import("../extensions/swarm/session-tools.mjs");
 const tools = codingDefinitions(process.cwd());
 assert.deepEqual(tools.map(tool => tool.name), ["read", "edit", "write", "bash"]);
 assert.ok(tools.every(tool => typeof tool.execute === "function" && typeof tool.renderCall === "function"));
 assert.ok(tools[0].parameters.properties.limit);
 assert.ok(tools[3].parameters.properties.timeout);
});
