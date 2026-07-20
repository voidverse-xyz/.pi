import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CATEGORY_META, type Category } from "./categories.ts";
import { delayedConfirm } from "./delayed-confirm.ts";

/** Run the category's required confirmation sequence. */
export async function confirmGatedCommand(
	ctx: ExtensionContext,
	category: Category,
	command: string,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const meta = CATEGORY_META[category];
	for (let step = 1; step <= meta.confirmations; step++) {
		const approved = await delayedConfirm(ctx, {
			label: meta.label,
			color: meta.color,
			command,
			delayMs: meta.delayMs,
			step: meta.confirmations > 1 ? `${step} of ${meta.confirmations}` : undefined,
		});
		if (!approved) return false;
	}
	return true;
}
