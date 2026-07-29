# Pi Subagent session ownership and reliable result delivery

Reusable architecture pattern for a disk-backed Pi Subagents extension.

## Goal

Isolate worker identities and mail by owning main Pi session while retaining project-scoped type definitions and provide a durable await path so required delegated results reach the orchestrator before it answers.

## Scope model

- Project scope: canonical cwd, type definitions, settings, trust, and project context.
- Main-session scope: registry, agents, mailboxes, open-task anchors, archives, and autonomy state.
- Key the scope by the stable owning main session ID.
- Expose only a stable opaque fingerprint such as `ownerScopeId` to the LLM-facing status tool.
- Reload/resume reuses a scope; `/new` and fork create empty independent scopes.
- Use a host-scope lease so two processes cannot actively own the same main session.
- When workflow correctness depends on persistent memory, bind the fingerprint and refuse silent adoption from another scope.

## Durable mailbox rule

Claim envelopes before rendering them:

1. Lock the mailbox.
2. Move eligible envelopes into a delivery area with durable metadata.
3. Render the digest or tool result from the claim.
4. Finalize only after the host session records accepted delivery.
5. Requeue after a crash before the durable append.

Use the same durability rule for normal digests and explicit await results.

## Await pattern

Expose task/send envelope IDs as anchors.

```text
subagent_await(targets?: [{to, anchorId}], mode?: "all"|"any", timeoutSeconds?)
```

- Omitted targets snapshot all currently open assignments.
- Top-level status is `completed`, `timeout`, or `empty`.
- Per-target entries in `outcomes` are `completed`, `error`, or `retired`.
- A timeout leaves unresolved targets in `pending` and consumes no pending result.
- A final waiting/blocked question consumes its old anchor. Answer with a new send and await the new envelope ID.
- Park a completed result until its tool-result append is durable.
- Bound report text and LLM-facing result size.

## Retirement pattern

- Cancel or audit pending messages from the owning main without presenting them as successful work.
- Resolve open-task anchors with a terminal retired outcome.
- One-shot agents auto-retire only after final-report delivery.
- Never silently replace a missing persistent agent when memory continuity matters.

## Delegated review procedure

1. Use one narrowly scoped reviewer unless independent purviews justify more.
2. Capture the assignment anchor.
3. Await the exact `{to, anchorId}` target.
4. Accept findings only from a `completed` outcome containing the final report.
5. Treat timeout as pending and `error`/`retired` as incomplete.
6. Answer a waiting/blocked question with a new send and await its new anchor.
7. Present verdict and findings before orchestration details.

## Required verification

Cover two sessions in one cwd, duplicate opening of one scope, resume/new/fork, stable and distinct scope fingerprints, crash-before-append, await before/after report, stale-anchor exclusion, timeout/cancel, error, retirement, multiple targets, quiet one-shot cleanup, and end-to-end delegated review.
