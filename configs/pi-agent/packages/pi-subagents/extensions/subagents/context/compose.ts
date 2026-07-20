/**
 * context/compose.ts — subagent context composition. PURE.
 *
 * Six layers, and who owns each:
 *   1. Pi base            — createAgentSession's own system prompt (tools, cwd)
 *   2. Project context    — AGENTS.md et al; loaded NATIVELY by Pi (gated by the
 *                           type's projectContext flag via the resource loader).
 *   3. Type body          — role prose from the type/adhoc def (live-resolved)
 *   4. Runtime identity   — deterministic block composed here: address, purview,
 *                           hub-and-spoke comm powers, conventions
 *   5. Own session history — the persistent Pi-native JSONL (runtime)
 *   6. Per-turn input     — task / wake digest (runtime)
 *
 * This module owns layers 3+4 as ORDERED appendSystemPrompt segments.
 * Hub-and-spoke: there is NO peer roster and no peer prose — a subagent's only
 * channel is `report` to the main agent.
 *
 * Pure module: values in, strings out. No fs, no runtime imports.
 */

import type { TypeDefinition } from "../typedefs/parse.ts";

export interface IdentityOptions {
	/** `<type>/<id>`. */
	address: string;
	/** What this instance owns (purview slug or richer prose). */
	purview: string;
	/** Oneshots are told their session ends at the final report. */
	lifetime: "persistent" | "oneshot";
}

/**
 * Layer 4: the deterministic runtime identity block — who the agent is, what it
 * owns, its single communication channel, and the early-ambiguity + final-report
 * conventions.
 */
export function composeIdentityBlock(options: IdentityOptions): string {
	const lines: string[] = [];
	lines.push("## Your identity");
	lines.push("");
	lines.push(`You are a subagent with the address \`${options.address}\`.`);
	lines.push(`Your purview: ${options.purview}.`);
	lines.push("You work under a main agent (address `main`), which assigns your tasks and reads your reports.");
	lines.push("");

	lines.push("## Communication");
	lines.push("");
	lines.push(
		"- Your ONLY channel is the `report` tool, to the main agent: actionable progress or blocker reports along the way, " +
			"and exactly one FINAL report (final:true) when your assigned task is complete.",
	);
	lines.push(
		"- There are no other agents you can reach. You cannot message, observe, steer, or spawn " +
			"other agents, and you cannot ask the main agent a question mid-task and wait for a reply.",
	);
	lines.push("- Messages are mail, not interrupts: new instructions reach you at your next turn boundary.");
	lines.push("");

	lines.push("## Conventions");
	lines.push("");
	lines.push(
		"- The main agent only learns what you tell it — never finish silently. When your assigned " +
			"task is complete, send a FINAL report (the `report` tool with final:true); send progress " +
			"reports only for actionable milestones or blockers. Never send a report merely to announce " +
			"that you are starting or to restate the assignment.",
	);
	lines.push(
		"- Surface blocking ambiguity EARLY: sanity-check the assignment before deep work. If something " +
			"prevents a correct result, do not grind through guesswork — send an early FINAL report that " +
			"states what you did, what is blocked, and what you need to know under an `Open questions:` " +
			"heading. The main agent will follow up or respawn with a clarified brief.",
	);
	lines.push(
		"- Before ending a turn, jot a one-line checkpoint in your response, e.g. " +
			'"paused mid-X; next: Y" — it is the first thing future-you reads on wake.',
	);
	if (options.lifetime === "persistent") {
		lines.push(
			"- Your session is persistent memory: it survives across wakes and follow-up tasks. Keep it " +
				"useful — summarize outcomes, don't re-derive what you already established.",
		);
	} else {
		lines.push(
			"- You are a ONESHOT agent: after your final report you are retired (your transcript is kept " +
				"for the record). Put everything the main agent needs INTO the final report — there is no " +
				"follow-up conversation.",
		);
	}

	return lines.join("\n");
}

export interface ComposedContext {
	/** appendSystemPrompt segments in order: [type body (if any), identity block]. */
	appendSystemPrompt: string[];
}

/**
 * Compose layers 3+4 for one agent instance wake. Layer 2 is Pi's own (native
 * ordering).
 */
export function composeContext(def: TypeDefinition, identity: IdentityOptions): ComposedContext {
	const segments: string[] = [];
	if (def.body.trim().length > 0) segments.push(def.body.trim());
	segments.push(composeIdentityBlock(identity));
	return { appendSystemPrompt: segments };
}
