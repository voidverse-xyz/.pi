import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWritePlan, MAX_PLAN_BYTES, resolvePlanTarget, validatePlanContent } from "./save.ts";

async function fixture(): Promise<{ root: string; cleanup(): Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "pi-plan-test-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("resolvePlanTarget accepts a nested project-relative Markdown path", async () => {
	const f = await fixture();
	try {
		const target = await resolvePlanTarget(f.root, "docs/agents/plans/auth/auth.md");
		assert.equal(target.relativePath, "docs/agents/plans/auth/auth.md");
		assert.equal(target.exists, false);
		assert.equal(target.absolutePath, join(f.root, "docs/agents/plans/auth/auth.md"));
	} finally {
		await f.cleanup();
	}
});

test("resolvePlanTarget rejects unsafe paths", async () => {
	const f = await fixture();
	try {
		for (const path of ["/tmp/plan.md", "../plan.md", "docs/../plan.md", "README.txt", "bad\nname.md"]) {
			await assert.rejects(() => resolvePlanTarget(f.root, path), Error, path);
		}
	} finally {
		await f.cleanup();
	}
});

test("resolvePlanTarget rejects symlink parents and symlink targets", async () => {
	const f = await fixture();
	const outside = await mkdtemp(join(tmpdir(), "pi-plan-outside-"));
	try {
		await symlink(outside, join(f.root, "linked"));
		await assert.rejects(() => resolvePlanTarget(f.root, "linked/plan.md"), /symlink/i);

		await writeFile(join(outside, "existing.md"), "outside", "utf8");
		await symlink(join(outside, "existing.md"), join(f.root, "plan.md"));
		await assert.rejects(() => resolvePlanTarget(f.root, "plan.md"), /symlink/i);
	} finally {
		await Promise.all([f.cleanup(), rm(outside, { recursive: true, force: true })]);
	}
});

test("atomicWritePlan creates and atomically replaces an authorized target", async () => {
	const f = await fixture();
	try {
		let target = await resolvePlanTarget(f.root, "docs/plan.md");
		await atomicWritePlan(target, "# First plan\n");
		assert.equal(await readFile(join(f.root, "docs/plan.md"), "utf8"), "# First plan\n");

		await chmod(join(f.root, "docs/plan.md"), 0o600);
		target = await resolvePlanTarget(f.root, "docs/plan.md");
		assert.equal(target.exists, true);
		assert.equal(target.mode, 0o600);
		await atomicWritePlan(target, "# Revised plan\n");
		assert.equal(await readFile(join(f.root, "docs/plan.md"), "utf8"), "# Revised plan\n");
		assert.equal((await stat(join(f.root, "docs/plan.md"))).mode & 0o777, 0o600);
	} finally {
		await f.cleanup();
	}
});

test("atomicWritePlan will not replace a file that appeared after new-path authorization", async () => {
	const f = await fixture();
	try {
		const target = await resolvePlanTarget(f.root, "plan.md");
		await writeFile(join(f.root, "plan.md"), "user content", "utf8");
		await assert.rejects(() => atomicWritePlan(target, "# Plan\n"), /EEXIST/);
		assert.equal(await readFile(join(f.root, "plan.md"), "utf8"), "user content");
	} finally {
		await f.cleanup();
	}
});

test("atomicWritePlan rejects a parent changed to a symlink before writing", async () => {
	const f = await fixture();
	const outside = await mkdtemp(join(tmpdir(), "pi-plan-outside-"));
	try {
		await mkdir(join(f.root, "docs"));
		const target = await resolvePlanTarget(f.root, "docs/plan.md");
		await rm(join(f.root, "docs"), { recursive: true });
		await symlink(outside, join(f.root, "docs"));
		await assert.rejects(() => atomicWritePlan(target, "# Plan\n"), /symlink/i);
	} finally {
		await Promise.all([f.cleanup(), rm(outside, { recursive: true, force: true })]);
	}
});

test("validatePlanContent rejects empty and oversized content", () => {
	assert.throws(() => validatePlanContent("  \n"), /empty/i);
	assert.throws(() => validatePlanContent("x".repeat(MAX_PLAN_BYTES + 1)), /limit/i);
	assert.equal(validatePlanContent("# Plan\n"), 7);
});
