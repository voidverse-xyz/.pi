# Pi main-agent timers

## Purpose

`configs/pi-agent/packages/pi-timers/` provides recurring wake-ups for the owning main Pi agent. It is deliberately not a cron service, background worker, durable scheduler, or subagent capability.

A timer owns a fixed interval, instruction, optional finite run cap, run counter, pending-wake gate, coalesced-tick count, and native interval handle. It sends the instruction into the main session; the main agent performs the requested work using whatever tools and permissions are active at that time.

## Verified Pi contracts

- `/opt/pi/docs/extensions.md` says factories must not start timers or other long-lived resources. Resources begin during `session_start` or on demand and must be cleaned idempotently in `session_shutdown`.
- `pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true })` queues without interrupting a busy turn and starts a new turn when idle.
- `agent_settled` is the boundary where no retry, compaction retry, or queued continuation remains.
- `configs/pi-agent/packages/pi-teams/extensions/teams/index.ts` and `pi-subagents/extensions/subagents/index.ts` use the same wake-delivery option pair and include real-runtime regression coverage for idle auto-wake.
- Pi subagents and team workers set `resourceLoaderOptions.noExtensions: true`, then pass explicit `customTools` arrays.
- Procedure workers use `DefaultResourceLoader({ noExtensions: true })`, `noTools: "builtin"`, and an explicit `customTools` array.

Therefore `manage_timers`, registered by the main extension runtime, is absent from all repository worker runtimes.

## Behavioral contract

- Package: `pi-timers`.
- Main-agent tool: `manage_timers` with `create`, `list`, `cancel`, and `cancel_all`.
- Human command: `/timers` for status and emergency cancellation only.
- Ambient UI: a stable above-editor tree with one countdown/instruction row pair per active timer.
- Shortcut: `Alt+R`, verified free across installed extension shortcuts and configured Pi keybindings, opens a cancellation picker.
- First wake: one complete interval after creation.
- Run accounting: increment only after synchronous wake injection is accepted.
- Completion: without `maxRuns`, recur until cancellation or session shutdown; with it, clear the native handle and remove the timer after accepting that many wakes.
- Overlap: while one wake for a timer is pending, later due ticks coalesce without decrementing remaining runs.
- Settlement: `agent_settled` clears pending gates for active timers.
- Cancellation: prevents future injection but cannot retract an already accepted follow-up.
- Shutdown: all handles are cleared and state is discarded.
- Persistence: none.

## Safety limits

The implementation caps active timers at five, intervals at 60 seconds through seven days, instructions at 4,000 characters, and labels at 80 characters. `maxRuns` is optional, accepts any positive whole number without an application-level maximum, and defaults to recurrence until cancellation or session shutdown.

A timer wake can incur model cost and cause tool side effects. Prompt guidance permits creation only after an explicit user request. The current Pi mode and tool policies remain authoritative when the wake runs; the timer does not bypass confirmations or grant capabilities.

## Structure

```text
pi-timers/
├── extensions/timers/
│   ├── index.ts
│   ├── timer-manager.ts
│   └── tui/
│       ├── picker.ts
│       ├── render.ts
│       └── widget.ts
├── test/
│   ├── fixtures/introspect-tools.ts
│   ├── render.test.ts
│   ├── rpc.test.mjs
│   └── timer-manager.test.ts
├── package.json
└── README.md
```

`timer-manager.ts` contains the deterministic state machine and accepts an injected scheduler and wake port. This keeps interval behavior, optional finite accounting, failure handling, coalescing, cancellation, and shutdown testable without waiting on wall-clock time.

`index.ts` is the Pi adapter: schema, tool/command/shortcut registration, lifecycle wiring, message formatting, and `sendMessage` injection.

`render.ts` is the pure widget/countdown/picker-item model. `widget.ts` owns one stable above-editor slot and a one-second render tick. `picker.ts` uses Pi's `DynamicBorder` plus `SelectList` treatment and returns a cancellation decision without mutating timer state itself.

## Verification matrix

- Unlimited and finite creation, normalization, first-run timing, invalid interval/run bounds, and active timer limit.
- Pending-wake coalescing without consuming a run.
- Unlimited recurrence beyond the former cap plus exact finite completion and native handle removal.
- Synchronous injection failure does not count as a run.
- Precise cancel, cancel-all, and idempotent disposal.
- Widget tree structure, countdown boundaries, pending/coalesced/failure state, empty state, and cancel-all picker item behavior.
- Installed Pi RPC registration of `manage_timers` and `/timers` with optional, uncapped `maxRuns` schema.
- Static main-only boundary checks for subagents, teams, and procedure workers.
- Repository-wide extension regression suite.

## Deferred scope

Durable timers are intentionally deferred. Persistence needs a versioned store, session ownership, host lease, restart reconciliation, clock-change behavior, missed-run policy, duplicate suppression, and a user-visible recovery/disable path. Remote scheduling and OS-level cron integration are also out of scope.
