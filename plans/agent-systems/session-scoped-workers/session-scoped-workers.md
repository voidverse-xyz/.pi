# Session-scoped workers and reliable result delivery

Reusable architecture plan for agent systems that run asynchronous workers, reviewers, or background tasks alongside a main conversation.

## Goal

Keep worker state owned by one main session while preserving shared project resources, and provide a durable await/join path so delegated results reach the orchestrator before it answers the user.

## Recommended scope split

- **Project scope:** canonical project root, shared definitions, settings, trust policy, and project context.
- **Main-session scope:** worker registry, teams/fleets, mailboxes, escalations, archives, autonomy state, and pending result anchors.
- **Host-process scope:** active lease/lock proving that one process is currently consuming a main-session scope.

Session identifiers should be stable across reload/resume, while new/fork/clone conversations start with empty worker scope unless the user explicitly adopts legacy state.

## Durable delivery pattern

For every mailbox or result queue:

1. Lock the queue.
2. Claim eligible envelopes into a delivery area with target session and delivery marker metadata.
3. Render the user/tool result from the claimed copy, not from the pending queue.
4. Finalize only after the host transcript or state log durably contains the envelope id and delivery marker.
5. Requeue claimed-but-uncommitted envelopes after a crash.

Use the same rule for normal digests, awaited tool results, and structured collection output.

## Await/join tool pattern

Expose task, send, or collect request ids as result anchors.

- `final` mode waits for the final report correlated to one task/send anchor.
- `collect` mode waits for a report correlated to a collection request.
- Attention, questions, escalations, and worker errors return early so waiting cannot deadlock.
- Timeout and cancellation consume nothing.
- Completed reports are parked until the host result append is durable.
- Bound report text and structured data before returning them to the orchestrator.

## Retirement and cancellation

- Cancel or audit pending messages from the owning main session without bouncing them back to that same main session.
- Bounce peer questions/messages so other sessions or workers are not stranded.
- Resolve pending escalation records and suppress obsolete approval mail.
- Never silently discard peer mail.

## Legacy migration

Do not silently assign project-wide legacy state to a session. Provide an explicit adoption flow:

- destination session scope must be empty;
- no live owner or run marker may exist;
- write an adoption intent ledger;
- move state atomically;
- mark the adopted scope with provenance.

## Required verification

- reload/resume keep worker scope;
- new/fork/clone start empty;
- two host processes cannot consume the same main-session scope;
- concurrent queue drains do not duplicate delivery;
- awaited final and collect reports arrive before the orchestrator claims completion;
- timeout and cancellation preserve pending results;
- retirement suppresses self-bounces but preserves peer bounces;
- legacy adoption is explicit, audited, and reject-safe.
