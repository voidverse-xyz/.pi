/**
 * Export the session's changes as a unified patch file under the session cwd —
 * the selected file (e) or all changed files concatenated (E).
 *
 * Diff text comes from the tracker's fileDiffText (SDK generateUnifiedPatch,
 * with the recorded per-call patch fallback for baseline-unknown files); files
 * with no textual diff (binary/oversized, reverted, never observed) are skipped
 * and counted in the notify message. No new differ lives here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type FileChange, fileDiffText } from "./tracker.ts";

export interface ExportOutcome {
	ok: boolean;
	message: string;
	level: "info" | "warning" | "error";
}

function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** ./changes-<timestamp>.patch, deduped with a numeric suffix on collision. */
function exportPath(cwd: string): string {
	const base = `changes-${timestamp()}`;
	let candidate = path.join(cwd, `${base}.patch`);
	for (let n = 2; fs.existsSync(candidate); n++) {
		candidate = path.join(cwd, `${base}-${n}.patch`);
	}
	return candidate;
}

function ensureTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Write the unified patch for `target` (or every file in `changes` when `all`)
 * to a timestamped .patch file under `cwd`.
 */
export async function exportPatch(
	cwd: string,
	changes: FileChange[],
	target: FileChange | undefined,
	all: boolean,
): Promise<ExportOutcome> {
	const wanted = all ? changes : target ? [target] : [];
	if (wanted.length === 0) {
		return { ok: false, message: "No file selected to export", level: "warning" };
	}

	const patches: string[] = [];
	let skipped = 0;
	for (const fc of wanted) {
		const diff = fileDiffText(fc);
		if (diff.trim()) patches.push(ensureTrailingNewline(diff));
		else skipped++;
	}

	if (patches.length === 0) {
		return {
			ok: false,
			message: all
				? "Nothing to export — no file has a textual diff"
				: `Nothing to export for ${wanted[0]!.rel} — no textual diff (binary, oversized, or reverted)`,
			level: "warning",
		};
	}

	const abs = exportPath(cwd);
	try {
		await fs.promises.writeFile(abs, patches.join("\n"), "utf8");
	} catch (e) {
		return { ok: false, message: `Patch export failed: ${String(e)}`, level: "error" };
	}

	const rel = path.relative(cwd, abs) || abs;
	const skipNote = skipped ? ` (${skipped} skipped: no textual diff)` : "";
	return {
		ok: true,
		message: `Wrote patch for ${patches.length} file${patches.length === 1 ? "" : "s"}${skipNote} → ./${rel}`,
		level: "info",
	};
}
