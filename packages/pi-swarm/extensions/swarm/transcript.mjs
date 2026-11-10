// Presentation allowlist: never dump session headers, provider replay data or credentials.
const json = value => JSON.stringify(value, null, 2);

/** Preserve every entry in order, including non-conversation context changes. */
export function transcriptText(entries, { usageAvailable = false } = {}) {
	return entries.map((entry, index) => {
		const message = entry.message;
		const role = message?.role ?? entry.type ?? "entry";
		const timestamp = entry.timestamp ?? message?.timestamp;
		const date = typeof timestamp === "number" ? new Date(timestamp) : undefined;
		const time = date ? (Number.isFinite(date.getTime()) ? date.toISOString() : "time unavailable") : timestamp ?? "time unavailable";
		return `── ${index + 1} · ${role} · ${time} · ${entry.id ?? ""} ──\n${entryText(entry, usageAvailable)}`;
	}).join("\n\n");
}

function entryText(entry, usageAvailable) {
	if (entry.message) return messageText(entry.message, usageAvailable);
	switch (entry.type) {
		case "compaction": return `Compaction · ${entry.tokensBefore ?? "unknown"} tokens before\nFirst retained entry: ${entry.firstKeptEntryId}\n${entry.summary}\n${entry.systemMessage ? `System checkpoint:\n${messageText(entry.systemMessage, usageAvailable)}` : ""}`;
		case "context_edit": return `Context edit → ${entry.targetId}\n${entry.replacement === null ? "Omitted from future model context; original remains in history." : contentText(entry.replacement?.content)}`;
		case "branch_summary": return `Branch from ${entry.fromId}\n${entry.summary}`;
		case "custom_message": return `${entry.customType}\n${contentText(entry.content)}`;
		case "model_change": return `Model: ${entry.provider}/${entry.modelId}`;
		case "thinking_level_change": return `Thinking: ${entry.thinkingLevel}`;
		case "label": return `Label → ${entry.targetId}: ${entry.label ?? "cleared"}`;
		case "session_info": return `Session name: ${entry.name}`;
		case "usage": return `${entry.kind}\n${usageText(usageAvailable ? entry.usage : undefined)}`;
		case "session": return "Session header (host metadata not displayed).";
		case "custom": return `Extension state: ${entry.customType} (not model conversation; private data not displayed).`;
		default: return "Non-conversation entry (private metadata not displayed).";
	}
}

function messageText(message, usageAvailable) {
	const lines = [];
	if (message.role === "toolResult") lines.push(`Result · ${message.toolName} · ${message.isError ? "ERROR" : "ok"} · call ${message.toolCallId}`);
	if (message.role === "bashExecution") lines.push(`Command: ${message.command}\n${message.output}\nExit: ${message.exitCode ?? "unknown"}${message.cancelled ? " · cancelled" : ""}${message.truncated ? " · truncated by source" : ""}`);
	if (message.content !== undefined) lines.push(contentText(message.content));
	if (message.summary !== undefined) lines.push(message.summary);
	if (message.sections) lines.push(...Object.entries(message.sections).map(([name, text]) => `Section ${name}:\n${text === null ? "[removed]" : text}`));
	if (message.toolsAdded?.length) lines.push(`Tools added:\n${json(message.toolsAdded)}`);
	if (message.toolsRemoved?.length) lines.push(`Tools removed:\n${json(message.toolsRemoved)}`);
	if (message.stopReason) lines.push(`Response: ${message.stopReason}`);
	// Provider error strings and opaque tool details can contain host secrets; show status only.
	if (message.errorMessage) lines.push("Provider reported an error (private diagnostic omitted).");
	if (message.usage) lines.push(usageText(usageAvailable ? message.usage : undefined));
	return lines.join("\n");
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "[No text content]";
	return content.map(block => {
		switch (block.type) {
			case "text": return block.text;
			case "thinking": return `Thinking:\n${block.redacted ? "[redacted]" : block.thinking ?? ""}`;
			case "toolCall": return `Tool call · ${block.name} · ${block.id}\n${json(block.arguments)}`;
			case "image": return `[Image: ${block.mimeType}; binary data not displayed]`;
			default: return `[${block.type ?? "unknown"} content; no text renderer]`;
		}
	}).join("\n\n");
}

function usageText(usage) {
	if (!usage) return "Usage unavailable · cost unknown";
	return `Recorded tokens · input ${usage.input ?? "unknown"} · output ${usage.output ?? "unknown"} · cache read ${usage.cacheRead ?? "unknown"} · cache write ${usage.cacheWrite ?? "unknown"}\nCost: unknown (not a billing estimate)`;
}
