import { displayText } from "./dashboard.mjs";
import { isBoardMessage } from "./messaging.mjs";

export const TOPIC_MIRROR = "swarm-topic-mirror";
export const MAIL_MIRROR = "swarm-mail-mirror";

export const cardText = (value, limit = 2000) => Array.from(displayText(String(value ?? "").slice(0, 32768))).slice(0, limit).join("");
export const cardLabel = value => cardText(value, 128).replace(/\n/g, " ");

/** Reconstruct only the active history: abandoned branch cards are not acknowledgements. */
export function persistedMirrorIds(context, runId) {
	const ids = new Set();
	for (const entry of context?.sessionManager?.getBranch?.() ?? []) {
		// Legacy visible mail already has a card; hidden actionable delivery is not a visual acknowledgement.
		const legacyMail = entry.type === "custom_message" && entry.customType === "swarm-agent-mail" && entry.display;
		const mirror = entry.type === "custom" && [TOPIC_MIRROR, MAIL_MIRROR].includes(entry.customType);
		const data = legacyMail ? entry.details : mirror ? entry.data : undefined;
		if (data?.runId !== runId) continue;
		for (const id of data.messageIds ?? []) if (typeof id === "string") ids.add(id);
	}
	return ids;
}

/** Transcript-only projection. Never sends messages, wakes the model, or interprets consent. */
export function createTopicMirrors(pi, getContext) {
	return {
		refresh(snapshot) {
			const context = getContext();
			const run = snapshot?.run;
			if (!context || !run?.runId) return;
			try {
				const seen = persistedMirrorIds(context, run.runId);
				const pending = new Map([[TOPIC_MIRROR, []], [MAIL_MIRROR, []]]);
				for (const message of run.messages ?? []) {
					const ownerMail = message.to === "owner";
					if (typeof message.id !== "string" || seen.has(message.id)
						|| !ownerMail && !message.topic && !isBoardMessage(message, run.workers)) continue;
					seen.add(message.id);
					pending.get(ownerMail ? MAIL_MIRROR : TOPIC_MIRROR).push(message);
				}
				for (const [customType, messages] of pending) {
					for (let offset = 0; offset < messages.length; offset += 30) {
						const batch = messages.slice(offset, offset + 30);
						pi.appendEntry(customType, {
							runId: run.runId, messageIds: batch.map(message => message.id),
							messages: batch.map(message => ({
								id: message.id, from: cardLabel(message.from),
								to: message.to === "owner" ? "main" : isBoardMessage(message, run.workers) ? "@board" : cardLabel(message.to),
								topic: cardLabel(message.topic || (customType === MAIL_MIRROR ? "Direct mail" : "Board")), cycle: message.cycle, generation: message.generation,
								text: cardText(message.text), truncated: displayText(String(message.text ?? "")).length > 2000
							}))
						});
					}
				}
			} catch { /* Presentation failure cannot alter host lifecycle or actual mail. */ }
		},
	};
}
