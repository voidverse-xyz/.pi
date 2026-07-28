# Envelope Contract — Messages Between Agents

> **Historical — superseded.** This envelope specification includes retired peer and escalation behavior. Use `03-tool-surface.md` and current runtime types for the active contract.

Decided 2026-07-09 (D11, D12, D14). One envelope shape for every message in the
system, regardless of direction (main→sub, sub→sub, sub→main).

## Envelope

```json
{
  "id": "msg_<ulid>",
  "from": "refactorer/auth",
  "fromGenerationId": "gen_<32 lowercase hex>",
  "to": "refactorer/api",
  "type": "message",
  "correlationId": null,
  "team": "billing-refactor",
  "hops": 0,
  "payload": { "text": "..." },
  "sentAt": "2026-07-09T21:14:03.120Z"
}
```

| Field | Notes |
|---|---|
| id | unique, sortable (ulid) — doubles as the mailbox filename |
| from / to | agent address `<type>/<id>`, or the specials `main` and `user` |
| fromGenerationId | optional durable sender-incarnation fence on agent-originated mail; omitted for main/user and accepted as absent on legacy envelopes |
| type | see table below |
| correlationId | links answer→question, final report→task assignment, or collect report→request; null otherwise |
| team | the team the send was authorized under (sub→sub only; null for main/user traffic) |
| hops | causal-chain depth (D21): parent.hops + 1 when a message-triggered turn sends a message; fresh work = 0. Over maxHops (default 8) → bounces: "report to the main agent instead" |
| payload | type-specific; always has human-readable `text`; collect results add `data`; final reports persist `final:true` (D26) |
| sentAt | runtime-stamped, not sender-claimed |

## Types

| type | direction | meaning |
|---|---|---|
| message | any | plain communication / task instruction |
| question | sub→main, sub→sub | needs an answer to proceed; asker goes dormant (non-blocking, D14) |
| answer | main→sub, sub→sub | reply; correlationId REQUIRED |
| report | sub→main | progress or final result (`payload.final:true`; final auto-retires a oneshot, D13/D26) |
| escalation | sub→main→user | tool call blocked by type policy; only a HUMAN may approve (D10) |
| error | sub→main | fatal runtime/tool failure or explicit delivery failure; warning thresholds do not emit errors |

## Delivery rules

1. Mail NEVER interrupts a running turn — delivery is at turn boundaries or on wake
   (D11). Steering is a separate main-agent-only verb, not an envelope.
2. sub→sub requires sender and recipient to share ≥1 team (teams.json); otherwise
   the envelope bounces back as an error to the sender (D12).
3. Send to a retired/unknown address bounces: "no such agent".
4. Questions are non-blocking: asker ends its turn; the answer wakes it (D14).
5. Wake digest: the runtime composes the wake injection deterministically — each
   answer is delivered with its original question quoted (correlationId lookup),
   followed by all other mail queued during dormancy, ordered by id (D14).
6. An uncorrelated peer `message` sent by an agent already in the current required
   group is a transitive task assignment. The recipient's final report to main
   correlates to that peer envelope id, so parent completion cannot hide child work.
7. Mailbox on disk: one file per envelope under the recipient's dir
   (`owners/<main-session-id>/<type>/<id>/mailbox/<msg-id>.json`); processed mail
   moves to `mailbox/.done/` (kept for audit, GC'd with the same N-day policy as
   .archive). Main mailbox is under that same owning session scope.

## Ordering & at-least-once

Mailbox files are processed in id (ulid) order. The runtime deletes/moves an
envelope only after the receiving turn has been durably appended to the session
JSONL — a crash between delivery and append re-delivers (at-least-once; the
digest labels re-delivered mail as such). Main digest/await delivery atomically
claims files into `.delivering/` before rendering and finalizes only after the
owning main-session JSONL contains both envelope id and an accepted delivery
marker. If an await races a normal digest claim, it registers its tool-result
marker as an alternate proof and can read the parked result instead of
stranding. A crash before append requeues the claim only under a newly acquired
exclusive host-scope lease; a live host leaves unverified mail in flight.
Timeout/cancelled await consumes nothing. The main mailbox's aged/GC-bounded
`.await-anchors.json` records each task/collect anchor's recipient generation;
combined with envelope `fromGenerationId`, this prevents traffic from a reused
or already-retired address generation from settling an older join. Startup also
reconstructs an assignment anchor from the agent mailbox when a crash lands
after task-envelope delivery but before anchor persistence (D26).
