/**
 * The interactive confirmation flow for a gated command, factored out of index.ts
 * so it can be reused by the subagent path: index.ts's `ipc:serve` handler shows this
 * same dialog on the parent's TUI on behalf of a headless child, when a "safety.confirm"
 * is forwarded up through the optional `ipc` extension.
 *
 * Runs one delayedConfirm per required confirmation (destructive needs two); any
 * cancel short-circuits to "not approved". Returns false immediately when there is
 * no UI to confirm with — callers decide what a no-UI context means (block, or
 * forward the request to a parent that does have a UI).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CATEGORY_META, type Category } from "./categories.ts";
import { delayedConfirm } from "./delayed-confirm.ts";

export async function confirmGatedCommand(
	ctx: ExtensionContext,
	category: Category,
	command: string,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const meta = CATEGORY_META[category];
	for (let i = 1; i <= meta.confirmations; i++) {
		const step = meta.confirmations > 1 ? `${i} of ${meta.confirmations}` : undefined;
		const ok = await delayedConfirm(ctx, {
			label: meta.label,
			color: meta.color,
			command,
			delayMs: meta.delayMs,
			step,
		});
		if (!ok) return false;
	}
	return true;
}
