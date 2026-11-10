/**
 * mail/digest.ts — the deterministic wake-digest composer (D14). PURE: values
 * in, one string out — no LLM, no fs, no clock. Same pending mail → same digest.
 *
 * Shape: answers first, each with its ORIGINAL question quoted (correlationId
 * lookup — the agent never digs for what it asked), then all other mail ordered
 * by envelope id and labeled by type/sender. Re-delivered mail (at-least-once,
 * a crash between delivery and the durable append) is labeled.
 */

import { type Envelope, MAIN_ADDRESS } from "./envelope.ts";

export interface DigestItem {
	envelope: Envelope;
	redelivered: boolean;
	/** Optional runtime annotation (e.g. collect-result schema verdict). */
	note?: string;
}

export interface DigestOptions {
	items: DigestItem[];
	/** The recipient's own sent-question index: original text by correlationId. */
	questionLookup: (correlationId: string, from: string) => string | undefined;
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
	lines.push(`${index}. ${envelope.type} from \`${envelope.from}\` (${envelope.id}):`);
	lines.push(quote(boundText(envelope.payload.text, envelope.id)));
	if (envelope.type === "question") {
		lines.push(`   To answer, send a message back to \`${envelope.from}\` with correlationId "${envelope.id}".`);
	}
	// A collect REQUEST is identified structurally (finding #10): a `message` FROM
	// `main` carrying payload.data.collectSchema — never by sniffing arbitrary data.
	const data = envelope.payload.data;
	const isCollectRequest =
		envelope.type === "message" && envelope.from === MAIN_ADDRESS && typeof data === "object" && data !== null && "collectSchema" in data;
	// Always render the structured payload (for a collect request this is the
	// `{ collectSchema: … }` the agent must conform to — previously the schema was
	// silently omitted, so the "conform to the schema above" instruction referenced
	// nothing on screen and reports routinely failed validation).
	if (data !== undefined) {
		lines.push(formatDataBlock(data, envelope.id));
	}
	if (isCollectRequest) {
		lines.push(`   To fulfill this collect request, call the \`report\` tool with \`data\` conforming to the \`collectSchema\` shown above and correlationId "${envelope.id}".`);
	}
	if (item.note !== undefined) lines.push(`   ${item.note}`);
	if (item.redelivered) lines.push(`   ${REDELIVERY_LABEL}`);
	return lines.join("\n");
}

function formatAnswer(item: DigestItem, lookup: DigestOptions["questionLookup"]): string {
	const { envelope } = item;
	const lines: string[] = [];
	const question = envelope.correlationId !== null ? lookup(envelope.correlationId, envelope.from) : undefined;
	if (question !== undefined) {
		lines.push(`You asked (${envelope.correlationId}):`);
		lines.push(quote(question));
	} else {
		lines.push(`(You asked a question — ${envelope.correlationId ?? "unknown id"} — whose text is not on record.)`);
	}
	lines.push(`\`${envelope.from}\` answered (${envelope.id}):`);
	lines.push(quote(boundText(envelope.payload.text, envelope.id)));
	if (item.note !== undefined) lines.push(item.note);
	if (item.redelivered) lines.push(REDELIVERY_LABEL);
	return lines.join("\n");
}

/** Compose the wake injection for one receiving turn. Deterministic. */
export function composeWakeDigest(options: DigestOptions): string {
	const sorted = [...options.items].sort(byId);
	const answers = sorted.filter((item) => item.envelope.type === "answer");
	const rest = sorted.filter((item) => item.envelope.type !== "answer");

	const total = sorted.length;
	const sections: string[] = [];
	sections.push(`[Wake digest — ${total} message${total === 1 ? "" : "s"} delivered at this turn boundary]`);

	if (answers.length > 0) {
		sections.push(["## Answers to your questions", "", answers.map((item) => formatAnswer(item, options.questionLookup)).join("\n\n")].join("\n"));
	}
	if (rest.length > 0) {
		sections.push(["## Mail", "", rest.map((item, i) => formatItem(item, i + 1)).join("\n\n")].join("\n"));
	}

	return sections.join("\n\n");
}
