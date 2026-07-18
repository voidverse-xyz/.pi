# Subagent await report coalescing

## Symptom

A delegated subagent could send a non-final checkpoint such as “Starting review,” then a final report. When the main agent joined the task with `subagent_await`, await consumed only the final envelope. The earlier checkpoint stayed unread in the main mailbox, so the idle wake pump delivered it on a later turn boundary after the final result had already been handled.

## Root cause

Progress reports were not correlated to their active task anchor. `awaitResults()` could therefore match and consume the final report but could not identify earlier reports that the terminal outcome superseded.

## Fix

- Every report emitted during a task turn now carries the current assignment correlation, not only the final report.
- When await consumes a final report or task-scoped fatal error, it also marks non-final reports from the same assignment done.
- Older uncorrelated reports are deliberately left untouched because they cannot be attributed to an assignment safely.
- Subagent identity guidance now forbids reports that merely announce starting or restate the assignment. Progress reports are reserved for actionable milestones and blockers.

Idle auto-wake behavior is unchanged when the main agent does not explicitly await: pending progress can still wake an idle host normally.

## Verification

The Phase 4 await harness covers:

1. Correlated progress followed by final: await returns the final and leaves no wake digest.
2. Correlated progress followed by a task-scoped fatal error: stale progress is consumed with the error.
3. Held future work remains isolated and resolves from its own later final report.

The Phase 2 harness verifies the no-starting-report identity guidance.
