/**
 * session-read.ts — read-only helpers over a subagent's Pi-native session
 * JSONL: transcript tails (peek) and message-content flattening.
 *
 * Two flatteners exist ON PURPOSE — they serve different surfaces and are NOT
 * interchangeable:
 *   flattenMessageText — transcript tails: keeps `[type]` placeholders for
 *                        non-text parts, joins with spaces.
 *   flattenTextOnly    — TUI viewer user bubbles: text parts only, joined
 *                        verbatim with no separators or placeholders.
 */

import { readFileSync } from "node:fs";
import { parseSessionEntries, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptEntry } from "./runtime/types.ts";

/** The last `n` message entries of a session file as transcript rows. */
export function readTranscriptTail(sessionFile: string, n: number): TranscriptEntry[] {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const messages = parseSessionEntries(content).filter((entry): entry is SessionMessageEntry => "type" in entry && entry.type === "message");
	return messages.slice(-n).map((entry) => ({
		role: entry.message.role,
		text: flattenMessageText(entry.message),
		timestamp: typeof (entry as { timestamp?: unknown }).timestamp === "string" ? (entry as { timestamp: string }).timestamp : "",
	}));
}

/** Flatten message content with `[type]` placeholders for non-text parts. */
export function flattenMessageText(message: SessionMessageEntry["message"]): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const p = part as { type?: string; text?: string };
				if (p.type === "text" && typeof p.text === "string") return p.text;
				return p.type ? `[${p.type}]` : "";
			})
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

/** Flatten message content to its text parts only (no placeholders, no separators). */
export function flattenTextOnly(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((p) => ((p as { type?: string; text?: string }).type === "text" ? ((p as { text?: string }).text ?? "") : "")).join("");
	}
	return "";
}
