/**
 * Declarative agent loader — Claude Code's `.claude/agents/*.md` model, adapted
 * to pi as `.pi/agents/*.md`.
 *
 * Discovers agent definitions from the project (`<cwd>/.pi/agents/`) and global
 * (`~/.pi/agents/`) dirs (recursively), parses frontmatter + body, validates the
 * required `name` + `description`, and resolves the `model` field against pi's
 * ModelRegistry. Definitions are the source of truth on disk — the registry is
 * rebuilt from files every session_start / reload (nothing to persist).
 */

import type { ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asList, asString, parseFrontmatter } from "./frontmatter.ts";

export interface AgentDef {
	name: string;
	description: string;
	/** Tool allowlist (createAgentSession.tools). Empty = inherit default coding tools. */
	tools: string[];
	/** Tool denylist (createAgentSession.excludeTools). */
	disallowedTools: string[];
	/** Resolved model, or undefined to inherit the parent's. */
	model?: Model<any>;
	/** Raw model field for diagnostics. */
	modelSpec?: string;
	isolation?: "worktree";
	role: string;
	color?: string;
	maxTurns?: number;
	memory?: "user" | "project" | "local";
	/** System prompt body. */
	prompt: string;
	/** Absolute path the def was loaded from (diagnostics). */
	source: string;
}

export interface LoadResult {
	agents: Map<string, AgentDef>;
	diagnostics: string[];
}

// Alias → substring used to pick the newest matching available model id.
const MODEL_ALIASES: Record<string, string> = {
	opus: "opus",
	sonnet: "sonnet",
	haiku: "haiku",
	fable: "fable",
};

/**
 * Resolve a `model:` frontmatter value to a concrete Model.
 * - "inherit" or empty → undefined (caller uses ctx.model).
 * - alias (opus/sonnet/haiku/fable) → newest available id containing that alias.
 * - "provider/id" or bare id → exact match against getAll().
 */
export function resolveModel(spec: string | undefined, ctx: ExtensionContext): { model?: Model<any>; error?: string } {
	if (!spec || spec === "inherit") return { model: undefined };
	const all = ctx.modelRegistry?.getAll?.() ?? [];
	const lower = spec.toLowerCase();

	// provider/id form
	if (spec.includes("/")) {
		const [provider, id] = spec.split("/", 2);
		const m = ctx.modelRegistry?.find?.(provider, id);
		if (m) return { model: m };
	}
	// alias form
	const aliasSub = MODEL_ALIASES[lower];
	if (aliasSub) {
		const matches = all.filter((m) => m.id.toLowerCase().includes(aliasSub));
		if (matches.length) {
			// Prefer the lexically-largest id (newest date-suffixed variant) as a heuristic.
			matches.sort((a, b) => (a.id < b.id ? 1 : -1));
			return { model: matches[0] };
		}
	}
	// exact id match
	const exact = all.find((m) => m.id === spec || m.id.toLowerCase() === lower);
	if (exact) return { model: exact };

	return { error: `model "${spec}" not found (available: ${all.map((m) => m.id).slice(0, 8).join(", ")}…)` };
}

function agentDirs(cwd: string): string[] {
	return [path.join(cwd, ".pi", "agents"), path.join(os.homedir(), ".pi", "agents")];
}

function walkMarkdown(dir: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // dir absent — fine
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walkMarkdown(full, out);
		else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
	}
}

export function loadAgents(ctx: ExtensionContext): LoadResult {
	const agents = new Map<string, AgentDef>();
	const diagnostics: string[] = [];
	// Project dir wins over global on name collision → collect global first, then project.
	const dirs = agentDirs(ctx.cwd).reverse();
	for (const dir of dirs) {
		const files: string[] = [];
		walkMarkdown(dir, files);
		for (const file of files) {
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				continue;
			}
			const { frontmatter, body } = parseFrontmatter(raw);
			const name = asString(frontmatter.name);
			const description = asString(frontmatter.description);
			if (!name || !description) {
				diagnostics.push(`${file}: skipped — missing required ${!name ? "name" : "description"}`);
				continue;
			}
			const modelSpec = asString(frontmatter.model);
			const { model, error } = resolveModel(modelSpec, ctx);
			if (error) diagnostics.push(`${file}: ${error}; inheriting parent model`);
			const maxTurnsRaw = asString(frontmatter.maxTurns);
			const maxTurns = maxTurnsRaw && /^\d+$/.test(maxTurnsRaw) ? parseInt(maxTurnsRaw, 10) : undefined;
			const memory = asString(frontmatter.memory);
			agents.set(name, {
				name,
				description,
				tools: asList(frontmatter.tools),
				disallowedTools: asList(frontmatter.disallowedTools),
				model,
				modelSpec,
				isolation: asString(frontmatter.isolation) === "worktree" ? "worktree" : undefined,
				role: asString(frontmatter.role) ?? "worker",
				color: asString(frontmatter.color),
				maxTurns,
				memory: memory === "user" || memory === "project" || memory === "local" ? memory : undefined,
				prompt: body,
				source: file,
			});
		}
	}
	return { agents, diagnostics };
}
