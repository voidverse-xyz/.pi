import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildAutomaticTemplateInstructions,
	discoverPlanTemplates,
	loadSkillBody,
	MAX_AUTOMATIC_TEMPLATES,
	MAX_FORCED_TEMPLATE_BYTES,
	type PlanSkillDescriptor,
} from "./templates.ts";

test("discovers only explicitly tagged supplemental Plan templates", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-plan-templates-"));
	try {
		const taggedPath = join(root, "tagged.md");
		const untaggedPath = join(root, "untagged.md");
		const basePath = join(root, "base.md");
		const disabledPath = join(root, "disabled.md");
		await writeFile(taggedPath, "---\nname: software\nplan-template: true\ndescription: Software\n---\n# Software plan\n", "utf8");
		await writeFile(untaggedPath, "---\nname: other\ndescription: Other\n---\n# Other\n", "utf8");
		await writeFile(basePath, "---\nname: plan\nplan-template: true\ndescription: Base\n---\n# Base\n", "utf8");
		await writeFile(disabledPath, "---\nname: private\nplan-template: true\ndescription: Private\n---\n# Private\n", "utf8");
		const skills: PlanSkillDescriptor[] = [
			{ name: "software", description: "Software", filePath: taggedPath },
			{ name: "other", description: "Other", filePath: untaggedPath },
			{ name: "plan", description: "Base", filePath: basePath },
			{ name: "private", description: "Private", filePath: disabledPath, disableModelInvocation: true },
		];
		assert.deepEqual(discoverPlanTemplates(skills, "plan").map((skill) => skill.name), ["software"]);
		assert.deepEqual(
			discoverPlanTemplates(skills, "plan", { includeDisabled: true }).map((skill) => skill.name),
			["software", "private"],
		);
		assert.equal(loadSkillBody(skills[0]), "# Software plan");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("automatic selection instructions include bounded descriptions and paths", () => {
	const templates = Array.from({ length: MAX_AUTOMATIC_TEMPLATES + 2 }, (_, index) => ({
		name: `template-${index}`,
		description: index === 0 ? `Use for code changes ${"x".repeat(2000)}` : `Template ${index}`,
		filePath: `/skills/template-${index}/SKILL.md`,
	}));
	const text = buildAutomaticTemplateInstructions(templates);
	assert.match(text, /exactly one/i);
	assert.match(text, /template-0/);
	assert.match(text, /Use for code changes/);
	assert.match(text, /\/skills\/template-0\/SKILL\.md/);
	assert.doesNotMatch(text, /template-20/);
	assert.match(text, /2 additional tagged templates omitted/);
	assert.match(buildAutomaticTemplateInstructions([]), /base Plan skill/);
});

test("forced template loading rejects oversized files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-plan-template-size-"));
	try {
		const path = join(root, "SKILL.md");
		await writeFile(path, "x".repeat(MAX_FORCED_TEMPLATE_BYTES + 1), "utf8");
		assert.equal(loadSkillBody({ name: "large", description: "Large", filePath: path }), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
