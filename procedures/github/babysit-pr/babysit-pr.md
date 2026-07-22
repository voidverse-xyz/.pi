# Keep a pull request merge-ready

Use this procedure when the user asks to monitor or “babysit” a GitHub pull request until it is ready for human merge.

This procedure may inspect remote state, modify code, commit, push, reply to reviews, resolve threads and rerun checks. Treat those as separate capabilities: the user's request to monitor a PR authorizes the necessary read-only GitHub queries, but does not silently authorize commits, pushes, public comments, thread resolution or merging.

## 1. Establish target, authorization and bounds

Confirm or infer from an explicit PR URL/number:

- Repository and PR.
- Expected base and head branches.
- Whether local fixes are allowed.
- Whether commits and pushes are allowed.
- Whether public replies/thread resolution are allowed.
- Polling interval, maximum duration or maximum passes.
- Conditions requiring immediate escalation.

Never auto-merge. Never enable auto-merge unless the user explicitly requests it.

For an open-ended request with no bounds, default to **one complete pass**, report what remains, and ask before starting a continuing polling loop.

## 2. Read the minimum structured state

Use `gh` with explicit repository targeting and structured fields. Resolve the PR first:

```bash
gh pr view <pr> --repo <owner/repo> \
  --json number,url,title,state,isDraft,baseRefName,headRefName,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
```

Use `--jq` to select only fields needed for the current decision. Do not scrape formatted terminal tables.

Read unresolved review threads through `gh api graphql` because issue-level PR comments do not represent review-thread resolution. Request only:

- `isResolved`, `isOutdated`, path and line.
- Minimal comment author/body/URL needed to assess the request.
- Page info for pagination.

Paginate when `hasNextPage` is true. Ignore resolved threads by default. Treat outdated-but-unresolved threads as requiring assessment, not automatic dismissal.

Read check state with `gh pr checks` or `statusCheckRollup`; inspect a failed run's minimal logs with `gh run view --log-failed` only when needed.

Apply the shared privacy rules to every remote query and response. Do not upload local logs, files or patches to third-party services unless specifically authorized.

## 3. Classify the current blockers

Produce four buckets:

1. **Merge state:** clean, behind, conflicts, unknown, or blocked by policy.
2. **Review threads:** valid change request, already addressed, incorrect, ambiguous, or out of scope.
3. **Checks:** passing, pending, cancelled, infrastructure failure, pre-existing failure, or regression caused by this PR.
4. **Human gates:** missing approval, requested changes, draft status, required maintainer action, or external dependency.

Validate automated/bot findings against the code before accepting them. Do not change code merely because a bot used high severity.

## 4. Handle merge conflicts safely

Read project policy to determine whether the branch should merge the base, rebase, or wait. Do not choose a history-rewriting strategy from preference.

Before changing local Git state:

- Verify the correct PR head branch/worktree.
- Check for uncommitted/untracked work.
- Fetch only when remote access is authorized.
- Establish a recovery point.

Resolve mechanical conflicts only when both sides' intent is clear and tests can verify the result. If intents conflict, abort the operation cleanly and ask the user.

Do not force-push a rebased branch without explicit authorization that names the affected branch and remote.

## 5. Triage review comments

For every active thread:

- Locate the current code and verify whether the comment still applies.
- Identify the underlying requirement, not just the proposed patch.
- Classify severity and scope.
- Decide: fix, explain disagreement, ask for clarification, defer as follow-up, or mark already addressed.

When fixes are authorized, keep them narrowly tied to the PR. Do not opportunistically refactor adjacent code.

Public replies must be reviewed for private/local details. Use concise evidence: what changed, where, and why. Do not mention hidden files, home paths, agent sessions, unrelated projects or internal runtime details.

Do not resolve a review thread until the code/reply actually addresses it and public interaction is authorized.

## 6. Diagnose CI without weakening it

For each failing required check:

1. Determine whether it ran on the current head SHA.
2. Read only the relevant failed step/log region.
3. Reproduce locally in the project's documented environment when practical.
4. Classify PR regression vs flaky infrastructure vs pre-existing/base failure.
5. Fix only regressions within PR scope.
6. Run the smallest authoritative local verification, then the broader required suite when warranted.

Never disable, skip or relax a check merely to turn it green. Do not edit CI procedures unless the procedure itself is within the approved PR scope and the change corrects a real defect.

For likely flaky/infrastructure failures, rerun only when permitted and record why. Stop repeated reruns when they provide no new evidence.

## 7. Commit and push only within authorization

Before each commit:

- Show the intended files/hunks.
- Review staged diff and tests.
- Run the privacy leak pass over content and commit metadata.
- Keep the commit scoped to one resolved blocker.

Before each push, verify the exact outgoing commits and remote destination. A general monitoring request is not permission to force-push.

After a push, wait for checks/reviews on the new head SHA; ignore stale results from prior SHAs.

## 8. Poll with limits

A continuing loop must have explicit bounds. Recommended defaults when the user asks for ongoing monitoring:

- Poll no more often than every few minutes unless the provider sends events.
- Stop at the agreed deadline/pass count.
- Back off on rate-limit or service errors.
- Stop after repeated identical state with no actionable progress.
- Stop when user clarification, external maintainer action or unavailable credentials are required.
- Stop on cancellation and clean up timers/processes.

Do not claim active monitoring after the process/session has ended.

## 9. Merge-ready definition

Report “merge-ready” only when all applicable conditions are true:

- PR is open and not draft.
- Merge state is clean against the intended base.
- Required checks pass on the current head SHA.
- Required approvals are present and no blocking review decision remains.
- Valid unresolved review threads are addressed.
- No known scoped regression remains.
- Repository policy requirements are satisfied.

Merge-ready does not mean merged. Leave the final merge to the user unless they explicitly request it.

## Pass report

```markdown
## PR status
- PR: <url>
- Head: <sha>
- Merge state: <state>
- Review decision: <state>
- Required checks: <passing/pending/failing>

## Actions completed
- <local or remote action>

## Remaining blockers
- <owner/action/evidence>

## Waiting on
- CI | reviewer | user decision | external service | nothing

## Next check
- <time/pass or stopped reason>
```

Keep remote/public actions separate from private diagnostic details.

## Stop immediately when

- The target PR/repository is ambiguous.
- Required remote authorization is missing.
- Local work would be overwritten.
- Conflict intent is unclear.
- A fix requires unrelated product or CI changes.
- A public response could expose private information.
- A force-push/history rewrite appears necessary but is not explicitly approved.
- Repeated polling or reruns make no progress.
- The PR is closed, merged, superseded, or blocked on human policy.
