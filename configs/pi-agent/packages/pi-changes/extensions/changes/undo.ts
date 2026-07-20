/**
 * Per-file undo of the agent's changes — precise and git-free.
 *
 * Strategy (in priority order):
 *  - captured baseline that existed  → restore the byte-exact pre-image (recreates
 *    the file if it was since deleted).
 *  - captured baseline, agent-created → delete the file (after confirm).
 *  - no captured baseline (edited before the extension observed it) → best-effort
 *    in-memory inverse replay of the recorded edits, requiring a unique exact match;
 *    refuse rather than guess.
 *
 * A drift check warns when the file changed outside the agent since its last edit.
 * `undoAllFiles` applies the baseline paths to every undoable file behind a single
 * confirmation that lists exactly what will happen (baseline-unknown and binary
 * files are skipped and reported, never guessed at in bulk).
 * Runs from the command loop with the overlay closed, so `ctx.ui.confirm` is safe.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type FileChange, sha256, UNDONE_TYPE } from "./tracker.ts";

export interface UndoOutcome {
	ok: boolean;
	message: string;
	level: "info" | "warning" | "error";
}

function appendUndone(pi: ExtensionAPI, abs: string): void {
	pi.appendEntry(UNDONE_TYPE, { v: 1, path: abs });
}

/** Restore the captured pre-image (recreating the file if since deleted) and mark undone. */
async function restoreBaseline(pi: ExtensionAPI, fc: FileChange): Promise<void> {
	await withFileMutationQueue(fc.abs, async () => {
		await fs.promises.mkdir(path.dirname(fc.abs), { recursive: true });
		await fs.promises.writeFile(fc.abs, fc.baseline?.content ?? "", "utf8");
		if (fc.baseline?.mode !== undefined) {
			await fs.promises.chmod(fc.abs, fc.baseline.mode & 0o7777);
		}
	});
	appendUndone(pi, fc.abs);
}

/** Delete an agent-created file (tolerating it already being gone) and mark undone. */
async function deleteCreated(pi: ExtensionAPI, fc: FileChange): Promise<void> {
	await withFileMutationQueue(fc.abs, async () => {
		try {
			await fs.promises.unlink(fc.abs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	});
	appendUndone(pi, fc.abs);
}

/** True when the file changed outside the agent since its last tracked edit. */
function hasDrift(fc: FileChange): boolean {
	if (!fc.currentExists || fc.currentUnreadable || fc.current === null || !fc.lastPostHash) return false;
	return sha256(fc.current) !== fc.lastPostHash;
}

export async function undoFile(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	fc: FileChange,
): Promise<UndoOutcome> {
	if (fc.hasBaseline && fc.baseline?.unrestorable) {
		return {
			ok: false,
			message: `Can't undo ${fc.rel}: its original was binary or too large to capture`,
			level: "warning",
		};
	}

	// Drift: the file changed outside the agent's edit/write since its last touch.
	if (hasDrift(fc)) {
		const ok = await ctx.ui.confirm(
			"File changed outside the agent",
			`${fc.rel} changed since the agent's last edit. Undo anyway (this discards those outside changes)?`,
		);
		if (!ok) return { ok: false, message: "Undo cancelled", level: "info" };
	}

	if (!fc.hasBaseline) return undoBaselineUnknown(pi, ctx, fc);

	const base = fc.baseline!;
	try {
		if (base.existed) {
			await restoreBaseline(pi, fc);
			return { ok: true, message: `Reverted ${fc.rel} to its pre-session state`, level: "info" };
		}

		// Agent-created file → delete it.
		if (fc.currentExists) {
			const ok = await ctx.ui.confirm("Delete agent-created file?", fc.rel);
			if (!ok) return { ok: false, message: "Undo cancelled", level: "info" };
		}
		await deleteCreated(pi, fc);
		return { ok: true, message: `Removed agent-created ${fc.rel}`, level: "info" };
	} catch (e) {
		return { ok: false, message: `Undo failed for ${fc.rel}: ${String(e)}`, level: "error" };
	}
}

// ── Restore all ───────────────────────────────────────────────────────────────

interface RestorePlanItem {
	fc: FileChange;
	action: "restore" | "delete";
	note?: string;
}

/** Cap the confirmation listing so a huge changeset can't flood the dialog. */
const MAX_LISTED = 20;

/**
 * Undo every undoable change behind ONE confirmation listing what will happen:
 * captured baselines restored, agent-created files deleted; baseline-unknown,
 * binary/oversized, already-reverted, and already-deleted files skipped (and
 * reported). Reuses the same restore/delete paths as the single-file undo.
 */
export async function undoAllFiles(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	changes: FileChange[],
): Promise<UndoOutcome> {
	const plan: RestorePlanItem[] = [];
	const skipped: { fc: FileChange; reason: string }[] = [];

	for (const fc of changes) {
		if (fc.status === "reverted") {
			skipped.push({ fc, reason: "already reverted" });
		} else if (!fc.hasBaseline) {
			skipped.push({ fc, reason: "no captured baseline" });
		} else if (fc.baseline!.unrestorable) {
			skipped.push({ fc, reason: "original was binary or too large" });
		} else if (fc.baseline!.existed) {
			const note = hasDrift(fc) ? "changed outside the agent — those changes will be discarded" : undefined;
			plan.push({ fc, action: "restore", ...(note !== undefined ? { note } : {}) });
		} else if (fc.currentExists) {
			plan.push({ fc, action: "delete" });
		} else {
			skipped.push({ fc, reason: "already deleted" });
		}
	}

	if (plan.length === 0) {
		return {
			ok: false,
			message: `Nothing to restore — ${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped`,
			level: "warning",
		};
	}

	const lines: string[] = [];
	for (const item of plan.slice(0, MAX_LISTED)) {
		lines.push(`${item.action === "restore" ? "restore" : "delete "} ${item.fc.rel}${item.note ? ` — ${item.note}` : ""}`);
	}
	if (plan.length > MAX_LISTED) lines.push(`…and ${plan.length - MAX_LISTED} more`);
	for (const s of skipped.slice(0, MAX_LISTED)) lines.push(`skip    ${s.fc.rel} — ${s.reason}`);
	if (skipped.length > MAX_LISTED) lines.push(`…and ${skipped.length - MAX_LISTED} more skipped`);

	const ok = await ctx.ui.confirm("Restore ALL agent changes?", lines.join("\n"));
	if (!ok) return { ok: false, message: "Restore all cancelled", level: "info" };

	let restored = 0;
	let deleted = 0;
	let failed = 0;
	let firstError = "";
	for (const item of plan) {
		try {
			if (item.action === "restore") {
				await restoreBaseline(pi, item.fc);
				restored++;
			} else {
				await deleteCreated(pi, item.fc);
				deleted++;
			}
		} catch (e) {
			failed++;
			if (!firstError) firstError = `${item.fc.rel}: ${String(e)}`;
		}
	}

	let message = `Restore all: restored ${restored}, deleted ${deleted}, skipped ${skipped.length}`;
	if (failed) message += `, failed ${failed} (first: ${firstError})`;
	return { ok: failed === 0, message, level: failed ? "error" : "info" };
}

async function undoBaselineUnknown(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	fc: FileChange,
): Promise<UndoOutcome> {
	if (fc.writeCalls > 0 || fc.editCalls.length === 0) {
		return {
			ok: false,
			message: `Can't undo ${fc.rel}: its original state was never observed`,
			level: "warning",
		};
	}
	if (!fc.currentExists || fc.currentUnreadable || fc.current === null) {
		return { ok: false, message: `Can't undo ${fc.rel}: file is unreadable`, level: "warning" };
	}

	// Reverse each recorded edit newest→oldest, requiring a unique exact match.
	let content = fc.current;
	for (let i = fc.editCalls.length - 1; i >= 0; i--) {
		const { oldText, newText } = fc.editCalls[i]!;
		if (newText === "") {
			return {
				ok: false,
				message: `Can't safely undo ${fc.rel}: a recorded edit is ambiguous to reverse`,
				level: "warning",
			};
		}
		const idx = content.indexOf(newText);
		if (idx === -1 || content.indexOf(newText, idx + 1) !== -1) {
			return {
				ok: false,
				message: `Can't safely undo ${fc.rel}: a change no longer uniquely matches`,
				level: "warning",
			};
		}
		content = content.slice(0, idx) + oldText + content.slice(idx + newText.length);
	}

	const ok = await ctx.ui.confirm(
		"Undo without a captured baseline?",
		`${fc.rel}: reconstruct the original by reversing ${fc.editCalls.length} recorded edit(s)?`,
	);
	if (!ok) return { ok: false, message: "Undo cancelled", level: "info" };

	try {
		await withFileMutationQueue(fc.abs, async () => {
			await fs.promises.writeFile(fc.abs, content, "utf8");
		});
		appendUndone(pi, fc.abs);
		return { ok: true, message: `Reconstructed original ${fc.rel} (inverse replay)`, level: "info" };
	} catch (e) {
		return { ok: false, message: `Undo failed for ${fc.rel}: ${String(e)}`, level: "error" };
	}
}
