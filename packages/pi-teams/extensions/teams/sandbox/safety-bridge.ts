/**
 * sandbox/safety-bridge.ts — human confirmation for subagent tool calls,
 * delegated to pi-safety over `pi.events` (D10a). PURE of pi-safety internals:
 * no import — a runtime rendezvous, so dropping pi-safety can't break loading.
 *
 * Protocol (the pi.events synchronous-claim idiom, as pi-show-files' ipc):
 *   requester: pi.events.emit("teams:confirm-request", { method:"confirm", claim })
 *   provider (pi-safety): during emit, calls claim(async (req) => ConfirmResult)
 *   requester: awaits the claimed fn; if nobody claimed → FAIL CLOSED (deny).
 *
 * Confirmations stay human (no LLM ever approves — D10). The main agent can
 * still DENY a subagent's call via the deny-by-mail channel, but never
 * approve.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONFIRM_CHANNEL = "teams:confirm-request";

export interface ConfirmRequest {
	/** The subagent address making the call. */
	agent: string;
	tool: "bash" | "edit" | "write";
	/** For bash. */
	command?: string;
	/** For edit/write — the absolute target path. */
	path?: string;
}

export interface ConfirmResult {
	approved: boolean;
	/** A note shown to the agent on denial. */
	note?: string;
}

export type ConfirmFn = (request: ConfirmRequest) => Promise<ConfirmResult>;

type ClaimFn = (request: ConfirmRequest) => Promise<ConfirmResult> | ConfirmResult;

/** A claimant that never resolves must not wedge the subagent forever — deny after this. */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Build a confirm function backed by pi-safety over pi.events. Fails CLOSED: if
 * no provider claims (pi-safety absent, or no UI), the call is denied. A claimant
 * that never resolves is also failed closed after CONFIRM_TIMEOUT_MS so a hung
 * provider can't strand the agent (SEC-8).
 *
 * Trust boundary: pi.events is an in-process bus any co-loaded extension can claim.
 * The "human-only approval" guarantee therefore assumes only trusted extensions are
 * loaded — a hostile co-resident extension could claim this channel and self-approve.
 */
export function makeSafetyConfirm(pi: ExtensionAPI): ConfirmFn {
	return (request: ConfirmRequest): Promise<ConfirmResult> => {
		let claimed: ClaimFn | null = null;
		pi.events.emit(CONFIRM_CHANNEL, {
			method: "confirm",
			request,
			claim: (fn: ClaimFn) => {
				claimed = fn;
			},
		});
		if (!claimed) {
			return Promise.resolve({ approved: false, note: "no confirmation provider available (pi-safety not installed or no UI) — failing closed" });
		}
		const answered = Promise.resolve()
			.then(() => (claimed as ClaimFn)(request))
			.then(
				(result) => result,
				(error): ConfirmResult => ({ approved: false, note: error instanceof Error ? error.message : String(error) }),
			);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<ConfirmResult>((resolveTimeout) => {
			timer = setTimeout(() => resolveTimeout({ approved: false, note: "confirmation timed out — failing closed" }), CONFIRM_TIMEOUT_MS);
			(timer as { unref?: () => void }).unref?.();
		});
		return Promise.race([answered, timeout]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	};
}

/** A confirm that always denies — the safe default when no port is wired. */
export const denyAllConfirm: ConfirmFn = () => Promise.resolve({ approved: false, note: "no confirmation provider configured" });
