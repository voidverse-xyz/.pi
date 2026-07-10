/**
 * typedefs/discover.ts — type-definition discovery and resolution (D6).
 *
 * Two libraries, merged for listing, PROJECT WINS on a name conflict:
 *
 *   ~/.pi/agent/subagents/<type>.md      # global personal library
 *   <project>/.pi/subagents/<type>.md    # repo-shipped types
 *
 * Types are live-resolved by name at wake — editing a type .md retunes all
 * existing instances on their next wake. Resolution returns the file's
 * content plus its sha256 so the registry can record the exact constitution
 * an instance was last woken under (registry.typeFileHash, D6 visibility).
 *
 * This module only finds and reads files (paths from store/layout.ts);
 * parsing/validation is typedefs/parse.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Layout } from "../store/layout.ts";

export type TypeDefSource = "project" | "global";

/** A discovered (not yet parsed) type .md. */
export interface DiscoveredTypeDef {
	/** Type name = filename stem. */
	name: string;
	/** Absolute path of the winning file. */
	path: string;
	source: TypeDefSource;
	content: string;
	/** sha256 hex of the content — recorded in the registry at wake (D6). */
	hash: string;
}

export function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * List every available type, merged across both libraries; on a name
 * conflict the project file shadows the global one. Sorted by name.
 */
export function listTypeDefs(layout: Layout): DiscoveredTypeDef[] {
	const byName = new Map<string, DiscoveredTypeDef>();
	// Global first, then project — project overwrites on conflict.
	for (const { dir, source } of [
		{ dir: layout.globalTypeDefsDir, source: "global" as const },
		{ dir: layout.projectTypeDefsDir, source: "project" as const },
	]) {
		for (const name of typeNamesIn(dir)) {
			const def = readTypeDef(layout, dir, name, source);
			if (def) byName.set(name, def);
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve one type by name (project wins). Returns null if no library has
 * it — the spawn tool turns that into "unknown type" with the list of
 * available names.
 */
export function resolveTypeDef(layout: Layout, name: string): DiscoveredTypeDef | null {
	return (
		readTypeDef(layout, layout.projectTypeDefsDir, name, "project") ??
		readTypeDef(layout, layout.globalTypeDefsDir, name, "global")
	);
}

function typeNamesIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
		.map((entry) => entry.name.slice(0, -".md".length));
}

function readTypeDef(layout: Layout, dir: string, name: string, source: TypeDefSource): DiscoveredTypeDef | null {
	const path = layout.typeDefFile(dir, name);
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	return { name, path, source, content, hash: sha256(content) };
}
