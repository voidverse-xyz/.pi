/**
 * mail/digest.ts — the deterministic wake-digest composer. PURE: values in,
 * one string out — no LLM, no fs, no clock. Same pending mail → same digest.
 *
 * Shape: all mail ordered by envelope id, labeled by type/sender.
 * Re-delivered mail (at-least-once, a crash between delivery and the durable
 * append) is labeled. Hub-and-spoke has no answers section — there are no
 * questions.
 */

import type { Envelope } from "./envelope.ts";

export interface DigestItem {
	envelope: Envelope;
	redelivered: boolean;
	/** Optional runtime annotation (e.g. "task anchor closed"). */
	note?: string;
}

export interface DigestOptions {
	items: DigestItem[];
}

function quote(text: string): string {
	const trimmed = text.trimEnd();
	if (trimmed.length === 0) return ">";
	return trimmed.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
}

const REDELIVERY_LABEL = "(re-delivered: an earlier delivery attempt did not complete — you may have seen this before)";
const MAX_DATA_CHARS = 4000;
const MAX_TEXT_CHARS = 4000;

/** Render structured payload.data as a fenced JSON block. Never throws; bounded. */
function formatDataBlock(data: unknown, envelopeId: string): string {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(data, null, 2);
	} catch {
		return "   Data: (unserializable data)";
	}
	if (serialized === undefined) return "   Data: (unserializable data)";
	const lines: string[] = ["   Data:", "```json"];
	if (serialized.length > MAX_DATA_CHARS) {
		lines.push(serialized.slice(0, MAX_DATA_CHARS));
		lines.push(`… [truncated at ${MAX_DATA_CHARS} chars — full value in report envelope ${envelopeId} on disk (…/.done/${envelopeId}.json)]`);
	} else {
		lines.push(serialized);
	}
	lines.push("```");
	return lines.join("\n");
}

function boundText(text: string, envelopeId: string): string {
	if (text.length <= MAX_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TEXT_CHARS)}\n… [truncated at ${MAX_TEXT_CHARS} chars — full text in envelope ${envelopeId} on disk]`;
}

function byId(a: DigestItem, b: DigestItem): number {
	return a.envelope.id < b.envelope.id ? -1 : a.envelope.id > b.envelope.id ? 1 : 0;
}

function formatItem(item: DigestItem, index: number): string {
	const { envelope } = item;
	const lines: string[] = [];
	const finality = envelope.type === "report" && envelope.payload.final === true ? " (FINAL)" : "";
	lines.push(`${index}. ${envelope.type}${finality} from \`${envelope.from}\` (${envelope.id}):`);
	lines.push(quote(boundText(envelope.payload.text, envelope.id)));
	if (envelope.payload.data !== undefined) {
		lines.push(formatDataBlock(envelope.payload.data, envelope.id));
	}
	if (item.note !== undefined) lines.push(`   ${item.note}`);
	if (item.redelivered) lines.push(`   ${REDELIVERY_LABEL}`);
	return lines.join("\n");
}

/** Compose the wake injection for one receiving turn. Deterministic. */
export function composeWakeDigest(options: DigestOptions): string {
	const sorted = [...options.items].sort(byId);
	const total = sorted.length;
	const sections: string[] = [];
	sections.push(`[Wake digest — ${total} message${total === 1 ? "" : "s"} delivered at this turn boundary]`);
	if (sorted.length > 0) {
		sections.push(["## Mail", "", sorted.map((item, i) => formatItem(item, i + 1)).join("\n\n")].join("\n"));
	}
	return sections.join("\n\n");
}
