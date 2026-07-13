# Tool Surface — What the Main Agent's LLM Sees

Decided 2026-07-09 (D16), extended 2026-07-12 (D26). Implements the
01-power-matrix.md allowed set as eight intent-grouped tools. Rejected: one multiplexed mega-tool (sparse schema, weak
validation); one-tool-per-power (context bloat).

## Tools

### subagent_spawn
```
(type, id?, team?, lifetime?: "persistent"|"oneshot", task?)
→ { address, created: boolean, state, vitals, taskEnvelopeId? }
```
- Get-or-create on `<type>/<id>` (D5): created:false = existed, woke it, memory intact.
- id required for persistent spawns (meaningful purview slug; default "main" for
  singleton types); omitted id on oneshot → auto `tmp-<short>`.
- team: names a team; creates it if new (D12).
- task: optional first message — spawn + assign in one call; its envelope id is returned as an await anchor.

### subagent_send
```
(to, text, when?: "now"|"after-turn", correlationId?)
→ { delivery: "delivered"|"queued", disposition: "woken"|"held"|"queued", recipientState, envelopeId }
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
  Within the subset validation is honest: `additionalProperties:false` closes the
  object even when `properties` is absent/partial (unknown keys rejected);
  `const`/`enum` equality is JSON-semantic (order-independent for objects,
  recursive); and a `type` whose value is not a known type keyword is reported as
  a schema error, not a silent match. Out-of-subset keywords stay ignored.
- requestId = the collect-request envelope's id; the fulfilling report carries it
  as correlationId, so multiple outstanding collects stay distinguishable.

### subagent_await
```
(to, waitFor: "final"|"collect", anchorId, timeoutSeconds?)
→ { status: "completed"|"attention"|"timeout"|"retired", report?, attention?, progress? }
```
- Final mode matches `payload.final:true` correlated to a task/send anchor; collect mode
  matches a report correlated to requestId.
- Questions/escalations/errors return `attention` early so waiting cannot deadlock.
- Timeout/cancellation consumes no mail. Completed results are parked until the
  main-session JSONL durably contains the await tool result (D26).

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
  teams.json, moves dir to .archive/ (N-day GC) (D13). Pending owner/user mail
  is quietly audited as cancelled; peer mail still bounces (D26).

## Not tools (by design)
- approve — the main agent can never grant a blocked call (D10); escalation goes
  to the human.
- suspend / retune / compact / fork — see D10 (auto or deferred).
- Sub→sub send: subagents get a reduced send-only tool pair (send/queue) — same
  envelope, team-checked at delivery (D12). No other subagent tools.

## Main-agent mailbox delivery (D24 — all-mail auto-wake with abort latch)
The main agent is a Pi session; envelopes reach its LLM via turn mechanics:
- Mid-turn: mail waits for `agent_settled`, then injects digest-style (D14).
- Idle + any envelope type: AUTO-WAKE — the extension starts a main-agent turn
  with the wake digest as input.
- Any aborted main-agent run durably latches auto-wake off across reload/restart.
  Mail queues visibly (📬 n) until the next interactive/RPC user message clears it and
  receives the queued digest. Pi reports an abort but not whether Esc caused it.
- Main wakeups do not consume or obey the subagent autonomy turn/token pool.
- Config toggle: autoWake: true (default) | false → fully-manual queueing.
- Escalations additionally surface a human approval prompt in the TUI; only the
  human can approve (D10).
