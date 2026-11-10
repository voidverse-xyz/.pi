import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRASH_TIMEOUT_MS = 5_000;

interface TrashResult {
	status: number | null;
	error?: string;
	stderr?: string;
}

interface SessionFileOperations {
	exists(path: string): boolean;
	moveToTrash(path: string): TrashResult;
	unlink(path: string): Promise<void>;
}

export type SessionDeletionResult =
	| { ok: true; method: "trash" | "unlink" | "already-absent" }
	| { ok: false; error: string };

const defaultSessionFileOperations: SessionFileOperations = {
	exists: existsSync,
	moveToTrash(path) {
		const args = path.startsWith("-") ? ["--", path] : [path];
		const result = spawnSync("trash", args, {
			encoding: "utf8",
			timeout: TRASH_TIMEOUT_MS,
		});
		return {
			status: result.status,
			error: result.error?.message,
			stderr: result.stderr?.trim(),
		};
	},
	unlink,
};

function formatTrashError(result: TrashResult): string | undefined {
	const details = [result.error, result.stderr?.split("\n")[0]].filter(Boolean);
	if (details.length === 0) return undefined;
	return `trash: ${details.join(" · ").slice(0, 200)}`;
}

export async function deleteSessionFile(
	sessionPath: string,
	operations: SessionFileOperations = defaultSessionFileOperations,
): Promise<SessionDeletionResult> {
	if (!operations.exists(sessionPath)) {
		return { ok: true, method: "already-absent" };
	}

	const trashResult = operations.moveToTrash(sessionPath);
	if (trashResult.status === 0 || !operations.exists(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await operations.unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		if (!operations.exists(sessionPath)) {
			return { ok: true, method: "already-absent" };
		}

		const unlinkError = error instanceof Error ? error.message : String(error);
		const trashError = formatTrashError(trashResult);
		return {
			ok: false,
			error: trashError ? `${unlinkError} (${trashError})` : unlinkError,
		};
	}
}

function successMessage(method: "trash" | "unlink" | "already-absent"): string {
	if (method === "trash") {
		return "Previous session moved to trash; new session started";
	}
	if (method === "unlink") {
		return "Previous session deleted; new session started";
	}
	return "New session started; previous session file was already absent";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("prune", {
		description: "Delete the current session and start a new one",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /prune", "warning");
				return;
			}

			const previousSessionFile = ctx.sessionManager.getSessionFile();
			const result = await ctx.newSession({
				withSession: async (sessionCtx) => {
					if (!previousSessionFile) {
						sessionCtx.ui.notify("New session started; previous session was not persisted", "info");
						return;
					}

					const deletion = await deleteSessionFile(previousSessionFile);
					if (!deletion.ok) {
						sessionCtx.ui.notify(
							`New session started, but the previous session could not be deleted: ${deletion.error}`,
							"error",
						);
						return;
					}

					sessionCtx.ui.notify(successMessage(deletion.method), "info");
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Prune cancelled", "info");
			}
		},
	});
}
