import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_FRONTMATTER_BYTES = 16 * 1024;
export const MAX_FORCED_TEMPLATE_BYTES = 50 * 1024;
export const MAX_AUTOMATIC_TEMPLATES = 20;
export const MAX_DISCOVERED_SHARED_TEMPLATES = 100;
const MAX_CATALOG_DESCRIPTION_CHARS = 1024;

export interface PlanSkillDescriptor {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
}

function readPrefix(path: string, maxBytes: number): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(maxBytes);
		const bytes = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytes).toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function frontmatterFromFile(path: string): string | undefined {
	const content = readPrefix(path, MAX_FRONTMATTER_BYTES);
	if (!content?.startsWith("---")) return undefined;
	return content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
}

export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content.trim();
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	return (match ? content.slice(match[0].length) : content).trim();
}

export function loadSkillBody(skill: PlanSkillDescriptor | undefined): string | undefined {
	if (!skill) return undefined;
	try {
		if (statSync(skill.filePath).size > MAX_FORCED_TEMPLATE_BYTES) return undefined;
		return stripFrontmatter(readFileSync(skill.filePath, "utf8"));
	} catch {
		return undefined;
	}
}

export function discoverTaggedSkillDirectories(
	root: string,
	limit = MAX_DISCOVERED_SHARED_TEMPLATES,
): string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		if (found.length >= limit) return;
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
		if (skillFile) {
			const path = join(directory, skillFile.name);
			const metadata = frontmatterFromFile(path);
			if (metadata !== undefined && /^plan-template:\s*true\s*$/m.test(metadata)) found.push(directory);
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) walk(join(directory, entry.name));
			if (found.length >= limit) return;
		}
	};
	walk(root);
	return found;
}

export function discoverPlanTemplates(
	skills: readonly PlanSkillDescriptor[] | undefined,
	baseSkillName: string,
	options: { includeDisabled?: boolean } = {},
): PlanSkillDescriptor[] {
	return (skills ?? []).filter((skill) => {
		if (skill.name === baseSkillName) return false;
		if (skill.disableModelInvocation && !options.includeDisabled) return false;
		const metadata = frontmatterFromFile(skill.filePath);
		return metadata !== undefined && /^plan-template:\s*true\s*$/m.test(metadata);
	});
}

export function buildAutomaticTemplateInstructions(templates: readonly PlanSkillDescriptor[]): string {
	if (templates.length === 0) {
		return "No tagged supplemental Plan template is available. Follow the base Plan skill.";
	}
	const visible = templates.slice(0, MAX_AUTOMATIC_TEMPLATES);
	const catalog = visible
		.map((template) => {
			const description = template.description.slice(0, MAX_CATALOG_DESCRIPTION_CHARS);
			return `- name=${JSON.stringify(template.name)} path=${JSON.stringify(template.filePath)} description=${JSON.stringify(description)}`;
		})
		.join("\n");
	const omitted = templates.length - visible.length;
	return `Select exactly one supplemental Plan template whose description best matches the current task. Before substantive research, use read to load that template's SKILL.md and follow it together with the base Plan skill. If none adds relevant specialization, use only the base Plan skill. Do not load multiple templates.\n\nCandidates:\n${catalog}${omitted > 0 ? `\n- ${omitted} additional tagged templates omitted from automatic routing; use an explicit --skill override to select one.` : ""}`;
}
