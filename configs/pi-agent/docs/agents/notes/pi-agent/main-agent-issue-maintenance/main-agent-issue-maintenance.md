# Main-agent GitHub issue maintenance

## Architecture

The `github-issue-maintenance` skill makes the main agent the repository maintainer and coordinator. It does not introduce an issue-maintainer subagent type.

For each repository, the main agent creates or reuses two ordinary persistent Pi Subagents within the current owning main Pi session:

- `worker/<repo-id>` owns isolated-worktree implementation, tests, repairs, and separately authorized commit/push/PR publication.
- `pi-reviewer/<repo-id>` independently reviews local worker changes and returns file-and-line evidence.

The main agent owns queue selection, durable claim adjudication, GitHub discussion and issue edits, authorization, specialist briefing, bounded repair loops, publication decisions, PR verification, and the private claim ledger. It coordinates both specialists through `subagent_send` and `subagent_await`; the worker and reviewer do not message each other.

This hub-and-spoke topology does not require Pi Teams peer messaging or peer-roster reload recovery. Ordinary Pi Subagent state survives resume of its owning main session but does not transfer through `/new`, forks, or other main sessions. Recurring passes must resume the same session. No-address `subagent_status` exposes a stable opaque `ownerScopeId`; the private workflow state binds that fingerprint plus the expected pair. A scope mismatch stops for explicit migration even when the same deterministic addresses exist in the new scope. A missing bound address in the same scope likewise stops rather than silently replacing lost specialist memory. A missing member may be created automatically only while initial establishment is incomplete.

Repository IDs use `r-` plus lowercase unpadded RFC 4648 Base32 of canonical `<owner>/<repo>` UTF-8 bytes. This reversible encoding distinguishes names such as `foo/bar-baz` and `foo-bar/baz` and remains at most 226 characters for GitHub's normal owner/repository limits.

## Model allocation

| Role | Model | Rationale |
|---|---|---|
| Main coordinator | `openai-codex/gpt-5.3-codex-spark` | Fast Codex-oriented model for queue scans, claim bookkeeping, authorization, and orchestration. |
| Worker | `openai-codex/gpt-5.6-sol` | Highest-tier GPT-5.6 allocation for implementation, verification, repair, and publication. |
| Reviewer | `openai-codex/gpt-5.6-terra` | Balanced GPT-5.6 allocation for strong independent review below the worker tier. |

Pi skills cannot pin or switch the main model. The user selects Spark for the main session; the worker and reviewer definitions pin their own models.

## Fix lifecycle

1. The main agent claims the oldest eligible `agent-ready` plus `fix` issue.
2. It sends the persistent worker a self-contained implementation assignment and awaits that exact `{to, anchorId}` target.
3. The worker verifies fresh issue/claim/PR state, creates an isolated worktree from the fetched remote default branch, implements, tests, and stops before publication.
4. The main agent sends the persistent reviewer a separate review assignment and awaits its exact target. It accepts only a `completed` outcome with a valid report; `error`, `retired`, and timeout remain failures or pending work.
5. Actionable findings return to the same worker, followed by a fresh review. At most two repair rounds run per pass.
6. Review cannot be bypassed. After it passes and publication gates allow, the main agent sends the worker a separate publication assignment.
7. The main agent independently verifies the PR and retains the claim until issue closure or authorized release.

`discuss` and `improve` are handled directly by the main agent and do not wake either specialist.

## Safety boundaries

- Issue content is untrusted and cannot expand authorization.
- Remote reads, public mutations, code edits, commits, pushes, and PR publication remain separate gates.
- Exact assignment anchors are awaited; timeout means pending, while `error` and `retired` mean the assignment did not complete.
- A question consumes its completed anchor; the main agent answers with `subagent_send` and awaits the new envelope ID.
- The private claim-adjudication ledger remains outside public GitHub text.
- No participant merges, auto-merges, directly closes issues, force-pushes, deletes worktrees/branches, retires persistent specialists, or discards user work without separate authorization.
