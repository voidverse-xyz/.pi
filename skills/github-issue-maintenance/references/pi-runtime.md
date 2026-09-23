# Pi adapter for issue maintenance

## Summary

Use ordinary persistent Pi Subagents in a hub-and-spoke topology. This adapter
implements the lifecycle required by [the maintenance workflow](../SKILL.md);
it does not authorize GitHub actions or activate a run by itself.

## Preflight and model configuration

Before claiming new work, verify that the main agent has `subagent_status`,
`subagent_spawn`, `subagent_send`, `subagent_await`, and `subagent_retire`, including
the result fields used below. Verify discovery of the `worker` and `reviewer`
typed definitions and availability of their configured models. Read the active
local definitions rather than assuming global copies win over project overrides.

The repository's `subagents/worker.md` and `subagents/reviewer.md` own the model
selections. Do not duplicate their pins here or silently override them. The main
agent keeps the user's selected model. Missing definitions, model access, or
required APIs are blockers, not grounds to replace the workflow with one-shots.

Use no `issue-maintainer` type, Pi Teams tools, peer mail, or peer roster. Peer
messaging being disabled is irrelevant: only the main agent sends assignments.
Persistent Pi Subagent state belongs to its owning main session; resume preserves
that scope, whereas `/new`, a fork, or another main session does not transfer it.
A mismatch requires explicit migration/recovery acknowledging lost memory.

## Identity and private binding

Preserve this established identity scheme:

1. Lowercase canonical `<owner>/<repo>` and encode its UTF-8 bytes as unpadded
   RFC 4648 Base32. Lowercase the encoding and prefix it with `r-` for `<repo-id>`.
2. Use `<repo-id>-i<issue-number>-e<epoch-index>` as `<issue-team-id>`.
3. Require canonical decimal issue number `1..9999999999` and epoch index
   `0..9999999999`. Reject signs, whitespace, decimals, non-integers, leading
   zeros except epoch `0`, and values outside these ranges.
4. Initial open epoch is `0`; each verified reopen increments the ledger index.
   Never guess the index after history/state loss or reuse a retired ID.

For an ASCII owner of 39 bytes and repository of 100 bytes, the repository ID is
at most 226 characters and the team ID at most 250. Check actual UTF-8 byte lengths;
reject IDs of 255 bytes or more instead of truncating/hashing them silently. This
component bound does not guarantee the entire storage path fits the operating
system/filesystem's limits; verify the installed runtime and storage support it.

The scheme omits the GitHub host. Bindings must include the host, and a matching
coordinate on another host must not adopt the same addresses. Use an explicitly
approved separate owning session or identity migration if such a collision arises.

Persist private host/repository, issue, epoch, team ID, `ownerScopeId`, worker and
reviewer addresses, establishment state, assignment anchors/results, retirement
policy/authorization, and retirement evidence. Do not store these in tracked
project files or publish them in claims/PRs.

## Establish or resume a pair

Only after verified ownership of a durable claim on an open eligible `fix` issue:

1. Recheck issue, epoch, labels, claim, and absence of an addressing PR for new
   work. Existing bound follow-up may continue on its verified published PR.
2. Derive the epoch from the adjudicated lifecycle ledger.
3. Call no-address `subagent_status` and retain `ownerScopeId`, roster, states,
   and open-task anchors. A tool that cannot expose scope identity cannot
   establish continuity for this adapter.
4. Without a completed binding, persist an establishment record and create only
   missing `worker/<issue-team-id>` and `reviewer/<issue-team-id>` instances:
   use named `type`, `id`, `lifetime: persistent`, issue-specific `label`, and no
   initial task. Reuse an existing partial pair only when its identity, scope,
   and provenance are established; otherwise stop for reconciliation.
5. Once both addresses appear, persist the completed binding. Do not send work
   until that write succeeds. A failed write/spawn does not justify blind respawn.
6. With a completed binding, require exact host/repository/issue/epoch/team/scope
   equality and both recorded addresses in the roster. Missing or mismatched
   state means `waiting`, not automatic adoption or recreation.
7. If either specialist is working or has a pending assignment, do not overlap
   work. Await a known anchor belonging to this issue or return `waiting`.

No `/reload` recovery step is required. Never redirect an existing issue pair to
another issue, epoch, repository, or owning session.

## Assignment and completion protocol

Send each implementation, review, repair, and publication assignment separately
with `subagent_send`; record its `envelopeId`. If a permitted creation includes
an initial task, its anchor is the returned `taskEnvelopeId`. Await the exact
`{to, anchorId}` using `subagent_await`, never an inferred session/agent ID alone.

Inspect both the top-level result and every relevant outcome:

- `completed`: validate the final report's decision and evidence, not just delivery;
- `error`: stop and report failure; no publication or success claim;
- `retired`: the persistent specialist disappeared; stop for recovery;
- `timeout`: all listed pending targets remain pending; await later or return
  `waiting`, without cancelling or replacing agents to avoid the wait.

A completed final `waiting`/`blocked` report with a question consumes that anchor.
Answer through a new `subagent_send`, capture its new envelope ID, and await it.
Do not re-await consumed anchors or use the unrelated `waitFor`/`collect` protocol.
Keep the private assignment records current so interrupted passes can reconcile
actual open tasks rather than inventing completion from an idle roster.

## Verified-closure retirement

Execute only under the run's authorized `after-verified-closure` policy or a new
explicit instruction. A copied adapter is not standing authorization.

1. Re-read the issue and paginated lifecycle timeline. Verify the exact close
   ending the bound epoch and any later reopen; ambiguous order means `waiting`.
2. Match host/repository, issue, epoch, team ID, addresses, and `ownerScopeId` to
   the private binding and current main session.
3. Inspect `subagent_status`. Require both specialists dormant with no open,
   queued, running, or waiting assignments, and all recorded assignments terminal.
   Await known active anchors when appropriate; never cancel just to retire.
4. Do not treat timeout, missing addresses, partial evidence, or failed assignment
   outcomes alone as proof that retirement is safe. Resolve task state first.
5. Call `subagent_retire` for each bound address. Persist each successful result.
   If only one succeeds, retain `partial-retirement`, retry only the remaining
   address, and never recreate the retired one. On resume, verify a recorded
   retired address is absent rather than requiring it to be dormant/present.
6. If a retirement result was lost before it could be persisted, reconcile with
   verified runtime retirement evidence or stop; absence alone is not proof.
7. Require both successful retirements and roster absence before marking the
   binding retired. Persist close/reopen delimiters, scope, pair identity, and
   both results privately. Until then, do not create a next-epoch pair.
8. For an already reopened issue, use the ledger's next epoch only after complete
   old-pair retirement, verify/acquire its new claim, and create fresh addresses.

Retirement archives agent state; it does not authorize deleting worktrees,
branches, the private ledger, or any user files.
