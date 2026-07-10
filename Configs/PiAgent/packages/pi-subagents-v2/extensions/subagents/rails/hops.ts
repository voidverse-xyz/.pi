/**
 * rails/hops.ts — the D21 chain-depth rail: kills ping-pong conversations
 * early. PURE (no fs, no clock): values in, verdict out.
 *
 * hops arithmetic lives in mail/deliver.ts (parent.hops + 1 for
 * message-triggered sends; fresh work = 0); this module only judges the
 * number. maxHops default 8 per causal chain: an envelope whose hops would
 * reach the cap bounces with the D21 message — "this conversation has gone N
 * rounds without resolving — report to the main agent instead".
 *
 * The escape route is sacred (D21/02-envelope-contract): the cap applies to
 * peer traffic and question-to-main chains, but NEVER blocks
 * report | escalation | error to main — that upward channel is exactly what
 * the bounce message tells the agent to use, so capping it would trap the
 * failure instead of converting it to an escalation.
 */

import type { HopsGuard, HopsGuardInput } from "../mail/deliver.ts";
import { type EnvelopeType, MAIN_ADDRESS } from "../mail/envelope.ts";

/** D21: maxHops default 8 per causal chain. */
export const DEFAULT_MAX_HOPS = 8;

/** Envelope types to main that are NEVER hops-capped (the escape route). */
const ESCAPE_TYPES: readonly EnvelopeType[] = ["report", "escalation", "error"];

/** True for report/escalation/error addressed to main — the upward escape. */
export function isMainEscape(input: Pick<HopsGuardInput, "to" | "type">): boolean {
	return input.to === MAIN_ADDRESS && ESCAPE_TYPES.includes(input.type);
}

/** The D21 over-cap bounce message. */
export function hopsBounceReason(hops: number, maxHops: number): string {
	return (
		`This conversation has gone ${hops} rounds without resolving (maxHops ${maxHops}) — ` +
		"report to the main agent instead of continuing the exchange."
	);
}

/**
 * Judge one send: allowed while the chain is under the cap, or when it is the
 * upward escape (report/escalation/error to main) at ANY depth.
 */
export function checkHops(
	input: HopsGuardInput,
	maxHops: number = DEFAULT_MAX_HOPS,
): { allowed: true } | { allowed: false; reason: string } {
	if (isMainEscape(input)) return { allowed: true };
	if (input.hops < maxHops) return { allowed: true };
	return { allowed: false, reason: hopsBounceReason(input.hops, maxHops) };
}

/**
 * Build the deliver.ts hopsGuard for a configured cap (PHASE 4 plug-in).
 * A getter keeps the cap LIVE off the settings object (Phase 7) — a plain
 * number stays supported for fixed-cap callers/harnesses.
 */
export function makeHopsGuard(maxHops: number | (() => number) = DEFAULT_MAX_HOPS): HopsGuard {
	return (input) => checkHops(input, typeof maxHops === "function" ? maxHops() : maxHops);
}
