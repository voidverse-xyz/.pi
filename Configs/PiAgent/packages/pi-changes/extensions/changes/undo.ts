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
	if (fc.currentExists && !fc.currentUnreadable && fc.current !== null && fc.lastPostHash) {
		if (sha256(fc.current) !== fc.lastPostHash) {
			const ok = await ctx.ui.confirm(
				"File changed outside the agent",
				`${fc.rel} changed since the agent's last edit. Undo anyway (this discards those outside changes)?`,
			);
			if (!ok) return { ok: false, message: "Undo cancelled", level: "info" };
		}
	}

	if (!fc.hasBaseline) return undoBaselineUnknown(pi, ctx, fc);

	const base = fc.baseline!;
	try {
		if (base.existed) {
			await withFileMutationQueue(fc.abs, async () => {
				await fs.promises.mkdir(path.dirname(fc.abs), { recursive: true });
				await fs.promises.writeFile(fc.abs, base.content ?? "", "utf8");
			});
			appendUndone(pi, fc.abs);
			return { ok: true, message: `Reverted ${fc.rel} to its pre-session state`, level: "info" };
		}

		// Agent-created file → delete it.
		if (fc.currentExists) {
			const ok = await ctx.ui.confirm("Delete agent-created file?", fc.rel);
			if (!ok) return { ok: false, message: "Undo cancelled", level: "info" };
			await withFileMutationQueue(fc.abs, async () => {
				await fs.promises.unlink(fc.abs).catch(() => {});
			});
		}
		appendUndone(pi, fc.abs);
		return { ok: true, message: `Removed agent-created ${fc.rel}`, level: "info" };
	} catch (e) {
		return { ok: false, message: `Undo failed for ${fc.rel}: ${String(e)}`, level: "error" };
	}
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
