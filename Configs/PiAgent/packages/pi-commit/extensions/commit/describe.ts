import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewGroup } from "./classify.ts";

const DIFF_PROMPT_CAP = 48 * 1024;
const DESCRIPTION_CAP = 800;

const SYSTEM_PROMPT = `Write a concise plain-text description of a proposed Git commit from its diff.
Explain what the commit changes and why it matters in one or two sentences.
Be specific, but do not list every file, repeat the commit title, use Markdown, or mention that you are reading a diff.
Return only the description.`;

export async function generateCommitDescription(
	ctx: ExtensionCommandContext,
	group: ReviewGroup,
	diff: string,
	signal: AbortSignal,
): Promise<string> {
	if (!ctx.model) throw new Error("no model selected");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `no API key for ${ctx.model.provider}` : auth.error);
	}

	const clippedDiff = diff.length <= DIFF_PROMPT_CAP
		? diff
		: `${diff.slice(0, DIFF_PROMPT_CAP)}\n[diff truncated]`;
	const files = group.paths.join(", ");
	const clippedFiles = files.length <= 8 * 1024 ? files : `${files.slice(0, 8 * 1024)}…`;
	const prompt = [
		`Proposed title: ${group.commitMessage}`,
		`Files: ${clippedFiles}`,
		"",
		clippedDiff || "(No textual diff available.)",
	].join("\n");
	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};
	const response = await complete(
		ctx.model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
		{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
	);
	if (response.stopReason === "aborted") throw new Error("generation cancelled");
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) throw new Error("model returned an empty description");
	return text.length <= DESCRIPTION_CAP ? text : `${text.slice(0, DESCRIPTION_CAP - 1).trimEnd()}…`;
}
