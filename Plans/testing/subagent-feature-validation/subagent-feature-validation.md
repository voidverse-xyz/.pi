# Subagent feature validation checklist

Reusable checklist for validating an agent system that delegates work to background workers, subagents, reviewers, or teams.

## Preparation

- Use an isolated test project or fixture.
- Record the main session id, worker ids, and task/request anchors.
- Prefer bounded one-shot workers for destructive or failure-mode tests.
- Define the expected report format before spawning workers.

## Ordered checks

1. **Surface registration** — commands, tools, settings, and UI/status surfaces load without extension errors.
2. **Spawn basics** — typed and ad-hoc worker creation succeeds, rejects invalid ids/options, and reports a durable task anchor when given an initial task.
3. **Tool policy** — worker tools match the requested sandbox; disallowed tools are absent or blocked.
4. **Initial task execution** — a newly spawned worker with an initial task starts exactly once and produces a correlated report.
5. **Send/follow-up** — follow-up messages target the intended worker and preserve ordering.
6. **Await/join** — waiting on a final or collect anchor returns the expected report before the orchestrator claims completion.
7. **Attention paths** — worker questions, escalations, and errors return early and can be resolved without losing the original await anchor.
8. **Concurrency** — parallel workers respect configured caps and do not duplicate queue delivery.
9. **Session lifecycle** — reload/resume preserve scope; new/fork/clone do not inherit workers unless explicitly adopted.
10. **Cancellation/retirement** — stop, cancel, and retire operations are idempotent and do not create stale self-bounces.
11. **UI/status** — running, completed, errored, and retired states render accurately and compactly.
12. **Persistence/crash recovery** — claimed-but-undelivered results requeue or finalize consistently after restart.
13. **Safety gates** — sandbox confirmations, read-only modes, and destructive-operation blocks apply to worker tool calls.
14. **Cleanup** — archives, logs, temporary files, and worker scopes are cleaned according to retention policy.

## Result format

For each check, record:

- verdict: pass, fail, blocked, or not applicable;
- evidence: command/tool ids, anchors, and relevant file paths;
- defect: concise user-visible symptom;
- expected fix or follow-up test.
