# pi-steer-queue

Own the messages you type while the agent is busy — a true pending-message
**queue** with cancel, edit, reorder, send-now, and steer-vs-queue control,
instead of Pi's fire-and-forget native steering.

## Why

Native Pi: submitting while the agent streams *steers* the message (Alt+Enter
*queues* it as a follow-up) — and once it is in Pi's native queue no extension
can cancel it, edit it, or flip it between steer/queue. This extension
intercepts the submission (`on("input")` returns `handled`) and holds the
message itself, so it stays under your control until the moment of delivery.

## What you see

Every message typed while the agent is busy becomes a separate queue entry
(order preserved). An above-editor widget shows the queue:

```
Steering (3)
 1. first message…
 2. also fix the tests…
 3. and update the readme…
↳ alt+x cancel last · alt+q switch to queue · /queue manage
```

Up to 5 entries are previewed (first line each, truncated); more fold into a
`… +N more` line. The widget hides when the queue is empty.

## Keybinds

| Key | Action |
|-----|--------|
| `alt+x` | cancel the **most recent** pending entry (last one gone → widget hides) |
| `alt+q` | toggle the **whole queue** between steer and queue (follow-up) mode |

The queue's mode is initialized from how the *first* entry was submitted
(Enter → steer, Alt+Enter → queue); later submissions just append.

Slash commands (`/…`) are never swallowed — they execute immediately, even
while the agent streams.

## /queue panel (alias: /steer)

A management panel listing every pending entry:

| Key | Action |
|-----|--------|
| `↑`/`↓` | select an entry |
| `Enter` / `e` | edit the entry in an embedded editor (Enter applies, Esc cancels) |
| `s` | send the entry **now** (streaming → steering queue, i.e. next step boundary; idle → starts a turn) |
| `K` / `J` | move the entry up / down |
| `d` / `x` | delete the entry |
| `t` | toggle the whole queue's steer/queue mode |
| `Esc` / `q` | close |

The panel refreshes live if the queue changes while it is open (a delivery
fires, or `alt+x`/`alt+q` is pressed) and closes itself when the queue empties.

## Delivery semantics

Entries are always delivered **in order** and as **separate messages**:

- **Steer mode** — at the next `turn_end`, every entry is pushed into Pi's
  native steering queue (`sendUserMessage` with `deliverAs: "steer"`, one call
  per entry). The agent loop drains that queue at the next step boundary as
  individual user messages. Until that boundary, `alt+x`/`alt+q`//`queue`
  still work.
- **Queue mode** — at `agent_end`. If the agent is somehow still streaming,
  all entries are pushed as native follow-ups (separate messages, in order).
  In the normal (idle) case, `sendUserMessage` starts a fresh turn and awaits
  the entire run — so only the **first** entry is sent then, and each
  remaining entry goes out at the *following* `agent_end`: one entry per agent
  run, still separate, still ordered, and still cancellable in between.

`agent_end` also flushes any still-held entries as a safety net (e.g. steer
entries that missed their boundary).

## Install

Add this package's path to `~/.pi/agent/settings.json` under `packages`.
Restart Pi after changes (event/shortcut registrations are read at startup).
