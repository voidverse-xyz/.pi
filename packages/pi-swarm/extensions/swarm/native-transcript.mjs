import {
	UserMessageComponent,
	ToolExecutionComponent,
	AssistantMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { displayText } from "./dashboard.mjs";

/** Read-only replay of the active native branch. No session construction or tool execution. */
export function nativeTranscript(entries, tui, cwd) {
	const components = [];
	const tools = new Map();
	for (const entry of entries) {
		const message = entry.message;
		if (!message) continue;
		if (message.role === "user") {
			components.push(new UserMessageComponent(textContent(message.content)));
		} else if (message.role === "assistant") {
			const content = (message.content ?? []).map(block => {
				if (block.type === "text") return { type: "text", text: displayText(block.text) };
				if (block.type === "thinking") return { type: "thinking", thinking: block.redacted ? "[redacted]" : displayText(block.thinking ?? "") };
				if (block.type === "toolCall") return { type: "toolCall", id: block.id, name: displayText(block.name), arguments: safeArguments(block.arguments) };
				return { type: "text", text: "[Unsupported content]" };
			});
			const assistant = new AssistantMessageComponent({ role: "assistant", content, stopReason: message.stopReason,
				errorMessage: message.errorMessage ? "Provider reported an error (private diagnostic omitted)." : undefined });
			components.push(assistant);
			for (const block of content) {
				if (block.type !== "toolCall") continue;
				const tool = new ToolExecutionComponent(block.name, block.id, block.arguments, { showImages: false }, undefined, tui, cwd);
				tool.setArgsComplete();
				tools.set(block.id, tool);
				components.push(tool);
			}
		} else if (message.role === "toolResult") {
			let tool = tools.get(message.toolCallId);
			if (!tool) {
				tool = new ToolExecutionComponent(displayText(message.toolName), message.toolCallId, {}, { showImages: false }, undefined, tui, cwd);
				tool.setArgsComplete();
				components.push(tool);
			}
			tool.updateResult({ content: [{ type: "text", text: textContent(message.content) }], isError: message.isError === true });
		}
	}
	return components;
}

function textContent(content) {
	if (typeof content === "string") return displayText(content);
	return (content ?? []).map(block => block.type === "text" ? displayText(block.text) : "[Image/unsupported content; text-only view]").join("\n");
}

function safeArguments(value) {
	if (typeof value === "string") return displayText(value);
	if (Array.isArray(value)) return value.map(safeArguments);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [displayText(key), safeArguments(item)]));
	return value;
}
