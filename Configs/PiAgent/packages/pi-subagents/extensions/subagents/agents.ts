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
 *   askLimit: 2                         # optional; overrides the /agents asklimit default for this agent (0 = no ask_parent)
 *   ---
 *   System prompt / instructions for the agent go here.
 *
 * This is the same on-disk format Pi's bundled `subagent` example uses, so a
 * single set of agent files powers both delegation and interactive switching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, loadProjectContextFiles, loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
	/**
	 * Which agents this agent may delegate to when it is itself a nested subagent
	 * (frontmatter `canDelegateTo:`): "*" = any, a name list = only those, undefined = none.
	 * The top-level session is exempt.
	 */
	canDelegateTo?: "*" | string[];
	/**
	 * How many times this agent may call ask_parent (frontmatter `askLimit:`) within a
	 * user request before the tool is withheld from its re-runs. `undefined` ⇒ use the
	 * user-configurable default (`/agents asklimit`); 0 ⇒ never gets ask_parent.
	 * Enforced by delegate.ts, which counts asks per agent name and resets each turn.
	 */
	askLimit?: number;
	/**
	 * How to scope the child's skill catalog (frontmatter `skills:`):
	 *   - omitted (`undefined`) ⇒ inherit the full auto-discovered catalog (unchanged).
	 *   - `"none"` ⇒ spawn with --no-skills; the child gets no auto-discovered skills —
	 *     right for narrow read-only agents that never load a skill and shouldn't pay for
	 *     the catalog listing on every spawn.
	 *   - a name list (e.g. `deep-research, dataviz`) ⇒ --no-skills plus --skill for each
	 *     named skill's resolved path, so the child loads only those. Unknown names are
	 *     skipped (see discoverSkillPaths / delegate.ts). An empty list behaves like "none".
	 */
	skills?: "none" | string[];
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

/**
 * Resolve skill names to their on-disk paths using pi's own skill discovery, so a
 * `skills:` allow-list never drifts from how the child would find them. Returns
 * name → filePath for every skill visible from `cwd` (user + project roots). On
 * discovery failure returns an empty map — the child then simply loads none.
 */
export function discoverSkillPaths(cwd: string): Map<string, string> {
	const map = new Map<string, string>();
	try {
		const { skills } = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true });
		for (const skill of skills) if (!map.has(skill.name)) map.set(skill.name, skill.filePath);
	} catch {
		// Best effort: unresolved names just mean the child gets fewer/no skills.
	}
	return map;
}

/**
 * The context files (AGENTS.md / CLAUDE.md, global + ancestor-walked) a child spawned
 * at `cwd` would load, using pi's own discovery so it matches the child exactly. Returned
 * as a sorted list of absolute paths — used to detect when a per-task `cwd` makes a
 * subagent run under different project instructions than its parent. Empty on failure.
 */
export function discoverContextFiles(cwd: string): string[] {
	try {
		return loadProjectContextFiles({ cwd, agentDir: getAgentDir() })
			.map((c) => c.path)
			.sort();
	} catch {
		return [];
	}
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

		const rawCanDelegateTo = frontmatter.canDelegateTo?.trim();
		const canDelegateTo =
			rawCanDelegateTo === "*"
				? "*"
				: rawCanDelegateTo
					? rawCanDelegateTo.split(",").map((s) => s.trim()).filter(Boolean)
					: undefined;

		const askLimitNum = Number(frontmatter.askLimit);
		const askLimit = Number.isInteger(askLimitNum) && askLimitNum >= 0 ? askLimitNum : undefined;

		// `skills:` scopes the child catalog: "none" ⇒ --no-skills; a comma list ⇒ only those
		// named skills; omitted ⇒ inherit the full catalog.
		const rawSkills = frontmatter.skills?.trim();
		const skills: "none" | string[] | undefined =
			rawSkills?.toLowerCase() === "none"
				? "none"
				: rawSkills
					? rawSkills.split(",").map((s) => s.trim()).filter(Boolean)
					: undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model?.trim() || undefined,
			mode,
			canDelegateTo,
			askLimit,
			skills,
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
