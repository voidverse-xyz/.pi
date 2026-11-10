import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { finishTrial } from "./report.mjs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const files = ["csv.mjs", "csv.test.mjs"];
const limits = { agents: 2, active: 2, tasks: 5, attempts: 1, durationMs: 300000 };

// Default invocation neither imports the SDK nor opens native configuration.
if (!args.includes("--live")) {
	console.log("Dry run: no configuration, credentials, project, or provider opened. See README.md for explicit live approval and source-review protocol.");
} else {
	try { await trial(); }
	catch (error) {
		failure("setup", error);
	}
}

async function trial() {
	for (const name of ["--provider", "--model", "--thinking"]) {
		if (!args.includes(name) || !option(name) || option(name).startsWith("--")) throw new Error(`Explicit ${name} required`);
	}
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { createNativeRuntime } = await import("../../extensions/swarm/native-provider.mjs");
	const { SwarmHost } = await import("../../extensions/swarm/host.mjs");
	const source = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
	const mainModel = source.getModel(option("--provider"), option("--model"));
	if (!mainModel || mainModel.api === "pi-virtual" || mainModel.type !== "chat") throw new Error("Exact physical model unavailable; no substitution");
	const available = await source.getAvailable(mainModel.provider);
	if (!available.some(model => model.id === mainModel.id)) throw new Error("Selected model unavailable; no substitution");
	const auth = await source.checkAuth(mainModel.provider);
	if (!auth?.type) throw new Error("Native authentication unavailable");
	const native = await createNativeRuntime({ modelRuntime: source, mainModel, thinkingLevel: option("--thinking") });
	const root = mkdtempSync("/tmp/swarm-trial-");
	const workspace = join(root, "project");
	mkdirSync(workspace, { mode: 0o700 });
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { mode: 0o700 });
	process.env.PI_CODING_AGENT_DIR = agentDir; // Runtime already references explicitly authorized credentials.
	writeFileSync(join(workspace, "csv.mjs"), "export function parseCsv(text) { throw new Error('Not implemented'); }\n");
	writeFileSync(join(workspace, "csv.test.mjs"), "// Add dependency-free node:test coverage.\n");
	execFileSync("git", ["init", "-q", workspace]);
	execFileSync("git", ["-C", workspace, "add", ...files]);
	const events = new EventEmitter();
	const mode = { version: 1, instanceId: "bounded-host-policy", revision: 1, contextRevision: 1,
		ready: true, sessionId: "trial-owner", selectedMode: "off", enforcedMode: "off", runMode: null, pendingChange: false };
	// This standalone host implements scoped prior authorization, not a simulated human UI.
	events.on("pi-plan:query-mode", request => request.respond({ ...mode }));
	events.on("swarm:confirm-request", packet => packet.claim(async () => {
		const request = packet.request;
		if (["write", "edit"].includes(request.tool)) return { approved: files.some(file => request.path === resolve(workspace, file)) };
		if (request.tool !== "bash" || request.command !== "node --test") return { approved: false };
		const fingerprint = sourceFingerprint(workspace);
		writeFileSync(join(root, "pending-check.json"), JSON.stringify({ command: request.command, fingerprint }) + "\n", { mode: 0o600 });
		while (!request.signal.aborted) {
			if (existsSync(join(root, "approved-check.json"))) {
				const answer = JSON.parse(readFileSync(join(root, "approved-check.json"), "utf8"));
				if (answer.fingerprint === fingerprint && sourceFingerprint(workspace) === fingerprint) return { approved: true };
			}
			await delay(100);
		}
		return { approved: false };
	}));
	const instructions = "Implement only csv.mjs and csv.test.mjs. No other writes. Only command allowed is exactly node --test, subject to host source inspection. No networking, package installs, subprocesses, filesystem/environment access, dynamic imports, eval, global paths, commits or cleanup. Tests may import only node:test, node:assert/strict and ./csv.mjs. Parser must be pure JavaScript with no imports. Use one build task covering parser AND tests, and an independent non-writing reviewer. Builder recruits reviewer (total two identities). Reviewer sends focused edge-case suggestions by peer message, then reviews the submitted candidate without writing. Builder authors parser and tests so reviewer remains independent. Report then stop; host owns final verification. Shell approval can take time: do not bypass it or create replacement tasks. Empty input -> []; comma-separated fields, CRLF/LF records, quoted commas/newlines and doubled quotes, trailing empty fields; terminal newline creates no extra row; unterminated quotes throw. Preserve whitespace. Export parseCsv(text).";
	let approved = false;
	const host = new SwarmHost({ ...native, events, sessionId: "trial-owner", instructions, safetyTimeoutMs: 120000,
		requestApproval(request) {
			if (approved || request.action !== "launch" || JSON.stringify(request.specification.limits) !== JSON.stringify(limits)) return { approved: false };
			approved = true;
			return { approved: true, existingChanges: "preserve" };
		} });
	console.log(JSON.stringify({ fixture: root, provider: mainModel.provider, model: mainModel.id, limits }));
	let started;
	let deadline;
	try {
		await host.launch({ workspace, runId: "csv-trial", specification: {
			objective: "Implement a small dependency-free CSV parser and tests, collaborating with an independent reviewer.",
			criteria: ["parseCsv implements the specified CSV edge cases with passing node:test coverage and independent review"],
			scope: ["Synthetic csv.mjs and csv.test.mjs only"], limits,
		} });
		started = Date.now();
		deadline = setTimeout(() => { void host.pause({ stop: true, timeoutMs: 10000 }).catch(error => failure("cleanup", error)); }, limits.durationMs);
		await host.recruit({ id: "builder", specialization: "CSV implementation and tests", brief: "Own one build task and author parser and tests. Recruit an independent reviewer before implementation; ask for edge-case guidance. Submit using the successful node --test execution receipt, then stop.", reason: "Implement approved synthetic parser with independent peer review" });
		host.wake("builder");
		await host.idle();
		let state = host.snapshot().run;
		if (state.status === "running" && state.tasks.some(task => task.status === "submitted")) {
			const reviewer = state.workers.find(worker => !state.workspace.contributors.includes(worker.id));
			if (reviewer) { host.wake(reviewer.id, "Candidate settled; independently review the submitted task, then stop"); await host.idle(); }
		}
		state = host.snapshot().run;
		if (state.status === "running" && state.tasks.length && state.tasks.every(task => task.status === "done")) await host.finalCheck("node --test");
	} catch (error) {
		// Native exception text may contain provider configuration. Never print it.
		failure("execution", error);
	} finally {
		clearTimeout(deadline);
		await finishTrial({ host, started, onFailure: failure, writeResult(result) {
			writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
			console.log(JSON.stringify(result));
		} });
	}
}

function failure(phase, error) {
	console.log(JSON.stringify({ failure: true, phase, code: /^[A-Z_]+$/.test(error.code ?? "") ? error.code : "TRIAL_ERROR" }));
	process.exitCode = phase === "cleanup" ? 2 : 1;
}

function sourceFingerprint(workspace) {
	const hash = createHash("sha256");
	for (const file of files) hash.update(file).update("\0").update(readFileSync(join(workspace, file))).update("\0");
	return hash.digest("hex");
}
