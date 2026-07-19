import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkflowLayout, type WorkflowLayout } from "../journal/layout.ts";
import { listWorkflows, resolveByName, resolveByPath } from "./resolve.ts";

function world(): { layout: WorkflowLayout; globalDir: string; projectDir: string; cwd: string } {
	const home = mkdtempSync(join(tmpdir(), "pi-workflow-lib-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-workflow-lib-proj-"));
	const layout = createWorkflowLayout(cwd, { home });
	mkdirSync(layout.globalWorkflowsDir, { recursive: true });
	mkdirSync(layout.projectWorkflowsDir, { recursive: true });
	return { layout, globalDir: layout.globalWorkflowsDir, projectDir: layout.projectWorkflowsDir, cwd };
}

const wf = (name: string, description: string) => `export const meta = { name: '${name}', description: '${description}' };\nreturn 1\n`;

test("listWorkflows: project shadows global; invalid meta listed, not hidden", () => {
	const { layout, globalDir, projectDir } = world();
	writeFileSync(join(globalDir, "demo.js"), wf("demo", "global demo"));
	writeFileSync(join(globalDir, "other.js"), wf("other", "global other"));
	writeFileSync(join(globalDir, "broken.js"), "export const meta = { name: someVar };\n");
	writeFileSync(join(projectDir, "demo.js"), wf("demo", "project demo"));

	const all = listWorkflows(layout, true);
	assert.deepEqual(
		all.map((w) => [w.name, w.origin]),
		[
			["demo", "project"],
			["broken", "global"],
			["other", "global"],
		],
	);
	assert.equal(all[0]!.description, "project demo");
	assert.match(all.find((w) => w.name === "broken")!.invalid ?? "", /pure literal/);

	// untrusted project → project dir ignored, global demo resurfaces
	const untrusted = listWorkflows(layout, false);
	assert.equal(untrusted.find((w) => w.name === "demo")!.origin, "global");
});

test("resolveByName: project wins, trust-gated; miss lists available", () => {
	const { layout, globalDir, projectDir } = world();
	writeFileSync(join(globalDir, "demo.js"), wf("demo", "g"));
	writeFileSync(join(projectDir, "demo.js"), wf("demo", "p"));
	assert.match(resolveByName("demo", layout, true).source, /description: 'p'/);
	assert.match(resolveByName("demo", layout, false).source, /description: 'g'/);
	assert.throws(() => resolveByName("missing", layout, true), /Available: demo/);
	assert.throws(() => resolveByName("../evil", layout, true), /Invalid workflow name/);
});

test("resolveByPath: .js only, absolute or cwd-relative, trust-gated, cwd-confined", () => {
	const { cwd } = world();
	writeFileSync(join(cwd, "my-flow.js"), wf("my-flow", "x"));
	assert.equal(resolveByPath("my-flow.js", cwd, true).fallbackName, "my-flow");
	assert.equal(resolveByPath(join(cwd, "my-flow.js"), cwd, true).fallbackName, "my-flow");
	assert.throws(() => resolveByPath("my-flow.ts", cwd, true), /must point to a \.js file/);
	assert.throws(() => resolveByPath("nope.js", cwd, true), /not found/);
	assert.throws(() => resolveByPath("my-flow.js", cwd, false), /project not trusted/);
	assert.throws(() => resolveByPath("../outside.js", cwd, true), /inside the project directory/);
	assert.throws(() => resolveByPath("/etc/evil.js", cwd, true), /inside the project directory/);
});
