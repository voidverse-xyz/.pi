/**
 * rails/hops.ts — the chain-depth rail (D21). PURE.
 *
 * Each message-triggered send carries hops = parent.hops + 1 (fresh work = 0).
 * A send whose hops would reach `maxHops` bounces with a "report to main instead"
 * reason — this kills runaway peer ping-pong early. The sacred exception: an
 * upward escape to the main agent (report / escalation / error → main) is NEVER
 * blocked, at any depth, so a stuck chain can always surface itself.
 */

import { type Envelope, MAIN_ADDRESS } from "../mail/envelope.ts";
import type { HopsGuard } from "../mail/deliver.ts";

export const DEFAULT_MAX_HOPS = 8;

// An upward message to main is a safety valve and is NEVER hop-limited — including
// a `question`, which is exactly how a subagent stuck deep in a peer chain surfaces
// a blocking ask to the human/main. (Peer→peer questions are still hop-limited.)
// A plain `message` to main is deliberately NOT an escape: bulk chatter must still
// respect the hop cap; only the structured report/escalation/error/question
// channels are exempt.
const MAIN_ESCAPE_TYPES = new Set<Envelope["type"]>(["report", "escalation", "error", "question"]);

/** An upward escape to main (never hop-limited). */
export function isMainEscape(envelope: Envelope): boolean {
	return envelope.to === MAIN_ADDRESS && MAIN_ESCAPE_TYPES.has(envelope.type);
}

function hopsBounceReason(hops: number, maxHops: number): string {
	return `${hops} rounds unresolved (max ${maxHops}) — report to the main agent instead`;
}

/** Build a hops guard for the deliverer. `maxHops` may be a live getter (settings). */
export function makeHopsGuard(maxHops: number | (() => number)): HopsGuard {
	return (envelope: Envelope): string | null => {
		if (isMainEscape(envelope)) return null;
		const cap = typeof maxHops === "function" ? maxHops() : maxHops;
		return envelope.hops >= cap ? hopsBounceReason(envelope.hops, cap) : null;
	};
}
