# Pi subagent session ownership and reliable result delivery

Reusable architecture pattern for a disk-backed Pi subagent extension.

## Goal

Isolate worker identities and mail by owning main Pi session while retaining project-scoped type definitions/settings, and provide a durable await/join path so delegated results reach the orchestrator before it answers the user.

## Recommended model

- Project scope: canonical cwd, type definitions, settings, trust, project context.
- Main-session scope: registry, workers, teams, mailboxes, escalations, autonomy state, archives.
- Key session scope by `ctx.sessionManager.getSessionId()`.
- Reload/resume reuse a scope; new/fork create an empty scope.
- Reject persistent workers in non-persisted host sessions; use a temporary oneshot-only scope.
- Use a host-scope lease so two processes cannot actively own the same main session.

## Durable mailbox rule

Claim envelopes before rendering them:

1. Lock the mailbox.
2. Move eligible envelopes into a delivery directory with target session and delivery-marker metadata.
3. Render the digest/tool result from the claim.
4. Finalize only after the host JSONL contains both envelope ID and marker.
5. Requeue on crash-before-append.

Use the same protocol for normal digests and awaited tool results.

## Await tool pattern

Expose task/send/collect envelope IDs as anchors. Persist `final:true` on report envelopes.

```text
subagent_await(to, waitFor: "final"|"collect", anchorId, timeoutSeconds?)
```

- Final mode matches a final report automatically correlated to the task/send anchor.
- Collect mode matches a report correlated to the collect request.
- Return early for question/escalation/error so waiting cannot deadlock.
- Timeout/cancellation consumes nothing.
- Park a completed result until its tool-result append is durable.
- Bound report text/data and the LLM-facing result.

## Retirement pattern

- Cancel/audit pending messages from the owning main without bouncing them back to that same main.
- Bounce peer questions/messages so peers are not stranded.
- Resolve pending escalation records and suppress obsolete approval mail.
- Never silently discard peer mail.

## Legacy migration

Do not auto-assign cwd-wide state. Provide a human-only adoption command:

- destination must be empty;
- no live owner/run marker may exist;
- write an intent ledger;
- preserve an inactive backup;
- copy into staging and verify;
- atomically activate one owner scope;
- rollback only before the new scope diverges.

## Delegated review workflow

1. Use a narrowly scoped, bounded oneshot.
2. Capture the task anchor.
3. Await its final report.
4. Handle attention and await again.
5. Do not declare completion on timeout/cancellation.
6. Let final-report auto-retirement run normally.
7. Present verdict/findings first; operational caveats last.

## Required verification

Cover two sessions in one cwd, duplicate opening of one session, resume/new/fork, crash-before-append, await before/after report, stale anchor exclusion, attention return, timeout/cancel, collect validation, quiet main cancellation, peer bounce, obsolete escalation cleanup, ephemeral cleanup, migration interruption, and end-to-end dogfooding.
