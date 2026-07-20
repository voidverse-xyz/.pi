# Pi Teams Activity Usage

## Outcome

The live Teams widget now places each working agent's current context fill, cumulative token usage, and queued mail beside its per-turn tool count. Nerd Font icons keep the row compact while short labels preserve meaning:

```text
󱘎 Running 2 team agents · 󰇮 1 main mail · alt+s stop
├─ reviewer/main ·  3 tools ·  41.2% ·  23k tokens · 󰇮 2 mail
│  └ Read: src/index.ts

```

The header shows aggregate unread main mail, and each working-agent row shows unread mail queued for that agent. Zero mail counts are omitted. When visible, the widget ends with one blank spacer line so it is separated from the project/Git status row below. It remains hidden when no team agents are working and no main mail is unread.

## Data Semantics

- **Tool uses** count tool calls in the current agent turn.
- **Context** comes from the live `AgentSession.getSessionStats().contextUsage.percent` value and uses the SDK's `0–100` percentage scale. The hard-drive metric renders as ` ?` while the SDK reports context as unknown, such as immediately after compaction.
- **Tokens** come from `AgentSession.getSessionStats().tokens.total` and are cumulative for the agent session across input, output, cache-read, and cache-write tokens. The widget abbreviates thousands and millions.
- **Main mail** is the unread count in the main agent's Teams mailbox.
- **Agent mail** is unread mail queued for that subagent while its current turn runs; the mail driving the active turn is already being processed and is not counted.
- If a live handle is temporarily unavailable, the activity snapshot falls back to the persisted roster vitals.

## Implementation

- `extensions/teams/runtime/types.ts` adds usage and unread-mail fields to each activity row.
- `extensions/teams/runtime/in-process.ts` reads fresh live-session metrics and agent-mail counts on every activity snapshot.
- `extensions/teams/tui/tree-widget.ts` renders the family-tree, terminal, hard-drive, CPU, and mail Nerd Font icons with compact labels. It mounts one persistent component before the status-line package, then requests rerenders without reinserting its widget key; this keeps the Teams tree above the project/Git status row instead of switching positions during activity.
- The picker and viewer now consume the SDK percentage directly instead of multiplying its already-percent value by 100.
- `test/e2e/phase6-tui.mjs` covers populated and unknown usage rendering.

## Verification

```sh
configs/pi-agent/packages/pi-teams/test/e2e/run.sh
```

Result: strict typecheck clean; all 11 harnesses passed (116 checks).
