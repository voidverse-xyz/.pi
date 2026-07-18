# Session-scoped subagents implementation

Implemented: 2026-07-13
Plan: `Configs/PiAgent/docs/agents/plans/architecture/session-scoped-subagents-and-reliable-results/session-scoped-subagents-and-reliable-results.md`

## Delivered

- Mutable state is keyed by stable main Pi session ID beneath a versioned project container; type libraries, settings, trust, cwd, and project context remain shared.
- Reload/resume restore the same scope; new/fork start empty; fork visibly discloses that workers were not inherited.
- Persisted autonomy counters and abort latch are owner-local. Non-persisted sessions use temporary state and reject persistent workers.
- Host ownership uses exclusive creation, PID process-start identity, heartbeat, and generation-specific append-only stale-reclaim fencing. A real two-process regression proves only one stale takeover succeeds.
- Main digest and await delivery use atomic claim-first mailbox parking plus host-JSONL reconciliation.
- `subagent_spawn`/`subagent_send` expose anchors; reports persist `final`; task reports are runtime-correlated to the assignment that triggered the current turn.
- New `subagent_await` joins final or collect results, returns early for questions/escalations/errors, and consumes nothing on timeout/cancellation.
- Oneshot/manual retirement intent is durable and startup-recoverable. Owner mail is quietly audited, peer bounces are idempotent, and obsolete escalation mail is removed.
- `/agents adopt-legacy` performs verified, backup-retaining explicit adoption; startup recovers interrupted copies. `/agents rollback-legacy` works only while the scoped fingerprint is unchanged.
- Pi's whole project-session directory, including inactive adoption backups, is a non-overridable sandbox denial.
- Shared delegated-review workflow and bounded valid reviewer/scout definitions were added.

## Verification

`Configs/PiAgent/packages/pi-agents/test/e2e/run.sh` passes:

- strict TypeScript typecheck;
- phase 1–7 harnesses;
- lifecycle/runtime regression harnesses;
- new session-scope/await/migration/concurrency harness;
- Pi extension loader with eight tools.

The new harness covers scope isolation, duplicate host ownership, PID reuse, real two-process stale takeover, resume persistence, overlapping task correlation, await attention/timeout/cancel/durability, quiet retirement, idempotent crash recovery, oneshot intent recovery, and ephemeral lifetime restrictions.

## Independent review

A read-only reviewer initially found host-reclaim races, overlapping-result miscorrelation, retirement crash gaps, interrupted migration gaps, backup sandbox exposure, and invalid shared type frontmatter. Each finding was fixed and regression-tested. Targeted follow-up reviews continued until the final structured verdict was `pass` with no remaining findings.

## Activation and migration

Run `/reload` or restart Pi to activate the new extension code. Existing cwd-wide state is intentionally not opened automatically. In the persisted session that should own it, close other Pi processes in the project and run `/agents adopt-legacy`.
