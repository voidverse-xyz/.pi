/**
 * The core↔look contract.
 *
 * codex-core owns FUNCTIONALITY (commands, tools, approvals, subagents, plan,
 * review). It renders nothing itself — instead it emits semantic custom
 * messages and broadcasts state on pi's shared event bus. Whichever *look*
 * plugin is loaded (codex-look or claude-look) registers renderers for these
 * custom-message types and reads the broadcast state to paint the UI.
 *
 * This file is duplicated verbatim in every look package so each package stays
 * self-contained and independently exportable — the coupling is these strings,
 * nothing else.
 */

/** Custom-message types: core sends `sendMessage({customType})`, look renders. */
export const CARD = {
	status: "cpx.status",
	diff: "cpx.diff",
	plan: "cpx.plan",
	review: "cpx.review",
	agentResult: "cpx.agentResult",
} as const;

/** Event-bus channels: core `emit`s, look `on`s. Data shapes below. */
export const EVT = {
	/** data: string — collaboration mode ("default" | "plan"). */
	mode: "cpx:mode",
	/** data: { approval: string; sandbox: string }. */
	policy: "cpx:policy",
	/** data: string | null — long-running task goal (footer/widget). */
	goal: "cpx:goal",
	/** data: AgentSummary[] — live sub-agent list for the status widget. */
	agents: "cpx:agents",
} as const;

/** Shared mutable state inside codex-core. */
export interface CodexState {
	personality?: "friendly" | "pragmatic";
	goal?: string;
	approvalMode: string;
	sandboxMode: string;
	mode: string;
}

export interface StatusData {
	model: string;
	provider: string;
	reasoning: string;
	directory: string;
	approval: string;
	sandbox: string;
	tokensUsed: number | null;
	contextWindow: number;
	percentLeft: number | null;
	sessionName?: string;
}
export interface DiffData {
	diff: string;
	untrackedCount: number;
}
export interface PlanData {
	explanation?: string;
	plan: { step: string; status: "pending" | "in_progress" | "completed" }[];
}
export interface ReviewData {
	text: string;
}
export interface AgentResultData {
	nickname: string;
	role: string;
	result: string;
}
export interface AgentSummary {
	nickname: string;
	role: string;
	color?: string;
	status: string;
	closed: boolean;
}
