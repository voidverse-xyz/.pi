/**
 * Agent focus switching: the presenter side.
 *
 * Producer extensions (pi-subagents, pi-teams, pi-swarm) publish their live agents as plain
 * data over `pi.events`; this file merges those rosters, owns the cycle key and
 * Esc, and formats the footer indicator. Producers render the focused agent's
 * conversation view and choose whether to accept typed mail or stay read-only. No package imports
 * another — each side works, or quietly does nothing, without the other:
 *
 *   agent-focus:roster          producer → presenter  { source, noun, agents: [{ id, name, working }] }
 *   agent-focus:roster-request  presenter → producers  (republish your roster now)
 *   agent-focus:focus           presenter → producers  { source, id } | null
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FOCUS_KEY = "alt+n";

const ROSTER_EVENT = "agent-focus:roster";
const ROSTER_REQUEST_EVENT = "agent-focus:roster-request";
const FOCUS_EVENT = "agent-focus:focus";

interface FocusAgent {
	id: string;
	name: string;
	working: boolean;
}

interface Roster {
	source: string;
	noun: string;
	agents: FocusAgent[];
}

interface FocusTarget {
	source: string;
	id: string;
}

export interface AgentIndicator {
	text: string;
	focused: boolean;
}

export interface AgentFocus {
	indicator(): AgentIndicator | null;
	reset(): void;
}

export function createAgentFocus(pi: ExtensionAPI, requestRender: () => void): AgentFocus {
	const rosters = new Map<string, Roster>();
	let focused: FocusTarget | null = null;
	let currentContext: ExtensionContext | undefined;

	pi.events.on(ROSTER_EVENT, (data) => {
		const roster = parseRoster(data);
		if (!roster) return;
		rosters.set(roster.source, roster);
		if (focused && focusedPosition() < 0) clearFocus();
		requestRender();
	});

	pi.registerShortcut(FOCUS_KEY, {
		description: "Focus the next subagent, team agent or swarm agent (Esc returns to the main chat)",
		handler: (ctx) => { currentContext = ctx; if (ctx.mode === "tui") focusNext(ctx); },
	});

 pi.events.on("agent-focus:navigate", data => {
  const value = data as { source?: string; id?: string; action?: string; targetId?: string } | null;
  if (!focused || value?.source !== focused.source || value.id !== focused.id) return;
  if (value.action === "back") clearFocus();
  else if (value.action === "next" && currentContext) focusNext(currentContext);
  else if (value.action === "select" && typeof value.targetId === "string") {
   const selected = allAgents().find(agent => agent.source === focused!.source && agent.id === value.targetId);
   if (!selected) return;
   focused = { source: selected.source, id: selected.id };
   pi.events.emit(FOCUS_EVENT, { ...focused, position: focusedPosition() + 1, total: allAgents().length });
   requestRender();
  }
 });
 pi.on("ui_prompt_start", clearFocus);
 pi.on("session_shutdown", () => { clearFocus(); rosters.clear(); currentContext = undefined; });

	function focusNext(ctx: ExtensionContext): void {
		const agents = allAgents();
		if (agents.length === 0) {
			ctx.ui.notify("No agents are available.", "info");
			return;
		}
		// Past the last agent, the cycle returns to the main chat.
		const next = agents[focusedPosition() + 1];
		if (!next) return clearFocus();

		focused = { source: next.source, id: next.id };
		pi.events.emit(FOCUS_EVENT, { ...focused, position: focusedPosition() + 1, total: agents.length });
		requestRender();
	}

	function clearFocus(): void {
		if (!focused) return;
		focused = null;
		pi.events.emit(FOCUS_EVENT, null);
		requestRender();
	}

	function allAgents(): Array<FocusAgent & { source: string }> {
		const sources = Array.from(rosters.keys()).sort();
		return sources.flatMap((source) => rosters.get(source)!.agents.map((agent) => ({ ...agent, source })));
	}

	function focusedPosition(): number {
		if (!focused) return -1;
		const target = focused;
		return allAgents().findIndex((agent) => agent.source === target.source && agent.id === target.id);
	}

	return {
		indicator() {
			const agents = allAgents();
			if (agents.length === 0) return null;

			const position = focusedPosition();
			if (position >= 0) {
				const agent = agents[position]!;
				const noun = rosters.get(agent.source)!.noun;
				return { text: `[${position + 1}/${agents.length}] ${agent.name} (${noun}) · esc back`, focused: true };
			}

			const counts = Array.from(rosters.values())
				.filter((roster) => roster.agents.length > 0)
				.sort((a, b) => a.source.localeCompare(b.source))
				.map((roster) => `${roster.agents.length} ${roster.noun}${roster.agents.length === 1 ? "" : "s"}`);
			const working = agents.filter((agent) => agent.working).length;
			const workingText = working > 0 ? ` · ${working} working` : "";
			return { text: `[${agents.length}] ${counts.join(" · ")}${workingText} · ${FOCUS_KEY}`, focused: false };
		},
		// A new session starts unfocused; producers republish whatever they still hold.
		reset() {
			clearFocus();
			rosters.clear();
			pi.events.emit(ROSTER_REQUEST_EVENT, undefined);
		},
	};
}

function parseRoster(data: unknown): Roster | null {
	const value = data as Partial<Roster> | null;
	if (!value || typeof value.source !== "string" || typeof value.noun !== "string" || !Array.isArray(value.agents)) return null;
	const agents = value.agents.filter(
		(agent): agent is FocusAgent => typeof agent?.id === "string" && typeof agent.name === "string",
	);
	const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, " ");
 const unique = new Map(agents.filter(agent => agent.id.length > 0).map(agent => [agent.id,
  { id: agent.id, name: clean(agent.name), working: agent.working === true }]));
 return { source: value.source, noun: clean(value.noun), agents: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
