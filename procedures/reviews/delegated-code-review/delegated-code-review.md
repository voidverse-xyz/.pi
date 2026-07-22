# Delegated code review

Use this procedure to obtain independent, evidence-based review from one or more read-only subagents without modifying the code under review.

## 1. Define the review target

Determine:

- Repository/worktree and exact scope.
- Branch changes, uncommitted changes, staged changes, named files, commit range, or PR head.
- Correct base/merge-base when reviewing branch changes.
- Review dimensions: correctness, security, tests, performance, accessibility, migration safety, or a bounded subset.
- Whether independent review is required before the parent can finish.

Do not switch branches, stash work or mutate the checkout merely to make it reviewable. Prefer reviewing the current checkout, reading explicit refs, or using an isolated worktree. Any state-changing Git operation requires user approval.

If there is no diff or target content, report that plainly instead of spawning reviewers.

## 2. Choose bounded reviewer purviews

Use one general reviewer for ordinary changes. Add specialists only when the diff warrants an independent perspective, for example:

- Security/authentication/authorization.
- Data migration and rollback.
- Concurrency/state lifecycle.
- UI accessibility.
- Test strategy.

Give each reviewer a non-overlapping purview where possible. More reviewers do not automatically improve review; duplicated broad prompts increase cost and produce correlated noise.

Every reviewer should be read-only with the minimum read/search/diff tools. Do not give write, push, network or unrestricted shell access just because the main agent has it.

## 3. Send a self-contained brief

A reviewer cannot be assumed to see the parent conversation. Include:

```text
Goal: <what changed and intended behavior>
Repository/worktree: <target available to the child>
Review scope: <diff/files/range>
Base: <when relevant>
Purview: <correctness/security/etc.>
Constraints/non-goals: <important boundaries>
Known risks: <optional verified context>
Result contract: <required format below>
```

Do not overload the brief with the parent's conclusions. Independent reviewers should inspect evidence themselves.

### Required result contract

```markdown
## Verdict
pass | pass-with-warnings | fail | incomplete

## Findings
- Severity: critical | high | medium | low
- Location: `path:line`
- Finding: concise defect statement
- Evidence: why this is reachable/incorrect
- Fix: smallest viable correction

## Files reviewed
- `path` (line ranges)

## Gaps
- Anything not verified and why
```

Require findings to identify observable impact, not only style preference. Ask reviewers to return verdict/highest severity first and stay within a clear word limit.

## 4. Launch and anchor results

Spawn independent reviewers in parallel when their purviews do not depend on each other. Capture each task or collect request ID.

For asynchronous agents:

1. Keep working only on tasks that do not prejudice the review.
2. Await the exact task/request anchor before claiming review is complete.
3. If a question, escalation or error returns early, handle it and await the same required result again.
4. Treat timeout as still pending, not success.
5. Treat cancellation as incomplete independent review.

Follow the shared `delegated-review-results` protocol. Let normal final-report lifecycle cleanup run; do not interrupt/finalize/retire in rapid succession.

## 5. Handle failures without retry loops

Retry once only when the invocation itself was malformed or a clearly transient reviewer startup failure occurred. Correct the specific issue first.

Do not repeatedly retry:

- The same deterministic tool/permission failure.
- A reviewer that cannot access the target.
- A budget/time ceiling.
- A schema-valid but substantively empty report.

Report the missing independent review and its blocker. Do not silently replace it with the parent agent's opinion while claiming delegation succeeded.

## 6. Validate every finding

The parent owns the final review. For each reported finding:

- Open the cited file/line and surrounding path.
- Confirm the changed code and relevant caller/data flow.
- Verify the impact is reachable under actual assumptions.
- Check tests/types/docs before accepting an API claim.
- Distinguish introduced regression from pre-existing behavior.
- Downgrade or reject style-only findings presented as correctness issues.

When reviewers disagree, present the disagreement and evidence. Do not choose by majority vote.

## 7. Deduplicate and prioritize

Merge findings by root cause, not wording. Preserve attribution only when it helps explain independent agreement/disagreement.

Severity guidance:

- **Critical:** immediate exploit, irreversible data loss, or system-wide outage likely.
- **High:** reachable correctness/security failure with substantial impact.
- **Medium:** real defect with bounded impact or important missing defense/test.
- **Low:** minor robustness/maintainability issue with concrete future cost.

Suggestions without a demonstrated defect belong after findings and should not block acceptance by default.

## 8. Present the review

Lead with verdict and validated findings:

| Severity | Location | Finding | Evidence | Recommended fix |
|---|---|---|---|---|

Then include:

- Review scope and base.
- Tests/checks considered.
- Rejected or disputed reviewer claims when material.
- Gaps/incomplete review.
- Reviewer orchestration details only after substantive results.

If there are no findings, say what was reviewed and what could not be verified. “No issues found” is not proof of correctness.

Do not fix findings, publish comments, or rerun review unless the user asks for the next step.

## Verification checklist

- [ ] Review target and base are exact.
- [ ] Reviewers have bounded, least-privilege purviews.
- [ ] Briefs are self-contained.
- [ ] Required results are anchored and awaited.
- [ ] Questions/errors/timeouts are not mistaken for completion.
- [ ] Every finding is independently validated at its cited location.
- [ ] Duplicate root causes are merged.
- [ ] Severity reflects reachable impact.
- [ ] Disagreements and gaps are visible.
- [ ] No code, branch or remote state was changed during review.
