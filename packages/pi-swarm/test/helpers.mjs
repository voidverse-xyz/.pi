import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_LIMITS, reduceEvent } from "../extensions/swarm/state.mjs";

const testAgentDir = mkdtempSync(join(tmpdir(), "swarm-test-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(() => rmSync(testAgentDir, { recursive: true, force: true }));

export function repository(t, ignored = true) {
	const root = mkdtempSync(join(tmpdir(), "swarm-foundation-"));
	execFileSync("git", ["init", "--quiet", "--initial-branch=main", root]);
	if (ignored) writeFileSync(join(root, ".gitignore"), "/.swarms/\n");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

/** A local-only Git submodule fixture; never fetches a remote repository. */
export function addSubmodule(t, root, path = "modules/shared") {
	const source = repository(t, false);
	writeFileSync(join(source, ".gitignore"), "/ignored/\n");
	writeFileSync(join(source, "tracked.txt"), "original\n");
	execFileSync("git", ["-C", source, "add", "."]);
	commitFixture(source);
	execFileSync("git", ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", "--", source, path]);
	return join(root, path);
}

export function commitFixture(root) {
	execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${join(root, ".git", "swarm-fixture-no-hooks")}`, "commit", "--quiet", "-m", "Fixture"]);
}

export function machine(overrides = {}) {
	let state = null;
	let serial = 0;
	let now = 0;
	const events = [];
	function send(actor, type, payload = {}, extra = {}) {
		const event = {
			version: 1, operationId: `op-${++serial}`, actor, type, payload,
			expectedRevision: state?.revision ?? 0, cycle: state?.cycle ?? 1,
			generation: state?.generation ?? 0, atMs: now, ...extra,
		};
		state = reduceEvent(state, event);
		events.push(event);
		return state;
	}
	send("owner", "run.create", { runId: "run1", ownerSessionId: "session1", workspaceRoot: "/project", objective: "Build invitations", criteria: ["Invitations work"], scope: ["src"], limits: { ...DEFAULT_LIMITS, ...overrides } });
	return {
		send, events,
		get state() { return state; },
		set time(value) { now = value; },
		start() { send("owner", "run.resume", { reconciled: true }); },
		worker(id) { send("owner", "worker.create", { id, specialization: `specialist ${id}`, brief: "Focused project work", reason: "Independent work needs this specialization", workloadRevision: state.revision }); },
		task(id, dependencies = []) { send("owner", "task.create", { id, title: id, criteria: [0], dependencies }); },
		claim(worker, taskId, kind = "build") { send(worker, "task.claim", { taskId, kind, assignmentId: `assignment-${++serial}` }); },
		settle(taskId) { send("system", "assignment.settle", { taskId, assignmentId: state.tasks.find(task => task.id === taskId).assignment.id }); },
		finish(taskId, builder = "builder", reviewer = "reviewer") {
			this.claim(builder, taskId);
			send(builder, "task.submit", { taskId, summary: "Candidate for review" });
			this.settle(taskId);
			this.claim(reviewer, taskId, "review");
			send(reviewer, "task.review", { taskId, approved: true, summary: "Mock review passed" });
			this.settle(taskId);
		},
	};
}
