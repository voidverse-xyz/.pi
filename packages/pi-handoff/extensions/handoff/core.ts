import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function timestampOf(entry: SessionEntry): number {
	return new Date(entry.timestamp).getTime();
}

function textMessage(content: string, timestamp: number): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: content }],
		timestamp,
	};
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;

	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: timestampOf(entry),
		};
	}

	if (entry.type === "branch_summary") {
		return textMessage(`Previous branch summary:\n${entry.summary}`, timestampOf(entry));
	}

	if (entry.type === "custom_message") {
		const content = typeof entry.content === "string"
			? entry.content
			: entry.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		if (content.trim()) return textMessage(content, timestampOf(entry));
	}

	return undefined;
}

export function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let latestCompactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index]?.type === "compaction") {
			latestCompactionIndex = index;
			break;
		}
	}

	let relevantEntries = branch;
	if (latestCompactionIndex >= 0) {
		const compaction = branch[latestCompactionIndex]!;
		const firstKeptIndex = compaction.type === "compaction"
			? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
			: -1;
		const retainedEntries = firstKeptIndex >= 0
			? branch.slice(firstKeptIndex, latestCompactionIndex)
			: [];
		relevantEntries = [
			compaction,
			...retainedEntries,
			...branch.slice(latestCompactionIndex + 1),
		];
	}

	return relevantEntries
		.map(entryToMessage)
		.filter((message): message is AgentMessage => message !== undefined);
}

export function buildSummaryPrompt(conversation: string, focus: string): string {
	const focusSection = focus
		? `\n\n## Requested focus for the new session\n${focus}`
		: "";
	return `## Conversation transcript\n\n${conversation}${focusSection}`;
}

export function buildSessionName(currentName: string | undefined): string {
	if (!currentName) return "Handoff";
	const name = `Handoff: ${currentName}`;
	return name.length <= 80 ? name : `${name.slice(0, 77)}...`;
}

const ESTIMATED_CHARACTERS_PER_TOKEN = 4;

interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

/** Estimate the request with the same four-characters-per-token heuristic Pi uses. */
export function estimateSummaryInputTokens(systemPrompt: string, userPrompt: string): number {
	const systemTokens = Math.ceil(systemPrompt.length / ESTIMATED_CHARACTERS_PER_TOKEN);
	const userTokens = Math.ceil(userPrompt.length / ESTIMATED_CHARACTERS_PER_TOKEN);
	return systemTokens + userTokens;
}

/** Match Pi's compact token formatting for an estimate shown in the loader. */
export function formatTokenEstimate(count: number): string {
	const safe = Math.max(0, Math.round(count));
	if (safe < 1_000) return String(safe);
	if (safe < 10_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000) return `${Math.round(safe / 1_000)}k`;
	if (safe < 10_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${Math.round(safe / 1_000_000)}M`;
}

export function buildGenerationStatus(
	modelId: string,
	estimatedInputTokens: number,
	maxOutputTokens: number,
): string {
	return [
		`Generating handoff summary with ${modelId}...`,
		`Estimated input: ~${formatTokenEstimate(estimatedInputTokens)} tokens`,
		`output limit: ${formatTokenEstimate(maxOutputTokens)}`,
	].join(" · ");
}

function formatExactTokens(count: number): string {
	return Math.max(0, Math.round(count)).toLocaleString("en-US");
}

export function buildUsageNotice(usage: TokenUsage): string {
	const parts = [`${formatExactTokens(usage.input)} input`];
	if (usage.cacheRead > 0) parts.push(`${formatExactTokens(usage.cacheRead)} cache read`);
	if (usage.cacheWrite > 0) parts.push(`${formatExactTokens(usage.cacheWrite)} cache write`);
	parts.push(`${formatExactTokens(usage.output)} output`);

	const componentTotal = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
	const total = usage.totalTokens > 0 ? usage.totalTokens : componentTotal;
	return `Handoff summary used ${parts.join(" + ")} = ${formatExactTokens(total)} tokens.`;
}
