import { isBoardMessage } from "./messaging.mjs";

/** Read-only conversation projections; tool calls and reasoning stay out of this view. */

export function messageText(messages, workers = []) {
	return messages.map(message => `${agentName(message.from)} → ${isBoardMessage(message, workers) ? "Board" : agentName(message.to)}${message.topic ? ` · ${message.topic}` : ""}\n${message.text}`).join("\n\n");
}

export function topicsFor(run) {
	const topics = new Map((run?.tasks ?? []).map(task => [task.id, { name: task.id, title: task.title, status: task.status, messages: 0, participants: new Set() }]));
	for (const message of run?.messages ?? []) {
		if (!message.topic) continue;
		const topic = topics.get(message.topic) ?? { name: message.topic, messages: 0, participants: new Set() };
		topic.messages++;
		topic.participants.add(agentName(message.from));
		if (!isBoardMessage(message, run?.workers)) topic.participants.add(agentName(message.to));
		topics.set(message.topic, topic);
	}
	return [...topics.values()].map(topic => ({ ...topic, participants: [...topic.participants] }));
}

export function conversationText(history) {
	return history.flatMap(entry => {
		const message = entry.message;
		if (!message || message.role !== "assistant") return [];
		const content = typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
		return content.trim() ? [content] : [];
	}).join("\n\n");
}

function agentName(id) { return id === "owner" ? "Main agent" : id === "@board" ? "Board" : String(id ?? "Agent"); }
