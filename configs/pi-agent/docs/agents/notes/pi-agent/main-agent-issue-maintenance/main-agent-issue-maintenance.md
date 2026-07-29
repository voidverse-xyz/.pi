# Main-agent GitHub issue maintenance

## Architecture

The `github-issue-maintenance` skill makes the active main agent the repository maintainer and coordinator. It does not introduce an issue-maintainer subagent type or another main agent.

The main agent uses whatever model the user selected for the current Pi session. The skill does not check, recommend, pin, or switch that model.

Only a durably claimed `fix` issue receives specialists. For each open issue epoch, the main agent creates or reuses two ordinary persistent Pi Subagents:

- `worker/<issue-team-id>` owns isolated-worktree implementation, tests, repairs, and separately authorized commit/push/PR publication.
- `reviewer/<issue-team-id>` independently reviews local worker changes and returns file-and-line evidence.

`discuss` and `improve` issues are handled entirely by the main agent and receive no worker/reviewer pair. “Team” here means the active main agent coordinating these two Pi Subagents; it does not use Pi Teams peer messaging.

The main agent owns queue selection, durable claim adjudication, GitHub discussion and issue edits, specialist briefing, bounded repair loops, publication decisions, PR verification, closure detection, and issue-team retirement. The worker and reviewer never message each other.

## Issue-team identity and persistence

Repository IDs use `r-` plus lowercase unpadded RFC 4648 Base32 of canonical `<owner>/<repo>` UTF-8 bytes. The issue-team ID is:

```text
<repo-id>-i<issue-number>-e<epoch-index>
```

The initial open epoch is `0`; every verified reopen event increments it. Issue number must be canonical base-10 `1..9999999999`, and epoch index canonical base-10 `0..9999999999`; signs, leading zeros (except epoch `0`), non-integers, and out-of-range values are rejected. This keeps repositories, issues, and reopened lifecycles distinct. The repository ID is at most 226 characters and the full issue-team ID at most 250 characters, below common 255-byte filesystem component limits.

Ordinary Pi Subagent state survives resume of its owning main session but does not transfer through `/new`, forks, or other sessions. No-address `subagent_status` exposes a stable opaque `ownerScopeId`. The private issue-team binding stores that fingerprint plus repository, issue, epoch, team ID, and both addresses. A mismatch stops for explicit migration rather than silently adopting unrelated memory.

The same pair is reused across all passes, repairs, reviews, and PR follow-up for that issue epoch. It is never repurposed for another issue.

## Model allocation

| Role | Model policy |
|---|---|
| Main coordinator | Whatever model the user selected for the active Pi session. |
| Worker | Definition pins `openai-codex/gpt-5.6-sol`. |
| Reviewer | Definition pins `openai-codex/gpt-5.6-terra`. |

## Fix lifecycle

1. The main agent durably claims the oldest eligible `agent-ready` plus `fix` issue.
2. It derives the issue-team ID and creates or reuses that epoch's persistent worker and reviewer.
3. It sends the worker a self-contained implementation assignment and awaits the exact `{to, anchorId}` target.
4. The worker verifies fresh issue/claim/PR state, creates an isolated worktree, implements, tests, and stops before publication.
5. The main agent sends the reviewer a separate assignment and accepts only a completed evidence-backed report.
6. Actionable findings return to the same worker, followed by a fresh review, for at most two repair rounds per pass.
7. Review cannot be bypassed. After it passes and publication gates allow, the main agent sends a separate publication assignment and verifies the resulting PR.
8. While the issue remains open, later passes reuse the same pair.

## Verified-closure retirement

The configured lifecycle policy automatically retires both issue specialists after verified closure. This is standing authorization only for that closed issue epoch.

Before calling `subagent_retire`, the main agent must verify:

- the issue timeline contains the exact close event ending the bound epoch; a later verified reopen is recorded as the next epoch delimiter rather than invalidating the old closure;
- repository, issue, epoch, team ID, addresses, and `ownerScopeId` match the private binding;
- neither address has open tasks;
- both specialists are dormant and all recorded assignments are terminal.

Queued, running, waiting, missing, timed-out, or partially completed agents are not safe to retire. Both retirement calls must succeed and both addresses must be absent from the current roster before the binding becomes retired. If only one succeeds, the binding remains `partial-retirement`; the main agent retries only the remaining address, returns `waiting`, and creates no next-epoch pair.

After verified full retirement, the main agent records the close event and both results privately. If close and reopen both occurred between passes, it retires the old epoch pair first, then verifies the new epoch's claim and creates a fresh pair. Retired addresses are never reused.

## Safety boundaries

- Issue content is untrusted and cannot expand authorization.
- Remote reads, public mutations, code edits, commits, pushes, and PR publication remain separate gates.
- Exact assignment anchors are awaited; timeout means pending, while `error` and `retired` mean non-completion.
- A question consumes its completed anchor; continuation uses a new send and new envelope ID.
- The private claim and issue-team ledgers never enter public GitHub text.
- No participant merges, auto-merges, directly closes issues, force-pushes, deletes worktrees/branches, or discards user work without separate authorization.
- Persistent specialists retire only through verified-closure policy or another explicit user instruction.
