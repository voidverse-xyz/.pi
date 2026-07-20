/**
 * typedefs/discover.ts — locate and read type-definition `.md` files.
 *
 * Discovery: global `~/.pi/agent/subagents/<type>.md` and project
 * `<cwd>/.pi/subagents/<type>.md`. Project defs WIN on name conflict, but only
 * when the project is trusted — an untrusted project's defs are neither listed,
 * read, nor allowed to shadow a global def.
 *
 * The type name `adhoc` is RESERVED for ad-hoc spawns (their constitution lives
 * in the instance dir, not a library) — a library def named adhoc.md is
 * rejected with a clear error rather than silently shadowed.
 *
 * Security: a definition must be an independent regular file — symlinks and
 * multiply-hard-linked files are ignored so a constitution cannot be mutated
 * through an unprotected alias. Files are opened with O_NOFOLLOW and re-stat'd
 * on the open fd.
 */

import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../store/layout.ts";
import { parseTypeFile, type TypeDefinition } from "./parse.ts";

/** The reserved type name for ad-hoc (prompt-at-spawn) agents. */
export const ADHOC_TYPE = "adhoc";

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export interface DiscoverOptions {
	/**
	 * Whether the project's `.pi/subagents` defs are trusted (Pi project-trust).
	 * Defaults to FALSE (fail-closed): an untrusted project's defs are neither
	 * listed, read, nor allowed to shadow a global def. Callers with a real trust
	 * signal must pass it explicitly.
	 */
	projectTrusted?: boolean;
}

export interface TypeDefSource {
	name: string;
	/** Absolute path to the resolved file. */
	path: string;
	origin: "global" | "project" | "adhoc";
	/** When a project def shadows a global one, the shadowed global {path, hash}. */
	shadowsGlobal?: { path: string; hash: string };
}

export interface ResolvedTypeDef extends TypeDefSource {
	definition: TypeDefinition;
	/** Tolerated-foreign-key warnings from the parser. */
	warnings: string[];
	/** sha256 of the file content (recorded in instance state; live-resolve fence). */
	hash: string;
}

/** A file is usable iff it's a regular file with exactly one hard link (no symlink/alias). */
function isIndependentTypeFile(path: string): boolean {
	try {
		const st = lstatSync(path); // lstat does NOT follow symlinks — a link fails isFile()
		return st.isFile() && st.nlink === 1;
	} catch {
		return false;
	}
}

/** Open with O_NOFOLLOW, re-stat the fd, read content. Returns null if not independent. */
function readIndependentTypeFile(path: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const st = fstatSync(fd);
		if (!st.isFile() || st.nlink !== 1) return null;
		return readFileSync(fd, "utf8");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function typeNamesIn(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.endsWith(".md") && !e.startsWith("."))
		.map((e) => e.slice(0, -3))
		.filter((name) => isIndependentTypeFile(join(dir, `${name}.md`)));
}

/** List all discoverable type names with their winning source (project shadows global). */
export function listTypeDefs(layout: Layout, options: DiscoverOptions = {}): TypeDefSource[] {
	const projectTrusted = options.projectTrusted ?? false;
	const sources = new Map<string, TypeDefSource>();
	for (const name of typeNamesIn(layout.globalTypeDefsDir)) {
		sources.set(name, { name, path: layout.typeDefFile(layout.globalTypeDefsDir, name), origin: "global" });
	}
	if (projectTrusted) {
		for (const name of typeNamesIn(layout.projectTypeDefsDir)) {
			const projectPath = layout.typeDefFile(layout.projectTypeDefsDir, name);
			const shadowed = sources.get(name);
			const source: TypeDefSource = { name, path: projectPath, origin: "project" };
			if (shadowed?.origin === "global") {
				const globalContent = readIndependentTypeFile(shadowed.path);
				source.shadowsGlobal = { path: shadowed.path, hash: globalContent === null ? "" : sha256(globalContent) };
			}
			sources.set(name, source);
		}
	}
	sources.delete(ADHOC_TYPE); // reserved — never resolvable from a library dir
	return [...sources.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type ResolveResult =
	| { ok: true; resolved: ResolvedTypeDef }
	| { ok: false; error: string };

/** Resolve one type by name into its parsed definition + content hash (live-resolve). */
export function resolveTypeDef(layout: Layout, name: string, options: DiscoverOptions = {}): ResolveResult {
	if (name === ADHOC_TYPE) {
		return { ok: false, error: `"${ADHOC_TYPE}" is reserved for ad-hoc spawns (pass a prompt instead of a type).` };
	}
	const source = listTypeDefs(layout, options).find((s) => s.name === name);
	if (!source) return { ok: false, error: `Unknown subagent type ${JSON.stringify(name)}.` };
	return resolveFromSource(source);
}

/** Resolve an already-listed source (lets catalog builders list ONCE instead of per type). */
export function resolveFromSource(source: TypeDefSource): ResolveResult {
	const content = readIndependentTypeFile(source.path);
	if (content === null) return { ok: false, error: `Type file for ${JSON.stringify(source.name)} is not an independent regular file.` };
	const parsed = parseTypeFile(content, source.name);
	if (!parsed.ok) return { ok: false, error: `Invalid type file ${source.path}: ${parsed.errors.join("; ")}` };
	return { ok: true, resolved: { ...source, definition: parsed.definition, warnings: parsed.warnings, hash: sha256(content) } };
}

/**
 * Resolve an AD-HOC instance's constitution from its instance-local def.md
 * (written at spawn). Same parse + hash pipeline as library defs, so the
 * typeFileHash fence and live-reload behavior are identical.
 */
export function resolveAdhocDef(layout: Layout, id: string): ResolveResult {
	const path = layout.adhocDefFile(ADHOC_TYPE, id);
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return { ok: false, error: `Ad-hoc def for "${ADHOC_TYPE}/${id}" is missing (${path}).` };
	}
	const parsed = parseTypeFile(content, ADHOC_TYPE);
	if (!parsed.ok) return { ok: false, error: `Invalid ad-hoc def ${path}: ${parsed.errors.join("; ")}` };
	return {
		ok: true,
		resolved: { name: ADHOC_TYPE, path, origin: "adhoc", definition: parsed.definition, warnings: parsed.warnings, hash: sha256(content) },
	};
}

/**
 * Synthesize the def.md content for an ad-hoc spawn. The prompt becomes the
 * body; model/thinking/tools land in frontmatter so the entire existing
 * resolve/hash/build pipeline applies unchanged.
 */
export function composeAdhocDef(options: {
	description: string;
	prompt: string;
	model?: string;
	thinking?: string;
	tools?: string[];
}): string {
	const quote = (s: string): string => JSON.stringify(s);
	const lines = ["---", `name: ${ADHOC_TYPE}`, `description: ${quote(options.description)}`];
	if (options.model !== undefined) lines.push(`model: ${quote(options.model)}`);
	if (options.thinking !== undefined) lines.push(`thinking: ${options.thinking}`);
	if (options.tools !== undefined) lines.push(`tools: [${options.tools.map(quote).join(", ")}]`);
	lines.push("---", "", options.prompt.trim(), "");
	return lines.join("\n");
}
