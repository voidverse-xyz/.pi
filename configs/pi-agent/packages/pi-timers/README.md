# pi-timers

Recurring, in-process timers that wake only the owning main Pi agent. The main agent can create up to five timers with a fixed interval, stored instruction, and optional finite run cap. By default a timer repeats until it is cancelled or its session ends. A timer sends a custom message back into the same main session and triggers a turn; it does not execute the instruction itself.

Subagents, team workers, and procedure workers cannot use `manage_timers`. Their runtimes disable extensions and construct explicit worker tool lists.

## Example

A user can say:

> Every five minutes, check GitHub issues until I stop the timer.

The main agent calls:

```json
{
  "action": "create",
  "label": "GitHub issue check",
  "instruction": "Check GitHub issues and report anything requiring attention.",
  "intervalSeconds": 300
}
```

The first wake occurs after five minutes. Each accepted wake is labeled with its run number. The timer keeps recurring until cancellation or session shutdown. To stop automatically after a specific number of accepted wakes, include a positive `maxRuns` value; there is no application-level upper cap.

## Live widget

Active timers appear in a stable tree above the editor, using the same ambient visual language as the Teams and Subagents activity trees:

```text
󰔛 Timers · 2 active · alt+r cancel
├─ 4m 33s · 2/∞ runs · GitHub issue check
│  └ Check GitHub issues and report anything requiring attention.
└─ wake queued · 1/5 runs · Release monitor · 1 coalesced
   └ Check the release pipeline and summarize failures.
```

The countdown refreshes once per second. Accepted-but-unsettled wakes show `wake queued`; coalesced ticks and synchronous wake failures remain visible as compact diagnostics. The widget is hidden when no timers are active and always clips its rows to the terminal width.

Press **`Alt+R`** to open a bordered cancellation picker. Selecting a timer cancels its future wakes; when several are active, the picker also offers “Cancel all”. Opening the picker never cancels anything by itself.

## Tool

`manage_timers` supports:

- `create` — requires `instruction` and `intervalSeconds`; `label` and finite `maxRuns` are optional.
- `list` — returns active timers, accepted runs, pending state, next expected tick, and coalesced tick count.
- `cancel` — requires `timerId`.
- `cancel_all` — removes every active timer.

Limits are deterministic:

- five active timers;
- intervals from 60 seconds through seven days;
- any positive whole-number `maxRuns` when a finite limit is requested;
- instruction length up to 4,000 characters;
- label length up to 80 characters.

Omit `maxRuns` to repeat until cancellation or session shutdown. Providing `maxRuns` preserves finite automatic removal without an arbitrary 50-run maximum.

## Busy-agent behavior

Wake delivery uses:

```ts
{ deliverAs: "followUp", triggerTurn: true }
```

When the main agent is idle, `triggerTurn` starts a turn. When it is already working, `followUp` queues the wake without interrupting the current turn.

Each timer permits only one accepted but unsettled wake. If more ticks occur before the main agent settles, they are coalesced: they do not queue additional turns or increment the accepted-run count. The next normal interval tick may wake the agent after it settles.

When `maxRuns` is configured, an accepted wake counts toward it even if the subsequent model turn or requested operation fails. Pi's message API is fire-and-forget, so synchronous message acceptance is the boundary the extension can observe.

## Commands

- `/timers` or `/timers list` — show active timers.
- `/timers cancel` — open the interactive cancellation picker.
- `/timers cancel <timer-id>` — prevent future wakes for one timer.
- `/timers cancel-all` — prevent future wakes for all timers.
- `Alt+R` — open the same cancellation picker from the editor.

Cancelling a timer cannot retract a wake that Pi already accepted as a queued follow-up. The command and tool report that caveat when applicable.

Only the main agent creates timers through `manage_timers`; the slash command exists as a human status and emergency-cancellation surface.

## Lifecycle

Timers are intentionally process- and session-scoped:

1. The extension creates its timer manager during `session_start`, never in the extension factory.
2. Timer callbacks inject a visible custom message containing the instruction and run number.
3. A stable above-editor widget renders active timers and refreshes live countdowns once per second.
4. `agent_settled` releases the timer's one-pending-wake gate.
5. `session_shutdown` clears every native interval and the widget countdown refresh before reload, session replacement, fork, or process exit.

Timers do **not** survive `/reload`, `/new`, `/resume`, `/fork`, or Pi exit. This prevents a stale timer from waking a different session or process. Durable scheduling would require a separate design with persisted ownership, restart recovery, missed-run policy, and duplicate suppression.

## Operational notes

Every wake can consume a model turn and may invoke tools, network services, or other side effects described by its instruction. The tool guidance therefore requires an explicit user request before scheduling. Existing tool permissions, Plan/Quick restrictions, credentials, and confirmation gates still apply when the timer wakes the agent.

A timer instruction such as “check GitHub issues” needs an available GitHub capability at wake time. `pi-timers` schedules the main-agent turn; it does not supply that integration.

## Activation

The package is enabled in the repository settings. Run `/reload` or restart Pi after installing or changing it.

## Verification

```bash
node --experimental-strip-types --test \
  configs/pi-agent/packages/pi-timers/test/*.test.ts \
  configs/pi-agent/packages/pi-timers/test/*.test.mjs
```
