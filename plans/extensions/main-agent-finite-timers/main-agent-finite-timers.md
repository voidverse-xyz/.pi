# Pattern: finite main-agent timers

Use this pattern when an agent host needs a small number of process-local reminders that trigger future main-agent turns.

## Contract

A timer contains:

- unique id and optional label;
- fixed interval;
- stored instruction;
- mandatory finite run cap;
- accepted-run count;
- at most one accepted but unsettled wake;
- native timer handle owned by the active session.

The first wake occurs after one full interval. Successful synchronous delivery increments the run count. Reaching the cap clears the native handle and removes the timer.

## Host integration

- Register one typed management tool with create/list/cancel/cancel-all actions.
- Start timer resources only after the host session starts or when the tool first creates one.
- Inject a custom context message rather than impersonating a human-authored message.
- Use the host's non-interrupting follow-up delivery while busy and explicit turn trigger while idle.
- Release the per-timer pending gate only at the host's fully settled event.
- Clear every timer idempotently during session shutdown.

## Ambient UI and cancellation brake

Render active timers in one stable above-editor widget slot so state refreshes do not reorder unrelated widgets. Put countdown and finite run progress before the timer label so narrow terminals preserve operational state. Refresh the countdown with a small unref'ed UI timer, clip every rendered line to the supplied width, and clear the refresh handle plus widget during session shutdown.

A mnemonic, conflict-checked shortcut should open a selector rather than cancelling immediately. Use the host's native border and selection components, include precise cancel-one and cancel-all choices, and report that an already accepted follow-up cannot be retracted. Keep picker selection separate from state mutation so it is independently testable.

## Overlap policy

Never allow one timer to accumulate overlapping agent turns. Once a wake is accepted, mark that timer pending before injection. Due ticks while pending are coalesced and do not consume the finite run budget. When the host fully settles, clear the pending gate; the next regular tick may deliver again.

If delivery throws synchronously, clear the pending gate, record a bounded failure count, and do not increment the run count. For fire-and-forget delivery APIs, document that synchronous acceptance—not successful model/task completion—is the observable accounting boundary.

## Main-agent-only boundary

Do not rely on prompt prose to keep timer controls away from workers. Worker runtimes must disable host extensions and construct explicit custom-tool allowlists that omit the timer tool. Add regression checks for every worker implementation.

An independent host process may load the extension for its own main agent; “main-only” is scoped to each owning host runtime.

## Bounds and safety

Set conservative limits for active timers, minimum interval, maximum interval, finite runs, instruction size, and label size. Require an explicit user scheduling request because each wake can spend model tokens and execute tools with side effects.

Timer delivery must not bypass the host's active mode, tool restrictions, credential handling, or confirmation gates. A scheduler creates turns; it does not grant capabilities.

## Non-persistence

Process-local timers should disappear on reload, session switch, fork, and exit. Never silently claim durability.

Adding persistence is a separate feature requiring:

- versioned state and ownership;
- restart and clock-change reconciliation;
- missed-run and catch-up policy;
- duplicate suppression and host leasing;
- stale-session protection;
- user-visible inspection, cancellation, and recovery.

## Verification

Use an injected fake scheduler for deterministic unit tests. Cover first-run timing, exact finite completion, overlap coalescing, injection failure, limits, cancellation, and idempotent disposal. Test widget rendering and countdown/picker data as pure functions, including empty state and pending/coalesced indicators. Add a real host-runtime smoke test for tool/command registration and the wake-delivery option shape.
