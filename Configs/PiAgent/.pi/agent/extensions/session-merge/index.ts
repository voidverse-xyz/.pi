/**
 * Session Merge - synthesize multiple Pi session branches into a new session.
 *
 * Usage:
 *   /merge
 *   /merge <entry-id-or-label> <entry-id-or-label> [...]
 *
 * This is intentionally a synthesis merge, not an in-place tree rewrite:
 * selected branches stay untouched, and the merged continuation starts in a
 * new session with a visible context message.
 */

import { complete, type Message } from "@earendil-works/pi-ai/compat";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
	type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "session-merge";
const MAX_SELECTED_BRANCHES = 6;
const MAX_BASE_CHARS = 30_000;
const MAX_BRANCH_CHARS = 60_000;
const MAX_TOTAL_CHARS = 180_000;

interface SourceBranch {
	id: string;
	label?: string;
	type: string;
	timestamp: string;
	preview: string;
	branch: SessionEntry[];
}

interface MergeDetails {
	version: 1;
	createdAt: string;
	sourceSession?: string;
	baseId?: string;
	sources: Array<{
		id: string;
		label?: string;
		type: string;
		timestamp: string;
	}>;
}

const SYSTEM_PROMPT = `You merge alternate Pi agent session branches by synthesis.

Create a self-contained merge context for a new continuation session. The output must:

1. Preserve the shared base context needed to continue.
2. Summarize each selected branch separately.
3. Identify agreements, conflicts, abandoned ideas, and unresolved questions.
4. List concrete files, commands, decisions, and user preferences mentioned in the branches.
5. Recommend the next practical step.

Do not claim work is complete unless the branch text supports it. If branches disagree, keep the conflict explicit.`;

const DEFAULT_KICKOFF = [
	"Continue from the session-merge context above.",
	"First call out any unresolved conflicts or assumptions from the merge.",
	"Then proceed with the next practical step. If the next task is unclear, ask me.",
].join("\n");

export default function sessionMerge(pi: ExtensionAPI): void {
	pi.registerCommand("merge", {
		description: "Merge selected session branches into a new synthesized session",
		handler: async (args, ctx) => runMerge(pi, ctx, args),
	});
}

async function runMerge(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("merge requires an interactive UI", "error");
		return;
	}

	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	await ctx.waitForIdle();

	const selected = args.trim()
		? resolveSourcesFromArgs(ctx, args)
		: await selectSourcesInteractively(ctx);

	if (!selected) return;

	if (selected.length < 2) {
		ctx.ui.notify("Select at least two branches to merge", "warning");
		return;
	}

	if (selected.length > MAX_SELECTED_BRANCHES) {
		ctx.ui.notify(`Select ${MAX_SELECTED_BRANCHES} branches or fewer`, "warning");
		return;
	}

	const commonAncestor = findCommonAncestor(selected.map((source) => source.branch));
	const prompt = buildMergePrompt(selected, commonAncestor);
	const currentSessionFile = ctx.sessionManager.getSessionFile();

	const mergeContext = await generateMergeContext(ctx, prompt);
	if (!mergeContext) {
		ctx.ui.notify("Merge context generation cancelled or failed", "warning");
		return;
	}

	const editedContext = await ctx.ui.editor("Edit merge context", mergeContext);
	if (editedContext === undefined) {
		ctx.ui.notify("Merge cancelled", "info");
		return;
	}

	const action = await ctx.ui.select("Create merged session", [
		"Draft kickoff in editor",
		"Run kickoff now",
		"Create session only",
		"Cancel",
	]);
	if (!action || action === "Cancel") {
		ctx.ui.notify("Merge cancelled", "info");
		return;
	}

	const labelChoice = await ctx.ui.select("Source branch labels", [
		"Leave labels unchanged",
		"Label unlabeled sources as merged",
	]);
	if (!labelChoice) {
		ctx.ui.notify("Merge cancelled", "info");
		return;
	}

	if (labelChoice === "Label unlabeled sources as merged") {
		labelUnlabeledSources(pi, ctx, selected);
	}

	const details: MergeDetails = {
		version: 1,
		createdAt: new Date().toISOString(),
		sourceSession: currentSessionFile,
		baseId: commonAncestor?.id,
		sources: selected.map((source) => ({
			id: source.id,
			label: source.label,
			type: source.type,
			timestamp: source.timestamp,
		})),
	};

	const sessionName = buildSessionName(selected);
	const result = await ctx.newSession({
		parentSession: currentSessionFile,
		setup: async (sessionManager) => {
			sessionManager.appendSessionInfo(sessionName);
			sessionManager.appendCustomMessageEntry(EXTENSION_ID, editedContext, true, details);
			sessionManager.appendCustomEntry(EXTENSION_ID, details);
		},
		withSession: async (replacementCtx) => {
			if (action === "Run kickoff now") {
				replacementCtx.sendUserMessage(DEFAULT_KICKOFF);
				return;
			}
			if (action === "Draft kickoff in editor") {
				replacementCtx.ui.setEditorText(DEFAULT_KICKOFF);
				replacementCtx.ui.notify("Merged session ready. Review and submit the kickoff prompt.", "info");
				return;
			}
			replacementCtx.ui.notify("Merged session created.", "info");
		},
	});

	if (result.cancelled) {
		ctx.ui.notify("Merged session creation cancelled", "info");
	}
}

function resolveSourcesFromArgs(ctx: ExtensionCommandContext, args: string): SourceBranch[] | undefined {
	const refs = args
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter(Boolean);

	if (refs.length === 0) return undefined;

	const allEntries = ctx.sessionManager.getEntries();
	const resolvedIds: string[] = [];
	const currentLeafId = ctx.sessionManager.getLeafId();

	if (refs.length === 1 && currentLeafId) {
		resolvedIds.push(currentLeafId);
	}

	for (const ref of refs) {
		const entry = resolveEntryRef(ctx, allEntries, ref);
		if (!entry) {
			ctx.ui.notify(`Could not resolve entry or label: ${ref}`, "error");
			return undefined;
		}
		resolvedIds.push(entry.id);
	}

	const uniqueIds = [...new Set(resolvedIds)];
	const sources = uniqueIds.map((id) => sourceFromEntry(ctx, ctx.sessionManager.getEntry(id)!));
	return sources;
}

async function selectSourcesInteractively(ctx: ExtensionCommandContext): Promise<SourceBranch[] | undefined> {
	const leaves = collectLeaves(ctx.sessionManager.getTree()).map((entry) => sourceFromEntry(ctx, entry));

	if (leaves.length < 2) {
		ctx.ui.notify("This session does not have at least two branch leaves to merge", "warning");
		return undefined;
	}

	const selected = new Map<string, SourceBranch>();
	const optionToSource = new Map<string, SourceBranch>();

	while (selected.size < MAX_SELECTED_BRANCHES) {
		optionToSource.clear();

		const options: string[] = [];
		for (const source of leaves) {
			if (selected.has(source.id)) continue;
			const option = formatSourceOption(ctx, source);
			optionToSource.set(option, source);
			options.push(option);
		}

		if (selected.size >= 2) {
			options.unshift("Done - merge selected branches");
		}
		options.push("Cancel");

		const choice = await ctx.ui.select(`Select branches to merge (${selected.size} selected)`, options);
		if (!choice || choice === "Cancel") return undefined;
		if (choice === "Done - merge selected branches") break;

		const source = optionToSource.get(choice);
		if (source) selected.set(source.id, source);
	}

	return [...selected.values()];
}

function resolveEntryRef(ctx: ExtensionCommandContext, entries: SessionEntry[], ref: string): SessionEntry | undefined {
	const exact = ctx.sessionManager.getEntry(ref);
	if (exact) return exact;

	const byPrefix = entries.filter((entry) => entry.id.startsWith(ref));
	if (byPrefix.length === 1) return byPrefix[0];

	const byLabel = entries.filter((entry) => ctx.sessionManager.getLabel(entry.id) === ref);
	if (byLabel.length === 1) return byLabel[0];

	return undefined;
}

function sourceFromEntry(ctx: ExtensionCommandContext, entry: SessionEntry): SourceBranch {
	const branch = ctx.sessionManager.getBranch(entry.id);
	return {
		id: entry.id,
		label: ctx.sessionManager.getLabel(entry.id),
		type: entry.type,
		timestamp: entry.timestamp,
		preview: previewEntry(entry),
		branch,
	};
}

function collectLeaves(nodes: SessionTreeNode[]): SessionEntry[] {
	const leaves: SessionEntry[] = [];
	for (const node of nodes) {
		if (node.children.length === 0) {
			leaves.push(node.entry);
		} else {
			leaves.push(...collectLeaves(node.children));
		}
	}
	return leaves;
}

function findCommonAncestor(branches: SessionEntry[][]): SessionEntry | undefined {
	const shortest = Math.min(...branches.map((branch) => branch.length));
	let common: SessionEntry | undefined;

	for (let i = 0; i < shortest; i++) {
		const id = branches[0]?.[i]?.id;
		if (!id || !branches.every((branch) => branch[i]?.id === id)) break;
		common = branches[0]![i];
	}

	return common;
}

function buildMergePrompt(sources: SourceBranch[], commonAncestor: SessionEntry | undefined): string {
	const baseEntries = commonAncestor ? sources[0]!.branch.slice(0, sources[0]!.branch.findIndex((entry) => entry.id === commonAncestor.id) + 1) : [];
	const baseText = limitText(serializeEntries(baseEntries), MAX_BASE_CHARS);

	const branchSections: string[] = [];
	let totalChars = baseText.length;

	for (const [index, source] of sources.entries()) {
		const ancestorIndex = commonAncestor
			? source.branch.findIndex((entry) => entry.id === commonAncestor.id)
			: -1;
		const deltaEntries = source.branch.slice(ancestorIndex + 1);
		const sourceName = source.label ? `${source.label} (${source.id})` : source.id;
		const body = limitText(serializeEntries(deltaEntries), MAX_BRANCH_CHARS);
		totalChars += body.length;

		branchSections.push(
			[
				`<branch index="${index + 1}" source="${escapeAttr(sourceName)}" leaf="${source.id}">`,
				body || "(no serializable conversation entries in this branch delta)",
				"</branch>",
			].join("\n"),
		);
	}

	const joinedBranches = limitText(branchSections.join("\n\n"), Math.max(20_000, MAX_TOTAL_CHARS - baseText.length));
	const truncatedNote =
		totalChars > MAX_TOTAL_CHARS
			? "\n\nNote: Some branch text was truncated before summarization because the selected branches were large."
			: "";

	return [
		"Merge these Pi session branches into a continuation context.",
		"Use the shared base as common background, then compare the branch deltas.",
		truncatedNote,
		"",
		commonAncestor ? `<shared_base leaf="${commonAncestor.id}">` : "<shared_base>",
		baseText || "(no shared base)",
		"</shared_base>",
		"",
		joinedBranches,
	].join("\n");
}

async function generateMergeContext(ctx: ExtensionCommandContext, prompt: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating merge context with ${ctx.model!.id}...`);
		loader.onAbort = () => done(undefined);

		const run = async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
			}

			const message: Message = {
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model!,
				{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					maxTokens: 8192,
					signal: loader.signal,
				},
			);

			if (response.stopReason === "aborted") return undefined;

			return response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
		};

		run()
			.then((summary) => done(summary || undefined))
			.catch((error) => {
				console.error("Session merge failed:", error);
				done(undefined);
			});

		return loader;
	});
}

function labelUnlabeledSources(pi: ExtensionAPI, ctx: ExtensionCommandContext, sources: SourceBranch[]): void {
	const stamp = new Date().toISOString().slice(0, 10);
	for (const source of sources) {
		if (ctx.sessionManager.getLabel(source.id)) continue;
		pi.setLabel(source.id, `merged-${stamp}`);
	}
}

function buildSessionName(sources: SourceBranch[]): string {
	const names = sources.map((source) => source.label || source.id).join(" + ");
	const full = `Merge: ${names}`;
	return full.length > 80 ? `${full.slice(0, 77)}...` : full;
}

function formatSourceOption(ctx: ExtensionCommandContext, source: SourceBranch): string {
	const current = ctx.sessionManager.getLeafId() === source.id ? " current" : "";
	const label = source.label ? ` ${source.label}` : "";
	const preview = source.preview ? ` - ${source.preview}` : "";
	return `${source.id}${current}${label} [${source.type}]${preview}`;
}

function serializeEntries(entries: SessionEntry[]): string {
	const sections = entries.map(serializeEntry).filter(Boolean);
	return sections.join("\n\n");
}

function serializeEntry(entry: SessionEntry): string {
	if (entry.type === "message") {
		const role = entry.message.role;
		return `[${entry.id}] ${role}:\n${contentToText(entry.message.content)}`;
	}

	if (entry.type === "compaction") {
		return `[${entry.id}] compaction summary:\n${entry.summary}`;
	}

	if (entry.type === "branch_summary") {
		return `[${entry.id}] branch summary from ${entry.fromId}:\n${entry.summary}`;
	}

	if (entry.type === "custom_message") {
		return `[${entry.id}] custom message (${entry.customType}):\n${contentToText(entry.content)}`;
	}

	if (entry.type === "model_change") {
		return `[${entry.id}] model change: ${entry.provider}/${entry.modelId}`;
	}

	if (entry.type === "thinking_level_change") {
		return `[${entry.id}] thinking level: ${entry.thinkingLevel}`;
	}

	return "";
}

function previewEntry(entry: SessionEntry): string {
	let text = "";
	if (entry.type === "message") text = contentToText(entry.message.content);
	else if (entry.type === "compaction") text = entry.summary;
	else if (entry.type === "branch_summary") text = entry.summary;
	else if (entry.type === "custom_message") text = contentToText(entry.content);
	else if (entry.type === "model_change") text = `${entry.provider}/${entry.modelId}`;
	else if (entry.type === "thinking_level_change") text = entry.thinkingLevel;

	return singleLine(limitText(text, 90));
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as Record<string, unknown>;

		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			parts.push(`[thinking]\n${block.thinking}`);
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			parts.push(`Tool call: ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}

	return parts.join("\n");
}

function limitText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.55);
	const tail = Math.max(0, maxChars - head - 80);
	return `${text.slice(0, head)}\n\n[... truncated ${text.length - head - tail} characters ...]\n\n${text.slice(-tail)}`;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
