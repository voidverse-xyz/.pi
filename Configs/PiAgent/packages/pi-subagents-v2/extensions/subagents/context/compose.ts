/**
 * context/compose.ts — subagent context composition (D18). PURE.
 *
 * D18's six fixed layers, and who owns each:
 *   1. Pi base            — createAgentSession's own system prompt (tools, cwd)
 *   2. Project context    — AGENTS.md et al; toggled here via projectContext,
 *                           loaded by the runtime's resource loader
 *   3. Type body          — role prose from the type .md (live-resolved, D6)
 *   4. Runtime identity   — deterministic block composed here: address,
 *                           purview, team roster WITH purviews, comm powers,
 *                           non-blocking-question + checkpoint conventions
 *   5. Own session history— the persistent Pi-native JSONL (runtime)
 *   6. Per-turn input     — task / wake digest (runtime, Phase 3)
 *
 * This module owns layers 3+4 (as append-system-prompt segments) and the
 * layer-2 decision flag. Deliberately NOT composed here: the main agent's
 * conversation ("context by briefing, not osmosis"), other agents'
 * transcripts, mail not addressed to the agent.
 *
 * // DEVIATION: Pi's buildSystemPrompt places appendSystemPrompt segments
 * (layers 3+4) BEFORE the <project_context> block (layer 2) in the final
 * prompt text, so the effective order is 1,3,4,2 — all D18 layers are present
 * but the 2↔3 order is fixed by the SDK and not overridable without
 * reimplementing Pi's base prompt (which would break layer 1's "evolves with
 * Pi for free" property).
 *
 * Pure module: values in, strings out. No fs, no runtime imports.
 */

import type { TypeDefinition } from "../typedefs/parse.ts";

// ---------------------------------------------------------------------------
// Identity block (layer 4)
// ---------------------------------------------------------------------------

/** One teammate line in the roster ("the roster is what makes peer messaging usable"). */
export interface TeammateInfo {
	/** `<type>/<id>`. */
	address: string;
	purview: string;
}

export interface TeamRoster {
	team: string;
	/** Teammates EXCLUDING the agent itself. */
	teammates: TeammateInfo[];
}

export interface IdentityOptions {
	/** `<type>/<id>`. */
	address: string;
	/** What this instance owns (D5 purview slug or richer prose). */
	purview: string;
	/** Every team the agent belongs to, with teammate rosters. */
	teams: TeamRoster[];
}

/**
 * Layer 4: the deterministic runtime identity block. Covers, in D18's spirit:
 * who the agent is, what it owns, who it can talk to (with purviews), what
 * its comm powers are (the 01-power-matrix sub→sub row + reverse channel),
 * and the non-blocking-question + checkpoint conventions (D14).
 */
export function composeIdentityBlock(options: IdentityOptions): string {
	const lines: string[] = [];
	lines.push("## Your identity");
	lines.push("");
	lines.push(`You are a subagent with the address \`${options.address}\`.`);
	lines.push(`Your purview: ${options.purview}.`);
	lines.push(
		"You work under a main agent (address `main`), which assigns your tasks and reads your reports.",
	);
	lines.push("");

	if (options.teams.length > 0) {
		lines.push("## Your team");
		lines.push("");
		for (const { team, teammates } of options.teams) {
			lines.push(`Team \`${team}\`:`);
			if (teammates.length === 0) {
				lines.push("- (no other members yet)");
			} else {
				for (const mate of teammates) {
					lines.push(`- \`${mate.address}\` — ${mate.purview}`);
				}
			}
			lines.push("");
		}
		lines.push("Roster changes will be announced to you when you wake.");
		lines.push("");
	}

	lines.push("## Communication");
	lines.push("");
	if (options.teams.length > 0) {
		lines.push(
			"- You may send messages to your teammates (listed above) and to the main agent. " +
				"Messages to agents outside your teams will bounce.",
		);
	} else {
		lines.push(
			"- You are a solo worker: you can only communicate with the main agent. " +
				"You have no peer channels.",
		);
	}
	lines.push(
		"- Your channel to the main agent carries reports (progress or final results), " +
			"questions (when you need an answer to proceed), and errors.",
	);
	lines.push(
		"- Messages are mail, not interrupts: they are delivered to the recipient at its " +
			"next turn boundary or when it wakes. You cannot steer, interrupt, observe, or " +
			"spawn other agents.",
	);
	lines.push("");
	lines.push("## Conventions");
	lines.push("");
	lines.push(
		"- Questions are non-blocking: when you ask one, END YOUR TURN. You will go " +
			"dormant and be woken with the answer quoted next to your question. Never " +
			"busy-wait or poll for a reply.",
	);
	lines.push(
		"- Before ending a turn on a question (or any pause), jot a one-line checkpoint " +
			'in your response, e.g. "paused mid-X; next: Y" — it is the first thing ' +
			"future-you reads on wake.",
	);
	lines.push(
		"- Your session is persistent memory: it survives across wakes. Keep it useful — " +
			"summarize outcomes, don't re-derive what you already established.",
	);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full composition
// ---------------------------------------------------------------------------

export interface ComposedContext {
	/** Layer-2 toggle: whether the runtime should load AGENTS.md et al (D18/D19). */
	includeProjectContext: boolean;
	/**
	 * Append-system-prompt segments in order: [layer 3 type body, layer 4
	 * identity block]. Pi joins them with blank lines after its base prompt.
	 */
	appendSystemPrompt: string[];
}

/** Compose everything this module owns for one agent instance wake. */
export function composeContext(def: TypeDefinition, identity: IdentityOptions): ComposedContext {
	const segments: string[] = [];
	if (def.body.trim().length > 0) segments.push(def.body.trim());
	segments.push(composeIdentityBlock(identity));
	return {
		includeProjectContext: def.config.projectContext,
		appendSystemPrompt: segments,
	};
}
