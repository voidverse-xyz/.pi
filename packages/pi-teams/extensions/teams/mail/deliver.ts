/**
 * mail/deliver.ts — the delivery engine (D11/D-envelope'). Builds an envelope,
 * routes it to the recipient's mailbox, and reports the disposition. Mail never
 * interrupts a running turn (D11): a dormant recipient is woken; a busy one has
 * the mail held for its turn boundary. Unknown/retired agent recipients bounce
 * an error envelope back to the sender.
 *
 * v2 has NO team guard (flat peer comm — D12). A pluggable hops guard (D21) is
 * injected by the core facade; the default allows everything.
 */

import {
	type Address,
	type Envelope,
	type EnvelopeType,
	formatAddress,
	MAIN_ADDRESS,
	makeEnvelope,
	parseAddress,
} from "./envelope.ts";
import { recordSentQuestion, writeEnvelope } from "./mailbox.ts";
import type { AgentState } from "../store/registry.ts";

export type Disposition = "woken" | "held" | "queued" | "main" | "bounced" | "dropped";

export interface DeliveryOutcome {
	delivered: boolean;
	disposition: Disposition;
	recipientState?: AgentState;
	envelopeId: string;
	bounceReason?: string;
}

/** A hops guard (D21, wired by the core facade). Returns a bounce reason, or null to allow. */
export type HopsGuard = (envelope: Envelope) => string | null;

export interface DelivererHooks {
	mainMailboxDir: string;
	/** Mailbox dir for an agent, or undefined if it doesn't exist / is retired. */
	agentMailboxDir(type: string, id: string): string | undefined;
	/** Live state of an agent, or undefined if unknown/retired. */
	agentState(address: string): AgentState | undefined;
	/** Generation fence for an agent sender (fromGenerationId), or undefined. */
	generationOf(address: string): string | undefined;
	/** Schedule a mail turn for a dormant agent (the wake). */
	wake(address: string): void;
	/** The sender's mailbox dir (to record sent-questions), or undefined for user. */
	senderMailboxDir(from: Address): string | undefined;
}

export interface SendParams {
	from: Address;
	to: string;
	type: EnvelopeType;
	text: string;
	data?: unknown;
	final?: boolean;
	correlationId?: string | null;
	/** The envelope whose processing caused this send (for hops accounting). */
	causedBy?: Envelope | null;
}

export class Deliverer {
	constructor(
		private readonly hooks: DelivererHooks,
		private readonly hopsGuard: HopsGuard = () => null,
	) {}

	/** Build and route an envelope. Returns the disposition; performs writes + wake. */
	send(params: SendParams): DeliveryOutcome {
		const toAddress = parseAddress(params.to);
		if (toAddress === null || toAddress.kind === "user") {
			// Cannot send TO the user; treat as a bounce back to the sender.
			return this.bounce(params, `cannot deliver to ${JSON.stringify(params.to)}`);
		}

		const hops = params.causedBy ? params.causedBy.hops + 1 : 0;
		const fromGen = params.from.kind === "agent" ? this.hooks.generationOf(formatAddress(params.from)) : undefined;
		const envelope = makeEnvelope({
			from: params.from,
			to: toAddress,
			type: params.type,
			text: params.text,
			...(params.data !== undefined ? { data: params.data } : {}),
			...(params.final !== undefined ? { final: params.final } : {}),
			correlationId: params.correlationId ?? null,
			hops,
			...(fromGen !== undefined ? { fromGenerationId: fromGen } : {}),
		});

		// Hops rail (D21) — the sacred upward escape (report/escalation/error to
		// main) is never blocked; the guard itself decides.
		const bounceReason = this.hopsGuard(envelope);
		if (bounceReason !== null) return this.bounce(params, bounceReason);

		// Record a question we're sending so the answer can be quoted on wake (D14).
		// Deferred until AFTER the recipient is confirmed to exist, so a question that
		// bounces to an unknown agent doesn't leak an entry that will never be answered.
		const recordQuestion = (): void => {
			if (envelope.type !== "question") return;
			const senderMailbox = this.hooks.senderMailboxDir(params.from);
			if (senderMailbox) recordSentQuestion(senderMailbox, envelope.id, envelope.payload.text, envelope.to);
		};

		if (toAddress.kind === "main") {
			recordQuestion();
			writeEnvelope(this.hooks.mainMailboxDir, envelope);
			return { delivered: true, disposition: "main", envelopeId: envelope.id };
		}

		// Agent recipient.
		const address = formatAddress(toAddress);
		const state = this.hooks.agentState(address);
		const mailboxDir = this.hooks.agentMailboxDir(toAddress.type, toAddress.id);
		if (state === undefined || mailboxDir === undefined) {
			return this.bounce(params, `no such agent \`${address}\``);
		}
		recordQuestion();
		writeEnvelope(mailboxDir, envelope);
		if (state === "dormant") {
			this.hooks.wake(address);
			return { delivered: true, disposition: "woken", recipientState: "queued", envelopeId: envelope.id };
		}
		// running / waiting / queued: held for the turn boundary (never interrupt, D11).
		return { delivered: true, disposition: state === "queued" ? "queued" : "held", recipientState: state, envelopeId: envelope.id };
	}

	/** Bounce a failed send back to its sender as an error envelope (skips guards). */
	private bounce(params: SendParams, reason: string): DeliveryOutcome {
		const failedId = `(undelivered to ${params.to})`;
		const bounceText = `Delivery to \`${params.to}\` failed: ${reason}. Original message: ${params.text}`;
		// The bounce goes to the ORIGINAL sender's mailbox. User senders have no
		// mailbox — their failures surface via the tool result, so drop here.
		if (params.from.kind === "user") {
			return { delivered: false, disposition: "dropped", envelopeId: failedId, bounceReason: reason };
		}
		const bounceTo = params.from;
		const errorEnvelope = makeEnvelope({
			from: MAIN_ADDRESS, // system-origin bounce
			to: bounceTo,
			type: "error",
			text: bounceText,
			correlationId: null,
			hops: params.causedBy ? params.causedBy.hops : 0,
		});
		if (bounceTo.kind === "main") {
			writeEnvelope(this.hooks.mainMailboxDir, errorEnvelope);
		} else {
			const mailboxDir = this.hooks.agentMailboxDir(bounceTo.type, bounceTo.id);
			if (mailboxDir) {
				writeEnvelope(mailboxDir, errorEnvelope);
				if (this.hooks.agentState(formatAddress(bounceTo)) === "dormant") this.hooks.wake(formatAddress(bounceTo));
			} else {
				// The original sender retired between send and bounce — nothing was
				// written anywhere, so report `dropped`, not a misleading `bounced`.
				return { delivered: false, disposition: "dropped", envelopeId: `(undelivered to ${params.to})`, bounceReason: reason };
			}
		}
		return { delivered: false, disposition: "bounced", envelopeId: errorEnvelope.id, bounceReason: reason };
	}
}
