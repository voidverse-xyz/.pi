/**
 * Description-based delegation (Claude Code's auto-delegate ergonomics).
 * Given a task, pick the agent whose `description` best matches. The main model
 * has already decided to delegate by calling the tool; this just routes to the
 * right specialist by scoring word overlap between the task and each
 * description (name matches weighted highest).
 */

import type { AgentDef } from "./loader.ts";

const STOP = new Set(["the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "with", "this", "that", "use", "when", "should", "into", "your", "you"]);

function tokens(s: string): string[] {
	return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

export function pickAgent(task: string, hint: string | undefined, defs: AgentDef[]): { agent?: AgentDef; scores: { name: string; score: number }[] } {
	const q = new Set([...tokens(task), ...tokens(hint ?? "")]);
	const scores = defs.map((d) => {
		const words = new Set([...tokens(d.description), ...tokens(d.name)]);
		let score = 0;
		for (const w of q) if (words.has(w)) score++;
		// Exact name mention in the task is a strong signal.
		if (hint && d.name.toLowerCase() === hint.toLowerCase().trim()) score += 100;
		if (task.toLowerCase().includes(d.name.toLowerCase())) score += 50;
		return { name: d.name, score };
	});
	scores.sort((a, b) => b.score - a.score);
	const best = scores[0];
	if (!best || best.score === 0) return { agent: undefined, scores };
	return { agent: defs.find((d) => d.name === best.name), scores };
}
