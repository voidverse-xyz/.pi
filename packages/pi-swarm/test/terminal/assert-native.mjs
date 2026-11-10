// Combine provider invocation evidence with replayed journal and actual SDK histories.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reduceEvent } from "../../extensions/swarm/state.mjs";
import { PROVIDER_DATA_SCOPE } from "../../extensions/swarm/provider-capability.mjs";

const lines = path => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
const journal = lines(process.argv[2]).map(record => record.payload);
const observations = lines(process.argv[3]);
const events = type => observations.filter(event => event.type === type);
const state = journal.reduce(reduceEvent, null);
const requests = events("native-request");
assert.equal(requests.length, 19, "No retries, replay or extra follow-ups");
assert.equal(events("worker-start").length, requests.length);
assert.deepEqual(requests.map(request => request.id), Array.from({ length: 19 }, (_, index) => index + 1));
assert.deepEqual(events("native-settled").map(event => event.id), requests.map(request => request.id));
for (const [offset, task] of ["approved", "denied", "cancelled", "uncertain", "shutdown"].entries()) {
	const responses = events("native-response").slice(offset * 3, offset * 3 + 3);
	assert.deepEqual(responses.map(response => response.tools[0].name), ["swarm_task", "swarm_task", "bash"]);
	assert.equal(responses[0].tools[0].arguments.id, task);
	assert.equal(responses[1].tools[0].arguments.taskId, task);
	assert.equal(responses[2].tools[0].arguments.command, `node -e "console.log('phase8-${task}')"`);
}
let active = new Set();
for (const event of observations) {
	if (event.type === "native-request") active.add(event.id);
	if (event.type === "native-draining") assert.ok(active.has(event.id));
	if (event.type === "native-settled") assert.ok(active.delete(event.id));
	if (event.type === "shutdown" || event.type === "command" && ["swarm", "fixture-swarm"].includes(event.name) && event.args === "pause" && event.ok) {
		assert.equal(active.size, 0, "Pause/reload/shutdown cannot complete before native streams settle");
	}
}
assert.equal(active.size, 0);
assert.equal(events("native-draining").length, 4, "Aborted open streams really drain before settlement");
assert.equal(events("native-binding").length, 2, "Native reload constructs a fresh registry binding");
assert.deepEqual(events("native-network-guard"), [{ type: "native-network-guard", attempts: 0 }]);
assert.ok(requests.every(request => request.authVerified && request.headersVerified && request.provider === "terminal-native" &&
	request.model === "native-scripted" && request.api === "openai-responses"));
const toolResults = requests.flatMap(request => request.messages.filter(message => message.role === "toolResult"));
assert.ok(toolResults.some(message => message.toolName === "bash" && !message.isError && JSON.stringify(message.content).includes("phase8-approved")), "Real approved stdout returned to native provider");
assert.ok(toolResults.some(message => message.toolName === "bash" && message.isError), "Real denied tool result returned to native provider");
assert.equal(state.hostApprovals.length, 7);
assert.equal(new Set(state.hostApprovals.map(approval => approval.id)).size, 7);
const provider = state.hostApprovals[0].provider;
assert.deepEqual(provider, { version: 1, provider: "terminal-native", modelId: "native-scripted", api: "openai-responses",
	endpoint: "https://native.invalid/v1", transport: "pi-native", outboundData: PROVIDER_DATA_SCOPE });
for (const approval of state.hostApprovals) {
	assert.deepEqual(approval.provider, provider, "Fresh reload binding retains approved descriptor");
	assert.equal(approval.existingChanges, "preserve");
}
assert.equal(journal.filter(event => event.type === "host.continue" && event.payload.restart).length, 1);
assert.equal(state.cycle, 2);
assert.equal(events("uncertain-runner").length, 1);
assert.equal(journal.filter(event => event.type === "host.attest").length, 1);
const unknown = state.workspace.receipts.filter(receipt => receipt.outcome === "unknown");
assert.equal(unknown.length, 1);
assert.equal(unknown[0].command, `node -e "console.log('phase8-uncertain')"`);
assert.equal(unknown[0].exitCode, null);
for (const binding of state.sessions.workers) {
	const history = lines(join(dirname(process.argv[2]), "sessions", binding.sessionFile));
	const assistants = history.filter(entry => entry.type === "message" && entry.message.role === "assistant");
	assert.ok(assistants.length);
	assert.ok(assistants.every(entry => entry.message.provider === provider.provider && entry.message.model === provider.modelId && entry.message.api === provider.api));
}
assert.equal(state.status, "paused");
assert.equal(state.sessions.turns.length, 0);
assert.equal(state.workspace.operations.length, 0);
console.log("PASS: native registry/auth dispatch, exact 19 requests, seven fresh agreements, reload binding, drained SDK streams, guarded zero network, explicit unknown-effect attestation and native history");
