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

import type { Envelope } from "./envelope.ts";

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
	questionLookup: (correlationId: string) => string | undefined;
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

function byId(a: DigestItem, b: DigestItem): number {
	return a.envelope.id < b.envelope.id ? -1 : a.envelope.id > b.envelope.id ? 1 : 0;
}

/** One labeled entry for a non-answer envelope. */
function formatItem(item: DigestItem, index: number): string {
	const { envelope } = item;
	const lines: string[] = [];
	lines.push(`${index}. ${envelope.type} from \`${envelope.from}\` (${envelope.id}):`);
	lines.push(quote(envelope.payload.text));
	if (envelope.type === "question") {
		lines.push(
			`   To answer, send a message back to \`${envelope.from}\` with correlationId "${envelope.id}".`,
		);
	}
	// Collect requests carry their schema in payload.data.collectSchema — spell
	// out the fulfillment recipe so the recipient never has to connect "THIS
	// message" to the (msg_...) header on its own.
	const data = envelope.payload.data;
	if (typeof data === "object" && data !== null && "collectSchema" in data) {
		lines.push(
			"   To fulfill this collect request, call the `report` tool with `data` conforming " +
				`to the schema above and correlationId "${envelope.id}".`,
		);
	}
	if (item.note !== undefined) lines.push(`   ${item.note}`);
	if (item.redelivered) lines.push(`   ${REDELIVERY_LABEL}`);
	return lines.join("\n");
}

/** One answer entry with its original question quoted first (D14). */
function formatAnswer(item: DigestItem, lookup: DigestOptions["questionLookup"]): string {
	const { envelope } = item;
	const lines: string[] = [];
	const question = envelope.correlationId !== null ? lookup(envelope.correlationId) : undefined;
	if (question !== undefined) {
		lines.push(`You asked (${envelope.correlationId}):`);
		lines.push(quote(question));
	} else {
		lines.push(
			`(You asked a question — ${envelope.correlationId ?? "unknown id"} — whose text is not on record.)`,
		);
	}
	lines.push(`\`${envelope.from}\` answered (${envelope.id}):`);
	lines.push(quote(envelope.payload.text));
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
