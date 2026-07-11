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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
	/**
	 * Set on a PROJECT def that shadows an existing GLOBAL def of the same name
	 * (Finding 7 visibility): the shadowed global's path + content hash, so a
	 * project file silently overriding a trusted global one is surfaceable.
	 */
	shadowsGlobal?: { path: string; hash: string };
}

/** Discovery options — the project-trust gate (Finding 7). */
export interface DiscoverOptions {
	/**
	 * Whether project-local (`<cwd>/.pi/subagents`) type definitions may be
	 * loaded. Default true (preserves direct-construction/harness behavior).
	 * When false — the Pi project is UNTRUSTED — project files are NOT read or
	 * resolved and cannot shadow global types; global types still work.
	 */
	projectTrusted?: boolean;
}

export function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * List every available type, merged across both libraries; on a name
 * conflict the project file shadows the global one. Sorted by name.
 *
 * When the project is untrusted (Finding 7), project files are skipped
 * entirely — the listing shows only global types.
 */
export function listTypeDefs(layout: Layout, options: DiscoverOptions = {}): DiscoveredTypeDef[] {
	const projectTrusted = options.projectTrusted ?? true;
	const byName = new Map<string, DiscoveredTypeDef>();
	const globalByName = new Map<string, DiscoveredTypeDef>();
	// Global first, then (if trusted) project — project overwrites on conflict.
	const sources: Array<{ dir: string; source: TypeDefSource }> = [
		{ dir: layout.globalTypeDefsDir, source: "global" },
	];
	if (projectTrusted) sources.push({ dir: layout.projectTypeDefsDir, source: "project" });
	for (const { dir, source } of sources) {
		for (const name of typeNamesIn(dir)) {
			const def = readTypeDef(layout, dir, name, source);
			if (!def) continue;
			if (source === "global") globalByName.set(name, def);
			if (source === "project") {
				const shadowed = globalByName.get(name);
				if (shadowed) def.shadowsGlobal = { path: shadowed.path, hash: shadowed.hash };
			}
			byName.set(name, def);
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve one type by name (project wins). Returns null if no library has
 * it — the spawn tool turns that into "unknown type" with the list of
 * available names.
 *
 * Finding 7: when the project is untrusted, project files are neither read nor
 * allowed to shadow a global type — resolution falls straight through to the
 * global library. A resolved PROJECT def that shadows a global one carries the
 * shadowed global's path+hash in `shadowsGlobal` for surfacing.
 */
export function resolveTypeDef(layout: Layout, name: string, options: DiscoverOptions = {}): DiscoveredTypeDef | null {
	const projectTrusted = options.projectTrusted ?? true;
	if (projectTrusted) {
		const project = readTypeDef(layout, layout.projectTypeDefsDir, name, "project");
		if (project) {
			const shadowed = readTypeDef(layout, layout.globalTypeDefsDir, name, "global");
			if (shadowed) project.shadowsGlobal = { path: shadowed.path, hash: shadowed.hash };
			return project;
		}
	}
	return readTypeDef(layout, layout.globalTypeDefsDir, name, "global");
}

/**
 * The `.md` type-name stems in a dir. Symlinks are INCLUDED (Finding 7 lower-
 * priority): Dirent.isFile() is false for a symlink, but resolution follows it
 * (readFileSync), so listing it as absent while spawn happily resolves it was
 * inconsistent. We accept a symlink whose target stats as a regular file.
 */
function typeNamesIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const names: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
		let isFile = entry.isFile();
		if (!isFile && entry.isSymbolicLink()) {
			try {
				isFile = statSync(join(dir, entry.name)).isFile(); // follow the link
			} catch {
				isFile = false; // dangling/unreadable symlink — resolution would fail too
			}
		}
		if (isFile) names.push(entry.name.slice(0, -".md".length));
	}
	return names;
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
