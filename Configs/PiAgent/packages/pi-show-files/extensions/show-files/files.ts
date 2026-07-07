/**
 * Resolution/normalization of the file specs the agent passes to show_files.
 *
 * Each spec's path is resolved against the session cwd (absolute paths accepted),
 * stat'ed to classify it (file / dir / missing — missing is *presented*, dimmed,
 * and reported back to the agent rather than dropped), and its highlight regions
 * are normalized to sorted 1-based inclusive ranges.
 */

import { stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface RegionSpec {
	start: number;
	end?: number;
	note?: string;
}

export interface FileSpec {
	path: string;
	title?: string;
	description?: string;
	group?: string;
	regions?: RegionSpec[];
}

export interface Region {
	start: number; // 1-based
	end: number; // 1-based, inclusive, >= start
	note?: string;
}

export type PresentedKind = "file" | "dir" | "missing";

export interface PresentedFile {
	/** Display + @-mention path: cwd-relative when under cwd, else absolute. */
	rel: string;
	abs: string;
	kind: PresentedKind;
	/** Agent's label; falls back to the basename. */
	title: string;
	description?: string;
	group?: string;
	regions: Region[];
}

export async function resolveFiles(cwd: string, specs: FileSpec[]): Promise<PresentedFile[]> {
	return Promise.all(
		specs.map(async (spec) => {
			const abs = isAbsolute(spec.path) ? spec.path : resolve(cwd, spec.path);
			let kind: PresentedKind = "missing";
			try {
				kind = (await stat(abs)).isDirectory() ? "dir" : "file";
			} catch {
				// keep "missing" — shown dimmed and reported to the agent
			}
			const relPath = relative(cwd, abs);
			const rel = relPath && !relPath.startsWith("..") && !isAbsolute(relPath) ? relPath : abs;

			const regions: Region[] = (spec.regions ?? [])
				.map((r) => {
					const start = Math.max(1, Math.floor(r.start));
					const end = Math.max(start, Math.floor(r.end ?? start));
					const note = r.note?.trim() || undefined;
					return { start, end, note };
				})
				.sort((a, b) => a.start - b.start);

			return {
				rel,
				abs,
				kind,
				title: spec.title?.trim() || basename(abs),
				description: spec.description?.trim() || undefined,
				group: spec.group?.trim() || undefined,
				regions,
			};
		}),
	);
}
