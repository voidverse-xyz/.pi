import test from "node:test";
import assert from "node:assert/strict";
import { approvalPacket, registerSwarmRenderers, statusText } from "../extensions/swarm/ui.mjs";
import { PROVIDER_DATA_SCOPE } from "../extensions/swarm/provider-capability.mjs";

// Presentation never asks a modal question or returns an authority-bearing answer.
for (const transport of [undefined, "scripted-memory", "pi-native"]) {
	test(`chat agreement discloses ${transport ?? "legacy mock"} without misleading network claims`, () => {
		const provider = transport ? { transport, provider: "fixture", modelId: "scripted",
			endpoint: "https://fixture.invalid/v1/chat/completions", outboundData: [...PROVIDER_DATA_SCOPE] } : undefined;
		const summary = approvalPacket({ action: "launch", specification: { objective: "Goal" }, changes: [], provider });
		assert.equal(typeof summary, "string");
		assert.match(summary, /workers manage scoped tasks, peer handoffs, recruitment and independent review within approved limits/);
		assert.match(summary, /final verification using approved Bash access/);
		assert.match(summary, /native settlement and existing Safety\/receipt checks/);
		if (transport === "pi-native") {
			assert.match(summary, /LAUNCH \(Pi native provider\)/);
			assert.match(summary, /credentials, OAuth, environment and routing/);
			assert.match(summary, /informational, not pinned/);
			assert.doesNotMatch(summary, /exact endpoint|mock only|in-memory only|no network/);
		} else assert.match(summary, /LAUNCH \(mock only\)/);
		if (provider) {
			assert.ok(summary.includes(provider.endpoint));
			assert.ok(summary.includes(provider.modelId));
			for (const category of PROVIDER_DATA_SCOPE) assert.ok(summary.includes(category));
		}
	});
}

test("complete configuration, integration and preservation policy are literal chat data", () => {
	const specification = { objective: "Goal", criteria: ["Observable outcome"], scope: ["Only this workspace"],
		limits: { agents: 3, active: 2, tasks: 10, attempts: 2, durationMs: 300000 },
		model: { provider: "swarm-mock", modelId: "scripted", thinkingLevel: "off" },
		codingTools: ["read", "edit", "write", "bash"], instructions: "No new dependencies" };
	const request = { action: "resume", specification, changes: [{ status: "??", path: "dirty.txt" }],
		integrations: { mode: "pi-plan", confirmations: "pi-safety policy remains enforced and may ask for operation confirmation" },
		fingerprintScope: "Git tracked and non-ignored files; submodule-aware", existingChanges: "preserve" };
	const original = structuredClone(request);
	const packet = approvalPacket(request);
	assert.ok(packet.includes(JSON.stringify(specification, null, 2)), "Every selected configuration field is shown");
	assert.match(packet, /pi-plan/);
	assert.match(packet, /pi-safety policy remains enforced/);
	assert.match(packet, /submodule-aware/);
	assert.match(packet, /Preservation: keep existing work, the index, and generated changes/);
	assert.match(packet, /dirty\.txt/);
	assert.deepEqual(request, original, "Packet presentation cannot edit the agreement");
	assert.doesNotMatch(packet, /Preserve and proceed\?|Edit agreement field/);
});

test("maximum Unicode agreement and hostile paths are shown in full and control-safe", () => {
	const hostile = "\x1b[2J\x1b]8;;https://untrusted.invalid\x07\r\u202e\u2066";
	const objective = `${"界🙂é".repeat(3000)}${hostile} last-objective-line`;
	const packet = approvalPacket({ action: "launch", specification: { objective }, changes: [{ status: "??", path: `dirty${hostile}.txt` }],
		integrations: { mode: hostile, confirmations: hostile } });
	assert.ok(packet.includes("界🙂é".repeat(3000)) && packet.includes("last-objective-line"));
	assert.match(packet, /dirty.*\.txt/);
	assert.doesNotMatch(packet, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e\u2066]/);
	assert.match(packet, /\\u001b/);
	assert.match(packet, /\\u202e/);
});

test("recovery packet shows exact unsettled intent as data, without manufacturing evidence", () => {
	const recovery = { operations: [{ id: "exact-operation", command: "uncertain operation" }], turns: [{ id: "exact-turn" }], liveUncertainIds: ["exact-operation"] };
	const packet = approvalPacket({ action: "reconcile", specification: { objective: "Goal" }, changes: [{ path: "dirty.txt" }], recovery });
	assert.match(packet, /RECONCILE/);
	assert.match(packet, /Unresolved execution/);
	assert.ok(packet.includes(JSON.stringify(recovery, null, 2)));
	assert.match(packet, /dirty\.txt/);
	assert.doesNotMatch(packet, /user-established-settlement|approved.*true|successfully completed/);
});

test("agreement renderer keeps all lines literal and readable at narrow terminal width", () => {
	const renderers = new Map();
	registerSwarmRenderers({ registerMessageRenderer: (name, renderer) => renderers.set(name, renderer), registerEntryRenderer() {} });
	const content = Array.from({ length: 60 }, (_, index) => `packet-line-${index}`).join("\n") + "\n**literal**\n\x1b[2J\u202eend";
	const rendered = renderers.get("swarm-agreement")({ content }).render(18).join("\n").replace(/\s/g, "");
	for (let index = 0; index < 60; index++) assert.ok(rendered.includes(`packet-line-${index}`));
	assert.ok(rendered.includes("**literal**"), "No Markdown interpretation of agreement terms");
	assert.ok(rendered.endsWith("\\u001b[2J\\u202eend"));
});

test("status never misrepresents usage placeholders as mock-only execution", () => {
	assert.doesNotMatch(statusText({ run: { status: "running" }, errors: [] }), /mock.only/);
	assert.match(statusText({ run: { status: "running" }, errors: [] }), /cost unknown/);
});

test("status errors retain safe phase/code but never raw host or driver exceptions", () => {
	const output = statusText({ run: { status: "running" },
		errors: ["PRIVATE_PATH command credential", { code: "UNSETTLED", phase: "approval", message: "PRIVATE_PATH exception" }],
		driver: { errors: [{ code: "PRIVATE_CODE", phase: "PRIVATE_PHASE", message: "PRIVATE_COMMAND" }] },
	});
	assert.doesNotMatch(output, /PRIVATE|credential|exception/);
	assert.match(output, /UNSETTLED/);
	assert.match(output, /approval/);
});
