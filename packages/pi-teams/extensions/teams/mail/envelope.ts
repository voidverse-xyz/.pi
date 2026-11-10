/**
 * mail/envelope.ts — the one envelope shape for every message (D11/D14/D21,
 * D-envelope'), the address grammar, and a dependency-free monotonic ULID
 * generator. Envelope ids double as mailbox filenames and define processing
 * order, so ids must sort by creation time.
 *
 * v2 vs v1: the `team` field is removed (peer comm is flat — D12).
 *
 * Pure module: no fs, no runtime imports.
 */

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Either an agent instance `<type>/<id>`, or a special: `main` / `user`. */
export type Address =
	| { kind: "agent"; type: string; id: string }
	| { kind: "main" }
	| { kind: "user" };

export const MAIN_ADDRESS = "main";
export const USER_ADDRESS = "user";

/** One address/path segment: alphanumeric start, then `[a-z0-9._-]`, no dotfile. */
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function isFilesystemSafeSegment(segment: string): boolean {
	return SEGMENT_RE.test(segment) && !segment.startsWith(".");
}

/** TYPE segments avoid the reserved specials so bare `main`/`user` stay unambiguous. */
export function isValidTypeSegment(segment: string): boolean {
	return isFilesystemSafeSegment(segment) && segment !== MAIN_ADDRESS && segment !== USER_ADDRESS;
}

/** ID segments MAY be "main" (D5 default id for singleton types: `docs-keeper/main`). */
export function isValidIdSegment(segment: string): boolean {
	return isFilesystemSafeSegment(segment);
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
			return formatAgentAddress(address.type, address.id);
	}
}

/** Convenience: `<type>/<id>` for an agent instance. */
export function formatAgentAddress(type: string, id: string): string {
	return `${type}/${id}`;
}

// ---------------------------------------------------------------------------
// ULID (inline, no deps) — monotonic-nondecreasing within a process.
// ---------------------------------------------------------------------------

/** Crockford base32 alphabet (no I, L, O, U). */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

/**
 * Seed the monotonic clock from an existing id (e.g. the max id found on disk at
 * startup) so freshly minted ids sort AFTER already-persisted mail even when the
 * wall clock reads earlier than when that mail was written (snapshot resume / NTP
 * step). No-op if the id is malformed or older than the current high-water mark.
 */
export function seedUlidClock(id: string): void {
	const s = id.startsWith("msg_") ? id.slice(4) : id;
	if (s.length < 26) return;
	let t = 0;
	for (let i = 0; i < 10; i++) {
		const v = B32.indexOf(s[i]!);
		if (v < 0) return;
		t = t * 32 + v;
	}
	const digits: number[] = [];
	for (let i = 10; i < 26; i++) {
		const v = B32.indexOf(s[i]!);
		if (v < 0) return;
		digits.push(v);
	}
	if (t > lastTime) {
		lastTime = t;
		lastRandom = digits;
	}
}

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
	// 80 bits overflowed within one ms — practically unreachable.
}

/**
 * A 26-char ULID (10 time + 16 random). A same-ms or backward clock keeps the
 * high-water `lastTime` and increments the random part, so ids — and therefore
 * mailbox filenames and processing order — never move backward even if the
 * wall clock does (NTP step, snapshot resume).
 */
export function ulid(now: number = Date.now()): string {
	if (now <= lastTime) {
		incrementDigits(lastRandom);
	} else {
		lastTime = now;
		lastRandom = randomDigits();
	}
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
	/** Persisted completion signal; valid only on report envelopes (D26'). */
	final?: boolean;
}

export interface Envelope {
	/** `msg_<ulid>` — unique, sortable; doubles as the mailbox filename stem. */
	id: string;
	/** Sender address: `<type>/<id>`, `main`, or `user`. */
	from: string;
	/** Durable sender-incarnation fence for agent-originated mail (address reuse safety). */
	fromGenerationId?: string;
	/** Recipient address: `<type>/<id>`, `main`, or `user`. */
	to: string;
	type: EnvelopeType;
	/** Links answer→question, report→task/collect anchor; null otherwise. */
	correlationId: string | null;
	/** Causal-chain depth (D21): parent.hops + 1 for message-triggered sends; fresh = 0. */
	hops: number;
	payload: EnvelopePayload;
	/** Runtime-stamped ISO timestamp — never sender-claimed. */
	sentAt: string;
}

export const ENVELOPE_ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;
export const GENERATION_ID_RE = /^gen_[0-9a-f]{32}$/;

export interface MakeEnvelopeOptions {
	/** Pre-reserved id for a durable multi-step protocol; normally generated here. */
	id?: string;
	from: Address | string;
	/** Runtime-provided agent generation; omitted for main/user. */
	fromGenerationId?: string;
	to: Address | string;
	type: EnvelopeType;
	text: string;
	data?: unknown;
	/** Persisted completion signal; valid only on report envelopes. */
	final?: boolean;
	correlationId?: string | null;
	hops?: number;
	/** Clock override (tests). */
	now?: Date;
}

/**
 * Build a valid envelope (id + sentAt stamped here). Throws on malformed
 * addresses or contract violations — callers construct from trusted data, so a
 * throw is a bug, not user input.
 */
export function makeEnvelope(options: MakeEnvelopeOptions): Envelope {
	const now = options.now ?? new Date();
	const envelope: Envelope = {
		id: options.id ?? `msg_${ulid(now.getTime())}`,
		from: typeof options.from === "string" ? options.from : formatAddress(options.from),
		...(options.fromGenerationId !== undefined ? { fromGenerationId: options.fromGenerationId } : {}),
		to: typeof options.to === "string" ? options.to : formatAddress(options.to),
		type: options.type,
		correlationId: options.correlationId ?? null,
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
 * Validate an envelope (e.g. read back from a mailbox file). Returns a list of
 * human-readable problems; empty = valid.
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
	if (env.fromGenerationId !== undefined) {
		if (typeof env.fromGenerationId !== "string" || !GENERATION_ID_RE.test(env.fromGenerationId)) {
			errors.push("fromGenerationId must match gen_<32 lowercase hex> when present");
		}
		if (typeof env.from !== "string" || parseAddress(env.from)?.kind !== "agent") {
			errors.push("fromGenerationId is valid only for agent senders");
		}
	}
	if (typeof env.type !== "string" || !(ENVELOPE_TYPES as readonly string[]).includes(env.type)) {
		errors.push(`type must be one of ${ENVELOPE_TYPES.join("|")}, got ${JSON.stringify(env.type)}`);
	}
	if (env.correlationId !== null && typeof env.correlationId !== "string") {
		errors.push("correlationId must be a string or null");
	}
	if (env.type === "answer" && typeof env.correlationId !== "string") {
		errors.push("answer envelopes require a correlationId");
	}
	if (typeof env.hops !== "number" || !Number.isInteger(env.hops) || env.hops < 0) {
		errors.push(`hops must be a non-negative integer, got ${JSON.stringify(env.hops)}`);
	}
	const payload = env.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		errors.push("payload must be an object with a text field");
	} else {
		const p = payload as Record<string, unknown>;
		if (typeof p.text !== "string") errors.push("payload.text must be a string");
		if (p.final !== undefined && typeof p.final !== "boolean") {
			errors.push("payload.final must be a boolean when present");
		}
		if (p.final !== undefined && env.type !== "report") {
			errors.push("payload.final is valid only on report envelopes");
		}
	}
	if (typeof env.sentAt !== "string" || Number.isNaN(Date.parse(env.sentAt))) {
		errors.push(`sentAt must be an ISO timestamp, got ${JSON.stringify(env.sentAt)}`);
	}
	return errors;
}
