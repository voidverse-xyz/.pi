/**
 * mail/digest.ts — the deterministic wake-digest composer (D14,
 * 02-envelope-contract delivery rule 5). PURE: values in, one string out — no
 * LLM, no fs, no clock. The same pending mail always produces the same digest.
 *
 * Shape (D14): answers first, each with its ORIGINAL QUESTION quoted next to
 * it (correlationId lookup — the agent never digs for what it asked), then all
 * other mail ordered by envelope id and labeled by type/sender. Re-delivered
 * mail (a crash between delivery and the session append, at-least-once) is
 * labeled as such. Roster-change lines (D18: "roster changes arrive as
 * wake-digest lines") append at the end when provided.
 *
 * Question envelopes carry an explicit "answer with correlationId ..." line so
 * the recipient can correlate its reply without seeing raw envelope files.
 */

import { type Envelope, MAIN_ADDRESS } from "./envelope.ts";

export interface DigestItem {
	envelope: Envelope;
	/** True when a previous delivery attempt crashed before the session append. */
	redelivered: boolean;
	/** Optional runtime annotation (e.g. collect-result schema validation). */
	note?: string;
}

export interface DigestOptions {
	/** Pending mail being delivered by this wake/turn. Any order; sorted here. */
	items: DigestItem[];
	/**
	 * The recipient's own sent-question index: original question text by
	 * correlationId (for quoting answers). Undefined = not on record.
	 */
	questionLookup: (correlationId: string, from: string) => string | undefined;
	/** Pre-formatted roster-change lines (D18), already human-readable. */
	rosterChanges?: string[];
}

/** Quote a possibly multi-line text as a markdown blockquote. */
function quote(text: string): string {
	const trimmed = text.trimEnd();
	if (trimmed.length === 0) return ">";
	return trimmed
		.split("\n")
		.map((line) => `> ${line}`.trimEnd())
		.join("\n");
}

const REDELIVERY_LABEL =
	"(re-delivered: an earlier delivery attempt did not complete — you may have seen this before)";

// Character cap for the inline structured-data block. The digest is injected
// into the main session as a wake message, so an unbounded JSON dump (a huge
// collect result) could crowd the context window. We render up to this many
// characters and note that the full value lives in the report envelope on disk.
// 4000 chars keeps a rich result visible while staying bounded and deterministic.
const MAX_DATA_CHARS = 4000;

// Character cap for an envelope's free-text body. `payload.data` is bounded
// (MAX_DATA_CHARS) but `payload.text` was not — a subagent could put a huge
// report in text and overflow the main context the digest is injected into.
// Bound each item's quoted text with an explicit truncation marker; the full
// text always remains in the envelope file on disk.
const MAX_TEXT_CHARS = 4000;

/**
 * Render an envelope's structured `payload.data` as a fenced JSON block. PURE
 * and SAFE: never throws — a non-serializable value (circular refs, BigInt)
 * yields a short placeholder instead of propagating out of this composer.
 * BOUNDED: output is truncated to MAX_DATA_CHARS with an explicit marker.
 */
function formatDataBlock(data: unknown, envelopeId: string): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(data, null, 2);
	} catch {
		return "   Data: (unserializable data)";
	}
	// JSON.stringify returns undefined for values like a bare `undefined` or a
	// function; treat that the same as "nothing to render" would elsewhere.
	if (serialized === undefined) return "   Data: (unserializable data)";
	const lines: string[] = ["   Data:", "```json"];
	if (serialized.length > MAX_DATA_CHARS) {
		lines.push(serialized.slice(0, MAX_DATA_CHARS));
		// Reference the exact envelope so the truncated value is retrievable: the
		// file is <mailboxDir>/.done/<id>.json after this digest is finalized (the
		// id is the digest header's `(msg_...)` above). Note the truncated JSON is
		// syntactically incomplete — read the envelope file for the whole value.
		lines.push(
			`… [truncated at ${MAX_DATA_CHARS} chars — the full value is in report envelope ${envelopeId} on disk (…/.done/${envelopeId}.json)]`,
		);
	} else {
		lines.push(serialized);
	}
	lines.push("```");
	return lines.join("\n");
}

/**
 * Bound a free-text body to MAX_TEXT_CHARS with an explicit marker (the full
 * text stays in the envelope file). Applied to every quoted body so no single
 * report can flood the injected digest.
 */
function boundText(text: string, envelopeId: string): string {
	if (text.length <= MAX_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TEXT_CHARS)}\n… [truncated at ${MAX_TEXT_CHARS} chars — full text in envelope ${envelopeId} on disk]`;
}

function byId(a: DigestItem, b: DigestItem): number {
	return a.envelope.id < b.envelope.id ? -1 : a.envelope.id > b.envelope.id ? 1 : 0;
}

/** One labeled entry for a non-answer envelope. */
function formatItem(item: DigestItem, index: number): string {
	const { envelope } = item;
	const lines: string[] = [];
	lines.push(`${index}. ${envelope.type} from \`${envelope.from}\` (${envelope.id}):`);
	lines.push(quote(boundText(envelope.payload.text, envelope.id)));
	if (envelope.type === "question") {
		lines.push(
			`   To answer, send a message back to \`${envelope.from}\` with correlationId "${envelope.id}".`,
		);
	}
	// A collect REQUEST is identified by its envelope shape, NOT by sniffing a
	// `collectSchema` key on arbitrary data (finding 10): it is a `message` FROM
	// `main` carrying the schema in payload.data.collectSchema. Requiring the
	// type + direction means a legitimate `report` RESULT whose data happens to
	// contain a field named `collectSchema` renders as data, not as a request.
	const data = envelope.payload.data;
	const isCollectRequest =
		envelope.type === "message" &&
		envelope.from === MAIN_ADDRESS &&
		typeof data === "object" &&
		data !== null &&
		"collectSchema" in data;
	if (isCollectRequest) {
		lines.push(
			"   To fulfill this collect request, call the `report` tool with `data` conforming " +
				`to the schema above and correlationId "${envelope.id}".`,
		);
	} else if (data !== undefined) {
		// Structured result carried by a non-request envelope (e.g. a collect
		// RESULT report): render the actual JSON the main agent asked for, so it
		// sees the data — not just the schema verdict (item.note reads as its
		// caption below).
		lines.push(formatDataBlock(data, envelope.id));
	}
	if (item.note !== undefined) lines.push(`   ${item.note}`);
	if (item.redelivered) lines.push(`   ${REDELIVERY_LABEL}`);
	return lines.join("\n");
}

/** One answer entry with its original question quoted first (D14). */
function formatAnswer(item: DigestItem, lookup: DigestOptions["questionLookup"]): string {
	const { envelope } = item;
	const lines: string[] = [];
	const question = envelope.correlationId !== null ? lookup(envelope.correlationId, envelope.from) : undefined;
	if (question !== undefined) {
		lines.push(`You asked (${envelope.correlationId}):`);
		lines.push(quote(question));
	} else {
		lines.push(
			`(You asked a question — ${envelope.correlationId ?? "unknown id"} — whose text is not on record.)`,
		);
	}
	lines.push(`\`${envelope.from}\` answered (${envelope.id}):`);
	lines.push(quote(boundText(envelope.payload.text, envelope.id)));
	if (item.note !== undefined) lines.push(item.note);
	if (item.redelivered) lines.push(REDELIVERY_LABEL);
	return lines.join("\n");
}

/**
 * Compose the wake injection for one receiving turn. Deterministic: output is
 * a pure function of the inputs. Empty items + no roster changes still yields
 * a (minimal) digest, but callers normally skip the turn entirely then.
 */
export function composeWakeDigest(options: DigestOptions): string {
	const sorted = [...options.items].sort(byId);
	const answers = sorted.filter((item) => item.envelope.type === "answer");
	const rest = sorted.filter((item) => item.envelope.type !== "answer");
	const rosterChanges = options.rosterChanges ?? [];

	const total = sorted.length;
	const sections: string[] = [];
	sections.push(
		`[Wake digest — ${total} message${total === 1 ? "" : "s"} delivered at this turn boundary]`,
	);

	if (answers.length > 0) {
		const block: string[] = ["## Answers to your questions", ""];
		block.push(answers.map((item) => formatAnswer(item, options.questionLookup)).join("\n\n"));
		sections.push(block.join("\n"));
	}

	if (rest.length > 0) {
		const block: string[] = ["## Mail", ""];
		block.push(rest.map((item, i) => formatItem(item, i + 1)).join("\n\n"));
		sections.push(block.join("\n"));
	}

	if (rosterChanges.length > 0) {
		const block: string[] = ["## Roster changes", ""];
		for (const line of rosterChanges) block.push(`- ${line}`);
		sections.push(block.join("\n"));
	}

	return sections.join("\n\n");
}
