/**
 * Shared gg / scroll-key handling for the show-files panel's four scrollable
 * surfaces (curated file list, raw file preview, rendered preview, directory
 * browser). Pure extraction of the previously copy-pasted `gg` double-tap
 * blocks and up/down/page/half-page ladders in panel.ts — each surface differs
 * only in how it jumps and by how much it pages, expressed here as a small
 * ScrollTarget object.
 */

import type { NavKeys } from "./keys.ts";

/**
 * One step of the vi-style `gg` (double-tap go-to-top) state machine.
 * `handled` means the key was `g` and is consumed; `pendingG` is the caller's
 * next pending state (always false for non-`g` keys — any other key cancels a
 * pending `g`). `jumpTop` runs on the second `g` and should include the rerender.
 */
export function handleGG(
	isGoTop: boolean,
	pendingG: boolean,
	jumpTop: () => void,
): { handled: boolean; pendingG: boolean } {
	if (!isGoTop) return { handled: false, pendingG: false };
	if (pendingG) {
		jumpTop();
		return { handled: true, pendingG: false };
	}
	return { handled: true, pendingG: true };
}

export interface ScrollTarget {
	/** Jump to the very end (G). */
	toBottom(): void;
	/** Move the cursor/scroll position by a signed number of rows (clamped by the target). */
	move(delta: number): void;
	/** Rows in one full page (the page-up/down step). */
	page(): number;
	/** Rows in one half page; defaults to max(1, floor(page()/2)). */
	halfPage?(): number;
}

/**
 * The shared G/↑↓/page/half-page ladder. Returns true when `data` was one of
 * the scroll keys and the action ran (the caller then rerenders); false leaves
 * the key unhandled.
 */
export function applyScrollKeys(keys: NavKeys, data: string, target: ScrollTarget): boolean {
	const half = () => target.halfPage?.() ?? Math.max(1, Math.floor(target.page() / 2));
	if (keys.goBottom(data)) target.toBottom();
	else if (keys.up(data)) target.move(-1);
	else if (keys.down(data)) target.move(1);
	else if (keys.pageUp(data)) target.move(-target.page());
	else if (keys.pageDown(data)) target.move(target.page());
	else if (keys.halfPageUp(data)) target.move(-half());
	else if (keys.halfPageDown(data)) target.move(half());
	else return false;
	return true;
}
