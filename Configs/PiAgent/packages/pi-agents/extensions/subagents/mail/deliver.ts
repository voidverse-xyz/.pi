/**
 * mail/deliver.ts — the delivery engine: envelope construction, routing to
 * mailbox files, wake decisions, bounces, hops arithmetic (D11/D13/D16/D21,
 * 02-envelope-contract §Delivery rules).
 *
 * One rule above all (D11): mail NEVER interrupts a running turn.
 *   recipient running/waiting → envelope sits in the mailbox; the runtime's
 *                               end-of-turn drain picks it up ("held")
 *   recipient dormant         → wake() — the runtime starts a turn whose
 *                               prompt is the wake digest ("woken")
 *   recipient queued          → nothing extra; its pending turn reads the
 *                               mailbox when it starts ("queued")
 *   recipient main            → .main/mailbox/ + onMainMail() so the host
 *                               host can surface durable main-mail state
 *
 * "when: now|after-turn" never changes any of the above (03-tool-surface:
 * neither interrupts; the distinction only orders a send against the sender's
 * other queued mail, and mailbox ulid order already provides that) — it is
 * accepted and recorded for API fidelity.
 *
 * Bounces (rules 2–3): unknown/retired recipient → an error envelope goes
 * back to the sender (correlationId = the failed envelope's id, original text
 * quoted). Bounces skip guards (a bounce must not itself bounce) and are
 * dropped silently if the sender is gone too.
 *
 * Hops arithmetic (D21): hops = causedBy.hops + 1 when the sending turn was
 * itself triggered by an envelope (the runtime threads `causedBy` from the
 * turn's trigger mail); fresh work = 0.
 *
 * Guards (Phase 4, D12/D21): `teamGuard` and `hopsGuard` are pluggable guard
 * fns defaulting to allow-all (Phase 1–3 harnesses). The real plugs are
 * makeTeamGuard below (shared-team check, stamps envelope.team) and
 * rails/hops.ts makeHopsGuard (maxHops cap with the report-to-main escape);
 * runtime/in-process.ts wires both into its Deliverer.
 */

import type { AgentState } from "../store/registry.ts";
import type { Layout } from "../store/layout.ts";
import { sharedTeam, type Teams } from "../store/teams.ts";
import {
	type Envelope,
	type EnvelopeType,
	ENVELOPE_ID_RE,
	MAIN_ADDRESS,
	makeEnvelope,
	parseAddress,
	USER_ADDRESS,
} from "./envelope.ts";
import { recordCollectRequest, recordSentQuestion, writeEnvelope } from "./mailbox.ts";

// ---------------------------------------------------------------------------
// Guards (Phase 4 plugs; allow-all defaults kept for lower-phase harnesses)
// ---------------------------------------------------------------------------

export type GuardVerdict = { allowed: true; team: string | null } | { allowed: false; reason: string };

/**
 * Sub→sub comm ACL (D12): only invoked for agent→agent envelopes (main/user
 * traffic bypasses, team stays null). The default allows everything and
 * stamps no team.
 */
export type TeamGuard = (envelope: Omit<Envelope, "team">) => GuardVerdict;
export const allowAllTeamGuard: TeamGuard = () => ({ allowed: true, team: null });

/**
 * The real D12 guard: sub→sub send allowed iff sender and recipient share ≥1
 * team; the authorizing team is stamped onto the envelope. Membership is read
 * live per send (teams.json is the single source of truth and the main agent
 * edits it at any time). A teamless agent is a solo worker: reverse channel
 * to main only — its peer sends fail this check like any other non-teammate.
 */
export function makeTeamGuard(getTeams: () => Teams): TeamGuard {
	return (envelope) => {
		const team = sharedTeam(getTeams(), envelope.from, envelope.to);
		if (team !== null) return { allowed: true, team };
		return {
			allowed: false,
			reason:
				`Out of team: \`${envelope.from}\` and \`${envelope.to}\` share no team, and peer mail ` +
				"requires a shared team. Report to the main agent instead — it organizes teams.",
		};
	};
}

/** What the hops rail judges: chain depth plus enough routing to spare the escape route. */
export interface HopsGuardInput {
	/** Causal-chain depth of the envelope about to be sent. */
	hops: number;
	from: string;
	to: string;
	type: EnvelopeType;
}

/** Causal-chain depth rail (D21). rails/hops.ts supplies the maxHops cap. */
export type HopsGuard = (input: HopsGuardInput) => { allowed: true } | { allowed: false; reason: string };
export const allowAllHopsGuard: HopsGuard = () => ({ allowed: true });

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface DeliverySendOptions {
	/** Pre-reserved envelope id for durable final-report evidence. */
	envelopeId?: string;
	/** Sender address: `<type>/<id>`, `main`, or `user`. */
	from: string;
	/** Recipient address: `<type>/<id>` or `main`. */
	to: string;
	type: EnvelopeType;
	text: string;
	data?: unknown;
	/** Persisted completion signal for report envelopes. */
	final?: boolean;
	correlationId?: string;
	/** Accepted for API fidelity; see module header — never interrupts either way. */
	when?: "now" | "after-turn";
	/** The envelope that triggered the sending turn, for hops arithmetic (D21). */
	causedBy?: Envelope;
	/**
	 * Collect request marker: record envelope.id → this schema in the SENDER's
	 * collect index so the matching report can be validated on arrival.
	 */
	collectSchema?: unknown;
	/** Clock override (tests). */
	now?: Date;
}

export type Disposition =
	/** Recipient was dormant — wake() fired, a digest turn will consume it. */
	| "woken"
	/** Recipient is mid-turn — held for the turn-boundary drain (D11). */
	| "held"
	/** Recipient already has a turn queued — that turn will consume it. */
	| "queued"
	/** Landed in the main agent's mailbox (D16 mechanics take over). */
	| "main"
	/** Not delivered — an error envelope went back to the sender. */
	| "bounced";

export interface DeliveryOutcome {
	envelope: Envelope;
	disposition: Disposition;
	/** Recipient's state at routing time; null when bounced or main. */
	recipientState: AgentState | null;
	/** The error envelope returned to the sender (disposition "bounced"). */
	bounce?: Envelope;
	bounceReason?: string;
}

export interface DelivererOptions {
	layout: Layout;
	/** Serialize sender bookkeeping + routing with spawn/retirement publication. */
	withDeliveryLock?: <T>(run: () => T) => T;
	/**
	 * Registry lookup: the recipient's current state, or undefined for an
	 * unknown/retired address (→ bounce).
	 */
	recipientState: (address: string) => AgentState | undefined;
	/** Current durable incarnation of an agent sender (address-reuse fence). */
	senderGenerationId?: (address: string) => string | undefined;
	/** Start a mail turn on a dormant agent (fire-and-forget; runtime serializes). */
	wake: (address: string) => void;
	/** An envelope just landed in .main/mailbox/ (diagnostic hook). */
	onMainMail?: (envelope: Envelope) => void;
	/** Every envelope that left the engine (runtime "envelope-sent" events). */
	onEnvelope?: (envelope: Envelope) => void;
	/** A delivery bounced (runtime "bounce" events, Phase 6 TUI). */
	onBounce?: (failed: Envelope, bounce: Envelope, reason: string) => void;
	/** D12 shared-team check (makeTeamGuard). Default allow-all. */
	teamGuard?: TeamGuard;
	/** D21 maxHops cap (rails/hops.ts makeHopsGuard). Default allow-all. */
	hopsGuard?: HopsGuard;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Deliverer {
	private readonly _o: DelivererOptions;

	constructor(options: DelivererOptions) {
		this._o = options;
	}

	/** Build, guard, and route one envelope. Throws only on malformed addresses (caller bug/LLM typo). */
	send(options: DeliverySendOptions): DeliveryOutcome {
		const run = (): DeliveryOutcome => this._sendUnlocked(options);
		return this._o.withDeliveryLock?.(run) ?? run();
	}

	/**
	 * Funeral/route-failure bounce. It deliberately skips team/hops guards just
	 * like the engine's ordinary unknown-recipient bounce, so the error route
	 * cannot itself bounce and strand the original sender.
	 */
	bounceUndelivered(failed: Envelope, reason: string): DeliveryOutcome {
		const run = (): DeliveryOutcome => this._bounce(failed, reason);
		return this._o.withDeliveryLock?.(run) ?? run();
	}

	private _sendUnlocked(options: DeliverySendOptions): DeliveryOutcome {
		const to = parseAddress(options.to);
		if (to === null || to.kind === "user") {
			// Permanent design: no envelope is ever addressed TO `user` — the
			// user has no mailbox. The viewer's user channel is sendAsUser,
			// which sends FROM the user into a session, never to them; anything
			// meant for the human (escalations, reports) reaches them via main.
			throw new Error(
				`Cannot deliver to "${options.to}" — recipient must be "<type>/<id>" or "main".`,
			);
		}
		const from = parseAddress(options.from);
		if (from === null) throw new Error(`Malformed sender address "${options.from}".`);
		if (options.correlationId !== undefined && !ENVELOPE_ID_RE.test(options.correlationId)) {
			throw new Error(`Malformed correlationId "${options.correlationId}".`);
		}

		// Hops (D21): message-triggered turn sends → parent + 1; fresh work → 0.
		const hops = options.causedBy ? options.causedBy.hops + 1 : 0;
		const hopsVerdict = (this._o.hopsGuard ?? allowAllHopsGuard)({
			hops,
			from: options.from,
			to: options.to,
			type: options.type,
		});

		if (options.final !== undefined && options.type !== "report") {
			throw new Error("final is valid only for report envelopes.");
		}

		const fromGenerationId = from.kind === "agent" ? this._o.senderGenerationId?.(options.from) : undefined;
		const draft = {
			...(options.envelopeId !== undefined ? { id: options.envelopeId } : {}),
			from: options.from,
			...(fromGenerationId !== undefined ? { fromGenerationId } : {}),
			to: options.to,
			type: options.type,
			text: options.text,
			...(options.data !== undefined ? { data: options.data } : {}),
			...(options.final !== undefined ? { final: options.final } : {}),
			correlationId: options.correlationId ?? null,
			hops,
			...(options.now ? { now: options.now } : {}),
		};

		if (!hopsVerdict.allowed) {
			return this._bounce(makeEnvelope({ ...draft, team: null }), hopsVerdict.reason);
		}

		// Team check applies to sub→sub traffic only (D12); main/user bypasses.
		// A retired/unknown recipient bounces as "no such agent" (rule 3)
		// BEFORE the team check — membership is meaningless for the dead.
		let team: string | null = null;
		if (from.kind === "agent" && to.kind === "agent") {
			const envelopeSansTeam = makeEnvelope({ ...draft, team: null });
			if (this._o.recipientState(options.to) === undefined) {
				return this._bounce(envelopeSansTeam, `No agent at "${options.to}" — retired or never spawned.`);
			}
			const verdict = (this._o.teamGuard ?? allowAllTeamGuard)(envelopeSansTeam);
			if (!verdict.allowed) return this._bounce(envelopeSansTeam, verdict.reason);
			team = verdict.team;
		}

		const envelope = makeEnvelope({ ...draft, team });

		// Sender-side bookkeeping BEFORE routing, so the wake digest can quote
		// even if the process dies right after delivery.
		const senderMailbox = this._mailboxOf(options.from);
		if (senderMailbox) {
			if (envelope.type === "question") {
				recordSentQuestion(senderMailbox, envelope.id, envelope.payload.text, envelope.to);
			}
			if (options.collectSchema !== undefined) {
				recordCollectRequest(senderMailbox, envelope.id, options.collectSchema, envelope.to);
			}
		}

		return this._route(envelope);
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private _route(envelope: Envelope): DeliveryOutcome {
		if (envelope.to === MAIN_ADDRESS) {
			writeEnvelope(this._o.layout.mainMailboxDir, envelope);
			this._o.onEnvelope?.(envelope);
			this._o.onMainMail?.(envelope);
			return { envelope, disposition: "main", recipientState: null };
		}

		const state = this._o.recipientState(envelope.to);
		if (state === undefined) {
			return this._bounce(envelope, `No agent at "${envelope.to}" — retired or never spawned.`);
		}

		const parsed = parseAddress(envelope.to);
		if (parsed?.kind !== "agent") throw new Error(`unreachable: routing "${envelope.to}"`);
		writeEnvelope(this._o.layout.mailboxDir(parsed.type, parsed.id), envelope);
		this._o.onEnvelope?.(envelope);

		// D11: never interrupt. Only a dormant recipient gets woken.
		if (state === "dormant") {
			this._o.wake(envelope.to);
			return { envelope, disposition: "woken", recipientState: state };
		}
		if (state === "queued") return { envelope, disposition: "queued", recipientState: state };
		return { envelope, disposition: "held", recipientState: state }; // running | waiting
	}

	/**
	 * Return an error envelope to the sender (delivery rules 2–3). The bounce
	 * "speaks" from the failed recipient address, correlates to the failed
	 * envelope, preserves chain depth, and skips all guards. Undeliverable
	 * bounces (sender gone, or sender was `user`) fall to the main mailbox as
	 * the operator of last resort; if even that fails they are dropped.
	 */
	private _bounce(failed: Envelope, reason: string): DeliveryOutcome {
		const bounceTo = failed.from === USER_ADDRESS ? MAIN_ADDRESS : failed.from;
		const bounceFrom = parseAddress(failed.to);
		const bounceGenerationId = bounceFrom?.kind === "agent" ? this._o.senderGenerationId?.(failed.to) : undefined;
		const bounce = makeEnvelope({
			from: failed.to,
			...(bounceGenerationId !== undefined ? { fromGenerationId: bounceGenerationId } : {}),
			to: bounceTo,
			type: "error",
			correlationId: failed.id,
			team: null,
			hops: failed.hops,
			text: `Delivery failure: ${reason}\nYour message (${failed.id}, ${failed.type}) was NOT delivered:\n${failed.payload.text}`,
		});

		this._o.onBounce?.(failed, bounce, reason);

		if (bounceTo === MAIN_ADDRESS) {
			writeEnvelope(this._o.layout.mainMailboxDir, bounce);
			this._o.onEnvelope?.(bounce);
			this._o.onMainMail?.(bounce);
			return { envelope: failed, disposition: "bounced", recipientState: null, bounce, bounceReason: reason };
		}

		const sender = parseAddress(bounceTo);
		if (sender?.kind === "agent" && this._o.recipientState(bounceTo) !== undefined) {
			writeEnvelope(this._o.layout.mailboxDir(sender.type, sender.id), bounce);
			this._o.onEnvelope?.(bounce);
			if (this._o.recipientState(bounceTo) === "dormant") this._o.wake(bounceTo);
		}
		// Sender unknown/retired: bounce dropped (nowhere to say so).
		return { envelope: failed, disposition: "bounced", recipientState: null, bounce, bounceReason: reason };
	}

	/** The sender's own mailbox dir (for its sent-question/collect indexes). */
	private _mailboxOf(address: string): string | null {
		if (address === MAIN_ADDRESS) return this._o.layout.mainMailboxDir;
		const parsed = parseAddress(address);
		return parsed?.kind === "agent" ? this._o.layout.mailboxDir(parsed.type, parsed.id) : null;
	}
}
