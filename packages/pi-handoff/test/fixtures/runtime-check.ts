import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

import handoffExtension from "../../extensions/handoff/index.ts";
import { persistHandoffSession } from "../../extensions/handoff/persistence.ts";

const usage = {
	input: 10_000, output: 500, cacheRead: 2_000, cacheWrite: 100, totalTokens: 12_600,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const response = {
	role: "assistant", api: "test", provider: "test", model: "test-model",
	content: [{ type: "text", text: "## Goal\nGenerated summary" }],
	usage, stopReason: "stop", timestamp: 0,
};

function registerHandoff() {
	let command: any;
	handoffExtension({
		registerCommand(name: string, definition: any) {
			assert.equal(name, "handoff");
			command = definition;
		},
	} as ExtensionAPI);
	return command;
}

function createFixture(directory: string, options: any = {}) {
	const source = options.ephemeral
		? SessionManager.inMemory(directory)
		: SessionManager.create(directory, directory);
	source.appendMessage({ role: "user", content: "Continue the unfinished work", timestamp: 0 });
	source.appendMessage(response as any);
	source.appendSessionInfo("Original session");
	const sourceFile = source.getSessionFile();
	const sourceBytes = sourceFile ? readFileSync(sourceFile, "utf8") : undefined;
	const notices: { text: string; type: string }[] = [];
	let replacement: SessionManager | undefined;
	let switched = false;
	let newSessionCalls = 0;
	let editorCalls = 0;
	let requestCalls = 0;
	let waitedForIdle = false;
	let requestSignal: AbortSignal | undefined;

	const context: any = {
		mode: options.mode ?? "tui",
		model: options.noModel ? undefined : { id: "test-model" },
		sessionManager: source,
		waitForIdle: async () => { waitedForIdle = true; },
		getContextUsage: () => ({ tokens: 42 }),
		modelRegistry: {
			async complete(_model: any, request: any, config: any) {
				requestCalls++;
				assert.equal(waitedForIdle, true);
				assert.match(request.messages[0].content[0].text, /Continue the unfinished work/);
				assert.equal(config.maxTokens, 6_000);
				assert.equal(config.cacheRetention, "none");
				requestSignal = config.signal;
				if (options.cancelGeneration) {
					await new Promise<void>((resolve) => config.signal.addEventListener("abort", () => resolve(), { once: true }));
				}
				if (options.throwError) throw new Error("Request rejected");
				return options.response ?? response;
			},
		},
		ui: {
			notify(text: string, type: string) {
				assert.equal(switched, false, "old UI must not be used after replacement");
				notices.push({ text, type });
			},
			async editor(_title: string, text: string) {
				editorCalls++;
				assert.equal(text, "## Goal\nGenerated summary");
				if (options.cancelEditor) return undefined;
				return options.emptyEditor ? "  " : "  ## Goal\nReviewed summary  ";
			},
			custom(factory: any) {
				return new Promise((resolve) => {
					let closed = false;
					let loader: any;
					const done = (value: any) => {
						if (closed) return;
						closed = true;
						loader?.dispose();
						resolve(value);
					};
					loader = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, done);
					if (options.cancelGeneration) loader.handleInput("\x1b");
				});
			},
		},
		async newSession(config: any) {
			newSessionCalls++;
			if (options.cancelSession) return { cancelled: true };
			replacement = options.ephemeral
				? SessionManager.inMemory(directory)
				: SessionManager.create(directory, directory);
			replacement.newSession({ parentSession: config.parentSession });
			await config.setup(replacement);
			switched = true;
			await config.withSession({ ui: { notify(text: string, type: string) { notices.push({ text, type }); } } });
			return { cancelled: false };
		},
	};
	return {
		context, notices, source,
		get replacement() { return replacement; },
		get newSessionCalls() { return newSessionCalls; },
		get editorCalls() { return editorCalls; },
		get requestCalls() { return requestCalls; },
		get requestSignal() { return requestSignal; },
		assertSourceUnchanged() {
			if (sourceFile) assert.equal(readFileSync(sourceFile, "utf8"), sourceBytes);
		},
	};
}

async function runChecks(directory: string) {
	const command = registerHandoff();
	const success = createFixture(directory);
	await command.handler("finish the task", success.context);
	success.assertSourceUnchanged();
	assert.equal(success.newSessionCalls, 1);
	assert.equal(success.requestCalls, 1, "no automatic continuation request");
	assert.equal(success.editorCalls, 1);
	const replacement = success.replacement!;
	const sessionFile = replacement.getSessionFile()!;
	assert.ok(existsSync(sessionFile), "handoff must survive exit before any assistant reply");
	if (process.platform !== "win32") assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
	const reopened = SessionManager.open(sessionFile);
	assert.equal(reopened.getSessionName(), "Handoff: Original session");
	assert.equal(reopened.getHeader()?.parentSession, success.source.getSessionFile());
	assert.equal(reopened.buildSessionContext().messages.length, 1);
	assert.equal(reopened.buildSessionContext().messages[0].role, "custom", "do not fabricate assistant usage");
	const handoff = reopened.getEntries().find((entry) => entry.type === "custom_message")!;
	assert.equal(handoff.content, "## Goal\nReviewed summary");
	assert.deepEqual((handoff.details as any).summaryUsage, usage);
	assert.equal((handoff.details as any).sourceContextTokens, 42);
	assert.equal((handoff.details as any).focus, "finish the task");
	assert.ok((handoff.details as any).summaryInputTokensEstimate > 0);

	// A second flush must not rewrite the file, and future appends must neither
	// recreate it nor duplicate its header or handoff entry.
	const snapshot = readFileSync(sessionFile, "utf8");
	persistHandoffSession(replacement);
	assert.equal(readFileSync(sessionFile, "utf8"), snapshot);
	replacement.appendMessage({ role: "user", content: "Continue", timestamp: 1 });
	assert.equal(SessionManager.open(sessionFile).buildSessionContext().messages.length, 2);
	replacement.appendMessage(response as any);
	const records = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records.filter((entry) => entry.type === "session").length, 1);
	assert.equal(records.filter((entry) => entry.type === "custom_message").length, 1);
	assert.equal(SessionManager.open(sessionFile).buildSessionContext().messages.length, 3);

	for (const partialText of ["Partial summary", ""]) {
		const failure = createFixture(directory, {
			response: { ...response, stopReason: "error", errorMessage: "Stream interrupted", content: [{ type: "text", text: partialText }] },
		});
		await command.handler("", failure.context);
		assert.equal(failure.editorCalls, 0);
		assert.equal(failure.newSessionCalls, 0);
		assert.ok(failure.notices.some((notice) => notice.type === "error" && notice.text.includes("Stream interrupted")));
		failure.assertSourceUnchanged();
	}
	for (const options of [
		{ response: { ...response, stopReason: "length" } },
		{ response: { ...response, stopReason: "aborted" } },
		{ response: { ...response, content: [] } },
		{ throwError: true },
		{ cancelGeneration: true },
	]) {
		const failure = createFixture(directory, options);
		await command.handler("", failure.context);
		assert.equal(failure.editorCalls, 0);
		assert.equal(failure.newSessionCalls, 0);
		if (options.cancelGeneration) assert.equal(failure.requestSignal?.aborted, true);
		failure.assertSourceUnchanged();
	}
	for (const options of [{ cancelEditor: true }, { emptyEditor: true }, { cancelSession: true }]) {
		const cancelled = createFixture(directory, options);
		await command.handler("", cancelled.context);
		assert.equal(cancelled.newSessionCalls, options.cancelSession ? 1 : 0);
		assert.equal(cancelled.replacement, undefined);
		cancelled.assertSourceUnchanged();
	}
	for (const options of [{ mode: "rpc" }, { noModel: true }]) {
		const unavailable = createFixture(directory, options);
		await command.handler("", unavailable.context);
		assert.equal(unavailable.requestCalls, 0);
		assert.equal(unavailable.newSessionCalls, 0);
	}

	const filesBefore = readdirSync(directory);
	const ephemeral = createFixture(directory, { ephemeral: true });
	await command.handler("", ephemeral.context);
	assert.equal(ephemeral.replacement?.getSessionFile(), undefined);
	assert.deepEqual(readdirSync(directory), filesBefore, "in-memory handoffs must not write files");

	const collision = SessionManager.create(directory, directory);
	collision.appendCustomMessageEntry("handoff", "Do not lose this summary", true);
	writeFileSync(collision.getSessionFile()!, "unrelated file\n", { flag: "wx" });
	assert.throws(() => persistHandoffSession(collision), /different data/);
	assert.equal(readFileSync(collision.getSessionFile()!, "utf8"), "unrelated file\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff-regression-check", {
		description: "Run offline handoff regression checks with the installed runtime",
		handler: async (_args, ctx) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-handoff-regression-"));
			try {
				await runChecks(directory);
				ctx.ui.notify("Handoff regression checks passed", "info");
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	});
}
