/**
 * context/compose.ts — subagent context composition (D18). PURE.
 *
 * D18's six fixed layers, and who owns each:
 *   1. Pi base            — createAgentSession's own system prompt (tools, cwd)
 *   2. Project context    — AGENTS.md et al; toggled by the type's
 *                           projectContext flag, loaded by the runtime (SDK
 *                           loadProjectContextFiles) and formatted+placed here
 *   3. Type body          — role prose from the type .md (live-resolved, D6)
 *   4. Runtime identity   — deterministic block composed here: address,
 *                           purview, team roster WITH purviews, comm powers,
 *                           non-blocking-question + checkpoint conventions
 *   5. Own session history— the persistent Pi-native JSONL (runtime)
 *   6. Per-turn input     — task / wake digest (runtime, Phase 3)
 *
 * This module owns layers 2+3+4 as ORDERED append-system-prompt segments.
 * Deliberately NOT composed here: the main agent's conversation ("context by
 * briefing, not osmosis"), other agents' transcripts, mail not addressed to
 * the agent.
 *
 * Layer-2 placement (D18 order, was a DEVIATION — now fixed): Pi's
 * buildSystemPrompt hardcodes base → appendSystemPrompt → <project_context>,
 * i.e. 1,3,4,2. So we never let the SDK append its own project context
 * (runtime sets noContextFiles: true unconditionally); instead the runtime
 * loads the resolved context files via the SDK's exported
 * loadProjectContextFiles (same discovery rules as Pi itself) and passes them
 * in, and formatProjectContext() below wraps them in the byte-identical
 * <project_context>/<project_instructions path=...> markup that
 * core/system-prompt.js would have emitted, placed as the FIRST append
 * segment — giving base(1) → project(2) → type body(3) → identity(4).
 * Trade-off: we depend on the SDK's loadProjectContextFiles API and replicate
 * its wrapper format verbatim; if either changes upstream, update here.
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
				"You are not on any team, so peer messages will bounce until the main " +
				"agent puts you on one.",
		);
	}
	lines.push(
		"- Your channel to the main agent carries reports (progress or final results) and " +
			"questions (when you need an answer to proceed). To flag a problem yourself, " +
			"send a report — errors (crashes, budget exhaustion) are raised to the main " +
			"agent automatically.",
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
		"- The main agent only learns what you tell it — never finish silently. When " +
			"your assigned task is complete, send a FINAL report (the `report` tool with " +
			"final:true); send progress reports at meaningful milestones along the way.",
	);
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
// Project context block (layer 2)
// ---------------------------------------------------------------------------

/** One resolved project context file (AGENTS.md et al), as the SDK's loadProjectContextFiles returns them. */
export interface ProjectContextFile {
	path: string;
	content: string;
}

/**
 * Layer 2: wrap resolved project context files in the EXACT markup Pi's own
 * core/system-prompt.js emits (copied verbatim), so the agent sees
 * byte-identical project context to a plain Pi session — only the placement
 * differs (before layers 3+4, per D18). Returns "" when there are no files.
 */
export function formatProjectContext(files: ProjectContextFile[]): string {
	if (files.length === 0) return "";
	let block = "<project_context>\n\n";
	block += "Project-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of files) {
		block += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
	}
	block += "</project_context>";
	return block;
}

// ---------------------------------------------------------------------------
// Full composition
// ---------------------------------------------------------------------------

export interface ComposedContext {
	/**
	 * Append-system-prompt segments in D18 order: [layer 2 project context
	 * (when enabled and non-empty), layer 3 type body, layer 4 identity
	 * block]. Pi joins them with blank lines after its base prompt.
	 */
	appendSystemPrompt: string[];
}

/**
 * Compose everything this module owns for one agent instance wake.
 *
 * `projectContextFiles` are the runtime-loaded AGENTS.md et al (SDK
 * loadProjectContextFiles); pass them only when the type's projectContext
 * flag is on — this stays a pure function, the fs work lives in the runtime.
 * The def's projectContext flag is still honored here as a belt-and-braces
 * gate: files passed for a projectContext:false type are ignored.
 */
export function composeContext(
	def: TypeDefinition,
	identity: IdentityOptions,
	projectContextFiles: ProjectContextFile[] = [],
): ComposedContext {
	const segments: string[] = [];
	if (def.config.projectContext) {
		const projectBlock = formatProjectContext(projectContextFiles);
		if (projectBlock.length > 0) segments.push(projectBlock);
	}
	if (def.body.trim().length > 0) segments.push(def.body.trim());
	segments.push(composeIdentityBlock(identity));
	return { appendSystemPrompt: segments };
}
