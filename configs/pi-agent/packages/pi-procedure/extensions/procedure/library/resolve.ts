/**
 * library/resolve.ts — saved/named procedure resolution and listing.
 *
 * A saved procedure is a `<name>.js` file with a meta header. Discovery dirs:
 *   <cwd>/.pi/procedures/     — project library (wins on conflict; TRUST-GATED)
 *   ~/.pi/agent/procedures/   — global library
 *
 * Listing peeks each file's meta; parse failures are listed as invalid rather
 * than hidden, so a broken saved procedure is discoverable.
 *
 * By-path resolution (resolveByPath) is trust-gated and cwd-confined: it is
 * disabled entirely when the project is not trusted, and the resolved file
 * must live inside the project directory.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProcedureLayout } from "../journal/layout.ts";
import { extractMeta } from "../script/meta.ts";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export interface SavedProcedure {
	name: string;
	description: string;
	origin: "project" | "global";
	file: string;
	/** Set when the file's meta failed to parse (still listed, not runnable). */
	invalid?: string;
}

export interface ResolvedSource {
	source: string;
	/** Name fallback for scripts without meta (derived from file/name). */
	fallbackName?: string;
}

function scanDir(dir: string, origin: "project" | "global"): SavedProcedure[] {
	if (!existsSync(dir)) return [];
	const out: SavedProcedure[] = [];
	for (const entry of readdirSync(dir).sort()) {
		if (!entry.endsWith(".js")) continue;
		const name = entry.slice(0, -3);
		const file = resolve(dir, entry);
		try {
			const source = readFileSync(file, "utf8");
			const { meta } = extractMeta(source);
			if (!meta) throw new Error("missing `export const meta = {...}` header (required for saved procedures)");
			out.push({ name, description: meta.description, origin, file });
		} catch (error) {
			out.push({ name, description: "", origin, file, invalid: error instanceof Error ? error.message : String(error) });
		}
	}
	return out;
}

/** List saved procedures, project entries shadowing same-named global ones. */
export function listProcedures(layout: ProcedureLayout, projectTrusted: boolean): SavedProcedure[] {
	const project = projectTrusted ? scanDir(layout.projectProceduresDir, "project") : [];
	const shadowed = new Set(project.map((w) => w.name));
	const global = scanDir(layout.globalProceduresDir, "global").filter((w) => !shadowed.has(w.name));
	return [...project, ...global];
}

/** Resolve a saved procedure by name. Throws with the available names on miss. */
export function resolveByName(name: string, layout: ProcedureLayout, projectTrusted: boolean): ResolvedSource {
	if (!NAME_RE.test(name)) throw new Error(`Invalid procedure name ${JSON.stringify(name)}.`);
	const candidates = [
		...(projectTrusted ? [layout.procedureFile(layout.projectProceduresDir, name)] : []),
		layout.procedureFile(layout.globalProceduresDir, name),
	];
	for (const file of candidates) {
		if (existsSync(file)) return { source: readFileSync(file, "utf8"), fallbackName: name };
	}
	const available = listProcedures(layout, projectTrusted)
		.filter((w) => !w.invalid)
		.map((w) => w.name);
	throw new Error(
		`No saved procedure named "${name}". Available: ${available.length > 0 ? available.join(", ") : "(none)"}.` +
			(projectTrusted ? "" : " (project procedures are disabled — project not trusted)"),
	);
}

/** Resolve a procedure script by path (absolute or cwd-relative, .js only). */
export function resolveByPath(scriptPath: string, cwd: string, projectTrusted: boolean): ResolvedSource {
	if (!projectTrusted) throw new Error("By-path procedure scripts are disabled — project not trusted.");
	if (!scriptPath.endsWith(".js")) throw new Error(`scriptPath must point to a .js file (got ${JSON.stringify(scriptPath)}).`);
	const file = isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath);
	const rel = relative(cwd, file);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`scriptPath must resolve to a file inside the project directory (got ${JSON.stringify(scriptPath)}).`);
	}
	if (!existsSync(file)) throw new Error(`Procedure script not found: ${file}`);
	const base = file.slice(file.lastIndexOf("/") + 1, -3);
	return { source: readFileSync(file, "utf8"), fallbackName: NAME_RE.test(base) ? base : "inline" };
}
