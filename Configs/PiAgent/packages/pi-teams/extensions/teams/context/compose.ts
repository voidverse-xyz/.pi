/**
 * context/compose.ts — subagent context composition (D18'). PURE.
 *
 * Six layers, and who owns each:
 *   1. Pi base            — createAgentSession's own system prompt (tools, cwd)
 *   2. Project context    — AGENTS.md et al; loaded NATIVELY by Pi (gated by the
 *                           type's projectContext flag via the resource loader).
 *                           v2 does NOT replicate Pi's <project_context> markup
 *                           (v1's fragile coupling) — we accept Pi's ordering.
 *   3. Type body          — role prose from the type .md (live-resolved, D6)
 *   4. Runtime identity    — deterministic block composed here: address, purview,
 *                           FLAT roster of the main's agents with purviews (no
 *                           teams, D12), comm powers, conventions
 *   5. Own session history — the persistent Pi-native JSONL (runtime)
 *   6. Per-turn input      — task / wake digest (runtime)
 *
 * This module owns layers 3+4 as ORDERED appendSystemPrompt segments. Layer 2 is
 * Pi's own; layers 5+6 are the runtime's. Deliberately NOT here: the main
 * agent's conversation, peers' transcripts, un-addressed mail.
 *
 * Pure module: values in, strings out. No fs, no runtime imports.
 */

import type { TypeDefinition } from "../typedefs/parse.ts";

/** One peer line in the roster ("the roster is what makes peer messaging usable"). */
export interface PeerInfo {
	/** `<type>/<id>`. */
	address: string;
	purview: string;
}

export interface IdentityOptions {
	/** `<type>/<id>`. */
	address: string;
	/** What this instance owns (D5 purview slug or richer prose). */
	purview: string;
	/** Every OTHER agent under the same main (flat comm — D12), with purviews. */
	peers: PeerInfo[];
	/**
	 * Whether this instance may message peers directly (D12). Default true. When
	 * false, the main agent coordinates the team and all cross-agent work routes
	 * through it — the agent has no `send_message` tool.
	 */
	peersEnabled?: boolean;
	/** "oneshot" instances are told their final report also retires them (D13). */
	lifetime?: "persistent" | "oneshot";
}

/**
 * Layer 4: the deterministic runtime identity block — who the agent is, what it
 * owns, who it can talk to (all peers + main, flat), its comm powers, and the
 * non-blocking-question + checkpoint conventions (D14).
 */
export function composeIdentityBlock(options: IdentityOptions): string {
	const peersEnabled = options.peersEnabled !== false;
	const lines: string[] = [];
	lines.push("## Your identity");
	lines.push("");
	lines.push(`You are a subagent with the address \`${options.address}\`.`);
	lines.push(`Your purview: ${options.purview}.`);
	lines.push("You work under a main agent (address `main`), which assigns your tasks and reads your reports.");
	lines.push("");

	lines.push("## Other agents");
	lines.push("");
	if (options.peers.length === 0) {
		lines.push(
			peersEnabled
				? "You are the only subagent right now. You can message the main agent."
				: "You are the only subagent right now. Report to the main agent, which coordinates the team.",
		);
	} else if (peersEnabled) {
		lines.push("You may message any of these peers, or the main agent:");
		for (const peer of options.peers) {
			lines.push(`- \`${peer.address}\` — ${peer.purview}`);
		}
	} else {
		lines.push("These agents work under the same main agent, but you cannot message them directly:");
		for (const peer of options.peers) {
			lines.push(`- \`${peer.address}\` — ${peer.purview}`);
		}
		lines.push("");
		lines.push("The main agent coordinates the team. If another agent needs something from you, put it in a report to the main agent and it will relay.");
	}
	lines.push("");

	lines.push("## Communication");
	lines.push("");
	lines.push(
		"- Your channel to the main agent carries reports (progress or final results) and " +
			"questions (when you need an answer to proceed). Errors (crashes) are raised to the " +
			"main agent automatically.",
	);
	if (peersEnabled) {
		lines.push(
			"- Messages are mail, not interrupts: they are delivered to the recipient at its next " +
				"turn boundary or when it wakes. You cannot steer, interrupt, observe, or spawn other agents.",
		);
	} else {
		lines.push(
			"- Peer messaging is OFF: you have no `send_message` tool and cannot contact other agents. " +
				"Everything cross-agent goes through the main agent. You also cannot steer, interrupt, " +
				"observe, or spawn other agents.",
		);
	}
	lines.push("");
	lines.push("## Conventions");
	lines.push("");
	lines.push(
		"- The main agent only learns what you tell it — never finish silently. When your assigned " +
			"task is complete, send a FINAL report (the `report` tool with final:true); send progress " +
			"reports at meaningful milestones along the way.",
	);
	if (options.lifetime === "oneshot") {
		lines.push(
			"- You are a ONESHOT agent: you exist for this single task. Your final report (final:true) " +
				"is also your sign-off — after it you are automatically retired and your session archived. " +
				"Put everything the main agent needs into that final report; there is no follow-up turn.",
		);
	}
	lines.push(
		"- Questions are non-blocking: when you ask one, END YOUR TURN. You will go dormant and be " +
			"woken with the answer quoted next to your question. Never busy-wait or poll for a reply.",
	);
	lines.push(
		"- Before ending a turn on a question (or any pause), jot a one-line checkpoint in your " +
			'response, e.g. "paused mid-X; next: Y" — it is the first thing future-you reads on wake.',
	);
	lines.push(
		"- Your session is persistent memory: it survives across wakes. Keep it useful — summarize " +
			"outcomes, don't re-derive what you already established.",
	);

	return lines.join("\n");
}

export interface ComposedContext {
	/** appendSystemPrompt segments in order: [type body (if any), identity block]. */
	appendSystemPrompt: string[];
}

/**
 * Compose layers 3+4 for one agent instance wake. Layer 2 is Pi's own (native
 * ordering). `peersEnabled` is the EFFECTIVE peer setting (user/main/per-type
 * resolved by the runtime), not the raw frontmatter default.
 */
export function composeContext(def: TypeDefinition, identity: IdentityOptions): ComposedContext {
	const segments: string[] = [];
	if (def.body.trim().length > 0) segments.push(def.body.trim());
	segments.push(composeIdentityBlock(identity));
	return { appendSystemPrompt: segments };
}
