# Global cancellation command pattern

Reusable plan template for adding one user-visible stop/kill command across multiple agent subsystems, queues, workers, and background model calls.

## Goal

A single command should synchronously prevent new work, stop owned in-flight work, drain or mark queues, and report what was stopped without allowing automatic restarts from stale wakeups.

## Design checklist

1. **Coordinator package**
   - Own the command and a process-local cancellation generation number.
   - Provide a small registration API for participants.
   - Expose `isCancelled(generation)` or equivalent for long-running loops.

2. **Participant contract**
   - Each subsystem registers an id, display label, and `cancel(reason, generation)` handler.
   - Handlers must be idempotent and bounded by timeout.
   - Handlers return counts for stopped runs, cleared queues, skipped wakeups, and errors.

3. **Stop ordering**
   - Increment generation first so new scheduling sees cancellation immediately.
   - Stop the main run or dispatcher intake.
   - Disable auto-wake/resume pumps for the generation.
   - Cancel workers, teams, procedure agents, queued tasks, and package-owned child model calls.
   - Drain or mark queues after producers are stopped.

4. **Restart prevention**
   - Attach generation ids to queued work and wake requests.
   - Drop or hold stale-generation work after cancellation.
   - Require an explicit new user action to restart work.

5. **User feedback**
   - Show one concise summary with stopped counts and any participants that failed or timed out.
   - Treat partial cancellation as a warning, not a silent success.

## Verification checklist

- Command works while idle and while busy.
- New work submitted during cancellation is rejected or held.
- Workers and child model calls observe cancellation.
- Queues do not auto-restart after cancellation.
- Re-running the command is safe.
- Participant timeouts are reported.
- A fresh user action after cancellation can start work normally.
