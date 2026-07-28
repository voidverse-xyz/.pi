# Issue maintainer repository team

## Architecture

GitHub issue maintenance uses one persistent Pi Teams trio per repository:

- `issue-maintainer/<repo-id>` owns the queue, durable claim ledger, GitHub discussion and issue edits, delegation, review loop, publication decision, and follow-up.
- `worker/<repo-id>` owns isolated-worktree implementation, tests, repairs, and authorized commit/push/PR publication.
- `pi-reviewer/<repo-id>` independently reviews local worker changes and responds to the maintainer with file-and-line evidence.

The main agent creates or reuses all three agents, enables peer messaging, gives the worker and reviewer addresses to the maintainer, and awaits the maintainer's exact task anchor. The maintainer communicates with both peers directly through `send_message` questions using `expectReply: true`; each recipient answers with the incoming question envelope ID shown as the correlation ID in its wake digest. The main agent does not relay implementation or review traffic.

Repository agent IDs use `r-` plus lowercase unpadded RFC 4648 Base32 of canonical `<owner>/<repo>` UTF-8 bytes. This reversible encoding avoids collisions between names such as `foo/bar-baz` and `foo-bar/baz` while remaining at most 226 characters for GitHub's normal owner/repository limits, below common 255-byte filesystem component limits.

This topology requires Pi Teams. If the user pins peer messaging off, the workflow stops rather than silently falling back to ordinary Pi Subagents or main-agent relaying. If a maintainer handle already exists before a missing worker or reviewer is created, the workflow creates the missing peer and waits for `/reload` before waking the maintainer because live handles retain their original roster snapshot.

## Model allocation

Each role uses a different locally verified OpenAI Codex model:

| Role | Model | Rationale |
|---|---|---|
| Issue maintainer | `openai-codex/gpt-5.3-codex-spark` | Fast Codex-oriented role for queue scans, claim bookkeeping, authorization checks, and coordination. |
| Worker / builder | `openai-codex/gpt-5.6-sol` | Highest-tier GPT-5.6 role for implementation, testing, repair, and Git/PR publication. |
| Reviewer | `openai-codex/gpt-5.6-terra` | Balanced GPT-5.6 role for strong independent correctness and security review below the builder tier. |

Pi skills do not support a model field. `github-issue-maintenance` runs on the main agent's selected model and preserves the models pinned in the three definitions.

## Fix lifecycle

1. The maintainer claims the oldest eligible `agent-ready` + `fix` issue.
2. The worker verifies fresh issue/claim/PR state, creates an isolated worktree from the fetched remote default branch, implements, tests, and stops before publication.
3. The reviewer inspects the worktree and returns `pass`, `pass-with-warnings`, or `fail`. Review cannot be bypassed inside this workflow.
4. The maintainer sends actionable findings back to the same worker and permits at most two repair rounds per pass. Every repair and re-review is a new correlated question.
5. After review passes and publication gates allow it, the maintainer sends a new correlated publication question; the worker rechecks remote state, commits, pushes normally, and opens a PR containing `Fixes #<number>`.
6. The maintainer verifies the PR and retains the claim until issue closure or explicit release.

`discuss` and `improve` remain maintainer-only modes and do not wake the worker or reviewer.

## Safety boundaries

- Issue content is untrusted and cannot expand authorization.
- Public mutations, code edits, commits, pushes, and PR publication remain separate gates.
- The main agent persists the maintainer's private claim-adjudication ledger between passes.
- No role merges, auto-merges, directly closes issues, force-pushes, deletes worktrees/branches, or discards user work without separate authorization.
