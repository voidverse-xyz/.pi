#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "extensions", "prune", "index.ts");
const helpers = await import(EXTENSION);

function registerPruneExtension() {
	let command;
	const pi = {
		registerCommand(name, definition) {
			assert.equal(name, "prune");
			command = definition;
		},
	};
	helpers.default(pi);
	assert.ok(command);
	return command;
}

function createCommandContext(sessionFile, options = {}) {
	const oldNotifications = [];
	const newNotifications = [];
	let newSessionCalls = 0;
	const context = {
		sessionManager: {
			getSessionFile: () => sessionFile,
		},
		ui: {
			notify(message, type) {
				oldNotifications.push({ message, type });
			},
		},
		async newSession(config) {
			newSessionCalls += 1;
			if (options.cancelled) return { cancelled: true };
			await config.withSession({
				ui: {
					notify(message, type) {
						newNotifications.push({ message, type });
					},
				},
			});
			return { cancelled: false };
		},
	};
	return {
		context,
		oldNotifications,
		newNotifications,
		getNewSessionCalls: () => newSessionCalls,
	};
}

function fakeOperations(overrides = {}) {
	return {
		exists: () => true,
		moveToTrash: () => ({ status: 1, stderr: "trash unavailable" }),
		unlink: async () => {},
		...overrides,
	};
}

test("/prune rejects arguments without replacing the session", async () => {
	const command = registerPruneExtension();
	const fixture = createCommandContext("/tmp/session.jsonl");

	await command.handler("unexpected", fixture.context);

	assert.equal(fixture.getNewSessionCalls(), 0);
	assert.deepEqual(fixture.oldNotifications, [{ message: "Usage: /prune", type: "warning" }]);
});

test("/prune leaves the current session untouched when replacement is cancelled", async () => {
	const command = registerPruneExtension();
	const fixture = createCommandContext("/tmp/session.jsonl", { cancelled: true });

	await command.handler("", fixture.context);

	assert.equal(fixture.getNewSessionCalls(), 1);
	assert.deepEqual(fixture.oldNotifications, [{ message: "Prune cancelled", type: "info" }]);
	assert.deepEqual(fixture.newNotifications, []);
});

test("/prune switches in-memory sessions without attempting file deletion", async () => {
	const command = registerPruneExtension();
	const fixture = createCommandContext(undefined);

	await command.handler("", fixture.context);

	assert.equal(fixture.getNewSessionCalls(), 1);
	assert.deepEqual(fixture.oldNotifications, []);
	assert.deepEqual(fixture.newNotifications, [
		{ message: "New session started; previous session was not persisted", type: "info" },
	]);
});

test("/prune deletes only after the replacement session is active", async () => {
	const command = registerPruneExtension();
	const fixture = createCommandContext("/path/that/is/already/absent/session.jsonl");

	await command.handler("", fixture.context);

	assert.equal(fixture.getNewSessionCalls(), 1);
	assert.deepEqual(fixture.oldNotifications, []);
	assert.deepEqual(fixture.newNotifications, [
		{ message: "New session started; previous session file was already absent", type: "info" },
	]);
});

test("deleteSessionFile reports a successful trash move", async () => {
	let exists = true;
	let unlinkCalled = false;
	const result = await helpers.deleteSessionFile(
		"session.jsonl",
		fakeOperations({
			exists: () => exists,
			moveToTrash: () => {
				exists = false;
				return { status: 0 };
			},
			unlink: async () => {
				unlinkCalled = true;
			},
		}),
	);

	assert.deepEqual(result, { ok: true, method: "trash" });
	assert.equal(unlinkCalled, false);
});

test("deleteSessionFile falls back to permanent deletion", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-prune-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionFile = join(directory, "session.jsonl");
	await writeFile(sessionFile, "session\n", "utf8");

	const result = await helpers.deleteSessionFile(
		sessionFile,
		fakeOperations({ exists: existsSync, unlink }),
	);

	assert.deepEqual(result, { ok: true, method: "unlink" });
	assert.equal(existsSync(sessionFile), false);
});

test("deleteSessionFile preserves both deletion errors", async () => {
	const result = await helpers.deleteSessionFile(
		"session.jsonl",
		fakeOperations({
			moveToTrash: () => ({ status: 1, error: "command missing", stderr: "trash failed\nmore" }),
			unlink: async () => {
				throw new Error("unlink denied");
			},
		}),
	);

	assert.deepEqual(result, {
		ok: false,
		error: "unlink denied (trash: command missing · trash failed)",
	});
});

test("/prune replaces and deletes a real persisted RPC session", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-prune-rpc-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDir = join(directory, "agent");
	const sessionDir = join(directory, "sessions");
	const binDir = join(directory, "bin");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
		mkdir(binDir, { recursive: true }),
	]);

	const fakeTrash = join(binDir, "trash");
	await writeFile(fakeTrash, "#!/bin/sh\nexit 1\n", "utf8");
	await chmod(fakeTrash, 0o755);

	const child = spawn(
		process.env.PI_BIN ?? "pi",
		[
			"--mode",
			"rpc",
			"--offline",
			"--session-dir",
			sessionDir,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-e",
			EXTENSION,
		],
		{
			cwd: directory,
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				PI_CODING_AGENT_DIR: agentDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	let output = "";
	let errorOutput = "";
	let buffer = "";
	const records = [];
	const waiters = new Map();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		errorOutput += chunk;
	});
	child.stdout.on("data", (chunk) => {
		output += chunk;
		buffer += chunk;
		while (buffer.includes("\n")) {
			const newline = buffer.indexOf("\n");
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const record = JSON.parse(line);
			records.push(record);
			const resolve = record.id ? waiters.get(record.id) : undefined;
			if (resolve) {
				waiters.delete(record.id);
				resolve(record);
			}
		}
	});

	const waitForResponse = (id) => {
		const existing = records.find((record) => record.id === id);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				waiters.delete(id);
				reject(new Error(`Timed out waiting for ${id}: ${output}\n${errorOutput}`));
			}, 10_000);
			waiters.set(id, (record) => {
				clearTimeout(timeout);
				resolve(record);
			});
		});
	};
	const send = async (command) => {
		child.stdin.write(`${JSON.stringify(command)}\n`);
		return waitForResponse(command.id);
	};

	const spawnError = await new Promise((resolve) => {
		child.once("spawn", () => resolve(undefined));
		child.once("error", resolve);
	});
	if (spawnError?.code === "ENOENT") {
		t.skip("Pi executable not found; set PI_BIN to run the binary runtime test.");
		return;
	}
	assert.ifError(spawnError);

	const before = await send({ id: "before", type: "get_state" });
	const prune = await send({ id: "prune", type: "prompt", message: "/prune" });
	const after = await send({ id: "after", type: "get_state" });
	child.stdin.end();
	const exitCode = await new Promise((resolve) => child.once("close", resolve));

	assert.equal(exitCode, 0, errorOutput || output);
	assert.equal(before.success, true, output);
	assert.equal(prune.success, true, output);
	assert.equal(after.success, true, output);

	const previousSessionFile = before.data.sessionFile;
	const replacementSessionFile = after.data.sessionFile;
	assert.ok(previousSessionFile);
	assert.ok(replacementSessionFile);
	assert.notEqual(replacementSessionFile, previousSessionFile);
	assert.equal(dirname(replacementSessionFile), sessionDir);
	assert.equal(existsSync(previousSessionFile), false);
});

test("extension loads in the installed Pi runtime", (t) => {
	const rpc = spawnSync(
		process.env.PI_BIN ?? "pi",
		[
			"--mode",
			"rpc",
			"--no-session",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-e",
			EXTENSION,
		],
		{
			encoding: "utf8",
			input: '{"id":"load-check","type":"get_state"}\n',
			timeout: 15_000,
		},
	);
	if (rpc.error?.code === "ENOENT") {
		t.skip("Pi executable not found; set PI_BIN to run the binary runtime load test.");
		return;
	}
	assert.ifError(rpc.error);
	assert.equal(rpc.status, 0, rpc.stderr || rpc.stdout);

	const records = rpc.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const response = records.find((record) => record.id === "load-check");
	assert.equal(response?.success, true, `missing successful get_state response: ${rpc.stdout}`);
	assert.equal(records.some((record) => record.type === "extension_error"), false, rpc.stdout);
});
