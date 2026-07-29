# Power Matrix — Interaction Contract

> **Historical — superseded.** This matrix documents an earlier team-capable design. The active hub-and-spoke contract is in `03-tool-surface.md` and the current implementation note.

Decided 2026-07-09. Governing principle (D9): the main agent is the *user* of its
subagents — but with deliberately trimmed powers (D10). Subagent→subagent is a
further-reduced subset. Approvals never flow downhill.

## Main agent → subagent

### Allowed
| Power | Semantics |
|---|---|
| spawn | get-or-create on `type/id`; result reports `created: true\|false` |
| send | new turn if idle; queues to mailbox if dormant |
| queue | deliver after the current turn ends |
| steer | inject mid-turn, redirect current work |
| interrupt | abort current turn; agent stays alive, memory intact |
| status / peek | state (idle/running/waiting/dormant) + transcript tail; read-only, never perturbs |
| list | enumerate roster: types, ids, states, purviews |
| collect | request a schema-conforming final result |
| retire | delete identity + memory — the ONLY destructive power |
| answer question | reply to a subagent's `question` envelope (just send, correlated) |

### Not allowed
| Power | Why denied |
|---|---|
| approve blocked tool calls | may only deny or escalate to the human; can never grant beyond type policy |
| suspend | not a power; dormancy is automatic when a turn ends with nothing queued |
| retune model/thinking | model belongs to the type definition (deferred) |
| compact | automatic runtime threshold policy, not a tool |
| fork | deferred; contract must not preclude it |

## Subagent → subagent

### Allowed
| Power | Semantics |
|---|---|
| send | point-to-point envelope to a peer's mailbox |
| queue | same, delivered after the peer's current turn |

### Not allowed
steer (mid-turn interference is chaos) · interrupt/retire (peers must not stop or
kill peers) · spawn (fan-out is a main-agent monopoly; keeps the org chart
traceable) · status/peek/list (ask the main agent or message the peer) ·
approvals (never).

## Subagent → main agent (reverse channel — envelope types, not tools)
| Envelope | Meaning |
|---|---|
| report | turn finished / progress / final result |
| question | needs an answer to proceed (correlationId links the reply) |
| escalation | tool call blocked by type policy — requires a HUMAN decision |
| error | crashed, budget exhausted, stuck |

## Reserved for the human user
- Approving escalated tool calls — anything outside a type's declared policy lands
  on the human, never on the main agent.
- Editing type definitions (`.md` files). (Main-agent authoring of new types is
  still UNDECIDED — see design log.)
- Superset rule: via the TUI, the human can always do everything the main agent can.

## Safety model in one line
Capability is granted statically in the type definition (sandbox: tools, paths,
read-only, budgets); anything outside it escalates to the human; no LLM ever
approves another LLM's blocked action.
