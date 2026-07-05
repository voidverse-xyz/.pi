/**
 * Agent discovery + configuration — shared by the delegation tool (delegate.ts)
 * and the foreground switcher (switcher.ts).
 *
 * Agents are markdown files with YAML frontmatter, discovered from:
 *   - ~/.pi/agent/agents/*.md      (user scope, always loaded)
 *   - <repo>/.pi/agents/*.md       (project scope, loaded only when trusted)
 *
 *   ---
 *   name: my-agent
 *   description: What this agent does
 *   tools: read, grep, find, ls        # optional; omitted → inherit all tools
 *   model: gpt-5.5                      # optional; bare id or "provider/id"; omitted → inherit
 *   ---
 *   System prompt / instructions for the agent go here.
 *
 * This is the same on-disk format Pi's bundled `subagent` example uses, so a
 * single set of agent files powers both delegation and interactive switching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** Raw model string from frontmatter: bare id ("gpt-5.5") or "provider/id". */
	model?: string;
	/**
	 * How this agent's prompt applies when switched to (frontmatter `mode:`):
	 * "augment" (default) keeps Pi's base prompt and appends the agent's; "replace"
	 * makes the agent's body the entire system prompt.
	 */
	mode?: "augment" | "replace";
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/** Absolute path to the user-scope agents directory (may not exist yet). */
export function getUserAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const mode = frontmatter.mode?.trim().toLowerCase() === "replace" ? "replace" : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model?.trim() || undefined,
			mode,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = getUserAgentsDir();
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Project agents override user agents of the same name when scope is "both".
	const agentMap = new Map<string, AgentConfig>();
	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
