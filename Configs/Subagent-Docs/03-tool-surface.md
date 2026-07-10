# Tool Surface — What the Main Agent's LLM Sees

Decided 2026-07-09 (D16). Implements the 01-power-matrix.md allowed set as seven
intent-grouped tools. Rejected: one multiplexed mega-tool (sparse schema, weak
validation); one-tool-per-power (context bloat).

## Tools

### subagent_spawn
```
(type, id?, team?, lifetime?: "persistent"|"oneshot", task?)
→ { address, created: boolean, state, vitals }
```
- Get-or-create on `<type>/<id>` (D5): created:false = existed, woke it, memory intact.
- id required for persistent spawns (meaningful purview slug; default "main" for
  singleton types); omitted id on oneshot → auto `tmp-<short>`.
- team: names a team; creates it if new (D12).
- task: optional first message — spawn + assign in one call (the common case).

### subagent_send
```
(to, text, when?: "now"|"after-turn", correlationId?)
→ { delivery: "delivered"|"queued", disposition: "woken"|"held"|"queued", recipientState }
```
- Covers three matrix powers: send (when:"now", default), queue (when:"after-turn"),
  answer (correlationId set → answer envelope). correlationId doubles as the
  escalation-deny channel: correlating to a pending escalation envelope's id DENIES
  that blocked call (text = deny note); main can never approve (D10).
- Never interrupts a running turn regardless of `when` (D11); "now" vs "after-turn"
  only matters for orderings around the recipient's queued mail. Both wake a dormant
  recipient — there is no way to hold mail without waking it.
- disposition disambiguates delivery:"queued": "held" = recipient mid-turn (boundary
  drain), "queued" = a turn was already scheduled. "woken" pairs with
  delivery:"delivered" and recipientState:"queued" (the wake scheduled the turn).

### subagent_steer
```
(to, text) → { steered: boolean }
```
- Deliberately its own tool (D11): steering ≠ mail. Main-agent-only; injects
  mid-turn to redirect current work. No-op with steered:false if agent not running.

### subagent_status
```
(address?, tail?) → roster | detail
```
- No address: full roster — per agent: address, type, state
  (queued|running|dormant|waiting), teams, purview, vitals {ctx%, tokens, cost,
  turns} (D15), `unread` (mailbox pending count), and — when state is `waiting` —
  `waitingOn`: the pending escalation summary {id, envelopeId, tool, reason}.
- With address: detail + `outstandingQuestions` (questions the agent sent, from its
  .sent-questions.json index, with no answer/bounce on record — recoverable after
  main's context compacts) + last `tail` transcript entries (peek; never perturbs).

### subagent_collect
```
(to, schema) → { requested: true, requestId, recipientState }
```
- Non-blocking like everything else (D14): asks the agent to deliver a final
  result conforming to `schema`; result arrives later as a report envelope with
  payload.data validated against the schema (restricted subset: type/properties/
  required/items/enum/const/additionalProperties:false; other keywords ignored).
- requestId = the collect-request envelope's id; the fulfilling report carries it
  as correlationId, so multiple outstanding collects stay distinguishable.

### subagent_interrupt
```
(to) → { interrupted: boolean }
```
- Aborts the current turn; agent stays alive, memory intact, goes dormant.

### subagent_retire
```
(to) → { retired: true }
```
- The ONLY destructive tool — kept separate so Pi's per-tool permissioning can
  require confirmation for it alone. Deregisters, bounces future sends, scrubs
  teams.json, moves dir to .archive/ (N-day GC) (D13).

## Not tools (by design)
- approve — the main agent can never grant a blocked call (D10); escalation goes
  to the human.
- suspend / retune / compact / fork — see D10 (auto or deferred).
- Sub→sub send: subagents get a reduced send-only tool pair (send/queue) — same
  envelope, team-checked at delivery (D12). No other subagent tools.

## Main-agent mailbox delivery (D16, option c — selective auto-wake)
The main agent is a Pi session; envelopes reach its LLM via turn mechanics:
- Mid-turn: mail waits for the turn boundary, then injects digest-style (D14).
- Idle + type ∈ {question, escalation, error}: AUTO-WAKE — the extension starts a
  main-agent turn with the wake digest as input. A subagent blocked on its "user"
  unblocks immediately without human presence.
- Idle + type = report: queues quietly; TUI widget shows unread count (📬 n);
  delivered at the start of the next turn (user-initiated or auto-woken).
- Config toggle: autoWake: true (default) | false → fully-manual queueing (b-mode).
- escalation additionally surfaces a human approval prompt in the TUI — auto-wake
  lets the main agent react (deny / re-plan), but only the human can approve (D10).
