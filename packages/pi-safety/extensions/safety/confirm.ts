import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CATEGORY_META, type Category } from "./categories.ts";
import { delayedConfirm } from "./delayed-confirm.ts";

/** Run the category's required confirmation sequence. */
export async function confirmGatedCommand(
	ctx: ExtensionContext,
	category: Category,
	command: string,
	signal: AbortSignal | undefined = ctx.signal,
): Promise<boolean> {
	if (!ctx.hasUI || signal?.aborted) return false;
	const meta = CATEGORY_META[category];
	for (let step = 1; step <= meta.confirmations; step++) {
		if (signal?.aborted) return false;
		const approved = await delayedConfirm(ctx, {
			label: meta.label,
			color: meta.color,
			command,
			delayMs: meta.delayMs,
			step: meta.confirmations > 1 ? `${step} of ${meta.confirmations}` : undefined,
		}, signal);
		if (!approved || signal?.aborted) return false;
	}
	return true;
}

/** Cancel the waiter promptly, but keep its queue slot until preceding UI closes. */
export function createSerialConfirmation(confirm = confirmGatedCommand) {
	let tail: Promise<void> = Promise.resolve();
	return (
		ctx: ExtensionContext,
		category: Category,
		command: string,
		signal: AbortSignal | undefined = ctx.signal,
		isCurrent: () => boolean = () => true,
	): Promise<boolean> => {
		if (signal?.aborted || !isCurrent()) return Promise.resolve(false);
		const execution = tail.then(async () => {
			if (signal?.aborted || !isCurrent()) return false;
			const approved = await confirm(ctx, category, command, signal);
			return approved && !signal?.aborted && isCurrent();
		});
		// Never advance the tail merely because a queued/active caller stopped waiting.
		tail = execution.then(() => {}, () => {});
		return new Promise<boolean>((resolve, reject) => {
			const abort = () => resolve(false);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			execution.then(
				(value) => {
					signal?.removeEventListener("abort", abort);
					resolve(value);
				},
				(error) => {
					signal?.removeEventListener("abort", abort);
					reject(error);
				},
			);
		});
	};
}
