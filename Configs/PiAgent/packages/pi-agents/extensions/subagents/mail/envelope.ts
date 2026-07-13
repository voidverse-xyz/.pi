/**
 * mail/envelope.ts — the one envelope shape for every message in the system
 * (02-envelope-contract.md; D11/D12/D14/D21), plus the address grammar and a
 * dependency-free monotonic ULID generator (envelope ids double as mailbox
 * filenames and define processing order, so ids must sort by creation).
 *
 * Pure module: no fs, no runtime imports.
 */

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * An address is either an agent instance `<type>/<id>` or one of the specials
 * `main` (the main agent) and `user` (the human).
 */
export type Address =
	| { kind: "agent"; type: string; id: string }
	| { kind: "main" }
	| { kind: "user" };

export const MAIN_ADDRESS = "main";
export const USER_ADDRESS = "user";

/**
 * One path/address segment: starts alphanumeric, then alphanumerics plus
 * `._-`. Segments are also directory names (D5: address = mailbox path), so
 * the charset is deliberately filesystem-safe.
 */
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function isFilesystemSafeSegment(segment: string): boolean {
	return SEGMENT_RE.test(segment) && !segment.startsWith(".");
}

/**
 * TYPE segments must avoid the reserved special addresses so `main`/`user`
 * stay unambiguous as bare addresses and `subagents/<type>/` can't shadow
 * the `.main` state dir's namespace.
 */
export function isValidTypeSegment(segment: string): boolean {
	return isFilesystemSafeSegment(segment) && segment !== MAIN_ADDRESS && segment !== USER_ADDRESS;
}

/**
 * ID segments MAY be "main" — it's the default id for singleton persistent
 * types (D5: `docs-keeper/main`). A two-segment address is never ambiguous
 * with the bare specials.
 */
export function isValidIdSegment(segment: string): boolean {
	return isFilesystemSafeSegment(segment);
}

/** @deprecated split into isValidTypeSegment / isValidIdSegment (D5's default id is "main"). */
export function isValidAddressSegment(segment: string): boolean {
	return isValidTypeSegment(segment);
}

/** Parse an address string; returns null if malformed. */
export function parseAddress(raw: string): Address | null {
	if (raw === MAIN_ADDRESS) return { kind: "main" };
	if (raw === USER_ADDRESS) return { kind: "user" };
	const parts = raw.split("/");
	if (parts.length !== 2) return null;
	const [type, id] = parts as [string, string];
	if (!isValidTypeSegment(type) || !isValidIdSegment(id)) return null;
	return { kind: "agent", type, id };
}

export function formatAddress(address: Address): string {
	switch (address.kind) {
		case "main":
			return MAIN_ADDRESS;
		case "user":
			return USER_ADDRESS;
		case "agent":
			return `${address.type}/${address.id}`;
	}
}

/** Convenience: `<type>/<id>` for an agent instance. */
export function formatAgentAddress(type: string, id: string): string {
	return `${type}/${id}`;
}

// ---------------------------------------------------------------------------
// ULID (inline, no deps)
// ---------------------------------------------------------------------------

/** Crockford base32 alphabet (no I, L, O, U). */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
// 16 random base32 digits as indices; incremented within the same millisecond
// so ids from one process are strictly monotonic (mailbox processing order).
let lastRandom: number[] = [];

function randomDigits(): number[] {
	const digits: number[] = [];
	for (let i = 0; i < 16; i++) digits.push(Math.floor(Math.random() * 32));
	return digits;
}

function incrementDigits(digits: number[]): void {
	for (let i = digits.length - 1; i >= 0; i--) {
		const d = digits[i]!;
		if (d < 31) {
			digits[i] = d + 1;
			return;
		}
		digits[i] = 0;
	}
	// 80 bits of randomness overflowed within one millisecond — practically
	// unreachable; wrapping to zero is still a valid (non-monotonic) id.
}

/**
 * A 26-char ULID: 10 chars of millisecond time + 16 chars of randomness,
 * monotonic-NONDECREASING within this process. Same-ms ids increment the random
 * part; a wall-clock REGRESSION (now < lastTime — NTP step, VM snapshot resume)
 * is treated exactly like the same millisecond: keep the last (higher) time and
 * increment the random part, so ids never move backward even when the clock
 * does. Without this, a backward clock would reset lastTime to the smaller value
 * and mint a smaller id, corrupting mailbox processing order (the id is the
 * filename and the sort key).
 */
export function ulid(now: number = Date.now()): string {
	if (now <= lastTime) {
		incrementDigits(lastRandom);
	} else {
		lastTime = now;
		lastRandom = randomDigits();
	}
	// Encode lastTime (never `now`): under a clock regression lastTime is the
	// monotonic high-water mark, so the time component is nondecreasing too.
	let time = "";
	let t = lastTime;
	for (let i = 0; i < 10; i++) {
		time = B32[t % 32]! + time;
		t = Math.floor(t / 32);
	}
	let rand = "";
	for (const d of lastRandom) rand += B32[d]!;
	return time + rand;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const ENVELOPE_TYPES = ["message", "question", "answer", "report", "escalation", "error"] as const;
export type EnvelopeType = (typeof ENVELOPE_TYPES)[number];

export interface EnvelopePayload {
	/** Always present: the human-readable content. */
	text: string;
	/** Structured extras (e.g. schema-conforming collect results on reports). */
	data?: unknown;
	/** Persisted completion signal; valid only on report envelopes. */
	final?: boolean;
}

export interface Envelope {
	/** `msg_<ulid>` — unique, sortable; doubles as the mailbox filename stem. */
	id: string;
	/** Sender address: `<type>/<id>`, `main`, or `user`. */
	from: string;
	/** Recipient address: `<type>/<id>`, `main`, or `user`. */
	to: string;
	type: EnvelopeType;
	/** Links answer→question (and future reply chains); null otherwise. */
	correlationId: string | null;
	/** Team the send was authorized under (sub→sub only); null for main/user traffic. */
	team: string | null;
	/** Causal-chain depth (D21): parent.hops + 1 for message-triggered sends; fresh work = 0. */
	hops: number;
	payload: EnvelopePayload;
	/** Runtime-stamped ISO timestamp — never sender-claimed. */
	sentAt: string;
}

export const ENVELOPE_ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface MakeEnvelopeOptions {
	from: Address | string;
	to: Address | string;
	type: EnvelopeType;
	text: string;
	data?: unknown;
	/** Persisted completion signal; valid only on report envelopes. */
	final?: boolean;
	correlationId?: string | null;
	team?: string | null;
	hops?: number;
	/** Clock override (tests). */
	now?: Date;
}

/**
 * Build a valid envelope (id + sentAt stamped here). Throws on malformed
 * addresses or contract violations — callers construct envelopes from their
 * own trusted data, so a throw is a bug, not user input.
 */
export function makeEnvelope(options: MakeEnvelopeOptions): Envelope {
	const now = options.now ?? new Date();
	const envelope: Envelope = {
		id: `msg_${ulid(now.getTime())}`,
		from: typeof options.from === "string" ? options.from : formatAddress(options.from),
		to: typeof options.to === "string" ? options.to : formatAddress(options.to),
		type: options.type,
		correlationId: options.correlationId ?? null,
		team: options.team ?? null,
		hops: options.hops ?? 0,
		payload: {
			text: options.text,
			...(options.data !== undefined ? { data: options.data } : {}),
			...(options.final !== undefined ? { final: options.final } : {}),
		},
		sentAt: now.toISOString(),
	};
	const errors = validateEnvelope(envelope);
	if (errors.length > 0) {
		throw new Error(`Invalid envelope: ${errors.join("; ")}`);
	}
	return envelope;
}

/**
 * Validate an envelope (e.g. one read back from a mailbox file). Returns a
 * list of human-readable problems; empty = valid.
 */
export function validateEnvelope(value: unknown): string[] {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return ["envelope must be an object"];
	}
	const env = value as Record<string, unknown>;

	if (typeof env.id !== "string" || !ENVELOPE_ID_RE.test(env.id)) {
		errors.push(`id must match msg_<ulid>, got ${JSON.stringify(env.id)}`);
	}
	for (const field of ["from", "to"] as const) {
		const raw = env[field];
		if (typeof raw !== "string" || parseAddress(raw) === null) {
			errors.push(`${field} must be "<type>/<id>", "main", or "user", got ${JSON.stringify(raw)}`);
		}
	}
	if (typeof env.type !== "string" || !(ENVELOPE_TYPES as readonly string[]).includes(env.type)) {
		errors.push(`type must be one of ${ENVELOPE_TYPES.join("|")}, got ${JSON.stringify(env.type)}`);
	}
	if (env.correlationId !== null && typeof env.correlationId !== "string") {
		errors.push("correlationId must be a string or null");
	}
	if (env.type === "answer" && typeof env.correlationId !== "string") {
		errors.push("answer envelopes require a correlationId (02-envelope-contract)");
	}
	if (env.team !== null && typeof env.team !== "string") {
		errors.push("team must be a string or null");
	}
	if (typeof env.hops !== "number" || !Number.isInteger(env.hops) || env.hops < 0) {
		errors.push(`hops must be a non-negative integer, got ${JSON.stringify(env.hops)}`);
	}
	const payload = env.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		errors.push("payload must be an object with a text field");
	} else {
		const payloadRecord = payload as Record<string, unknown>;
		if (typeof payloadRecord.text !== "string") errors.push("payload.text must be a string");
		if (payloadRecord.final !== undefined && typeof payloadRecord.final !== "boolean") {
			errors.push("payload.final must be a boolean when present");
		}
		if (payloadRecord.final !== undefined && env.type !== "report") {
			errors.push("payload.final is valid only on report envelopes");
		}
	}
	if (typeof env.sentAt !== "string" || Number.isNaN(Date.parse(env.sentAt))) {
		errors.push(`sentAt must be an ISO timestamp, got ${JSON.stringify(env.sentAt)}`);
	}
	return errors;
}
