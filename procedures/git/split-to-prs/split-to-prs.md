# Split work into reviewable pull requests

Use this procedure when the user wants one branch, working tree, change set, or conversation's work separated into multiple focused pull requests.

The goal is not to maximize PR count. Produce the smallest set of coherent slices that reviewers can understand, test and merge safely without losing user work.

## Operating rules

- Start with read-only discovery. Do not create branches, commits, remote refs or PRs merely to prepare a proposal.
- Treat four approvals separately: **split plan**, **local branches/commits**, **push**, and **PR publication**. One approval covers later stages only when the user explicitly included those actions.
- Never discard or rewrite the original work. No hard reset, clean, force-push, branch deletion, rebase of published work, or history rewrite without explicit authorization and a verified recovery path.
- Preserve untracked files as carefully as tracked changes; a Git commit/ref snapshot alone does not include them.
- Stage only named files or hunks. Never use `git add .` or `git add -A`.
- Keep public artifacts free of local paths, private hosts, unrelated projects, secrets, agent/session metadata, and details about excluded local files.
- Use `gh` for GitHub operations, following the shared `gh` and `privacy` skills.

## Phase 1 — Discover the actual change set

Read repository instructions first, then collect the minimum state needed:

```bash
git status --short --branch
git branch --show-current
git remote -v
git log --oneline --decorate -20
git diff --stat
git diff --cached --stat
git ls-files --others --exclude-standard
```

Determine the repository's real default/base branch from project instructions, remote metadata or existing branch structure. Do not assume `main` when the repository says otherwise.

Compare all relevant work with that base:

- Commits on the current branch.
- Staged changes.
- Unstaged tracked changes.
- Untracked files.
- Intent and constraints established in the conversation.

Find ownership and dependency signals:

- `CODEOWNERS` or equivalent ownership files.
- Package/module boundaries.
- Schema/API/client/UI layering.
- Shared migrations, generated files and lockfiles.
- Tests that prove each concern.
- Whether one slice must land before another.

Use structured `gh --json` output only when remote PR state is necessary and already authorized. Read-only local analysis does not imply permission to contact a remote host.

## Phase 2 — Design the split

Prefer **independent PRs from the default branch**. Use stacked PRs only when a real compile-time, data-contract or migration dependency prevents independence.

A good slice:

- Has one reviewer-understandable purpose.
- Contains all layers required to remain buildable and testable.
- Does not hide a required dependency in another unmerged PR.
- Avoids unrelated formatting, generated output or cleanup.
- Includes its relevant tests and documentation.
- Has a clear owner/reviewer boundary where the repository defines one.

Do not split tightly coupled changes merely to make smaller numbers. Do not combine independent concerns merely because they touch the same feature.

### Proposal format

Present a numbered table:

| # | Proposed PR | Base | Scope | Files/areas | Depends on | Verification |
|---|---|---|---|---|---|---|

Then include:

- **Independent or stacked:** state which and why.
- **Shared/mixed files:** identify files requiring hunk-level separation.
- **Left behind:** work intentionally excluded from every proposed PR.
- **Risks:** migration order, generated artifacts, test gaps or ambiguous ownership.

A small dependency diagram is useful for stacked work, but not required for simple independent slices.

Ask the user to approve or revise the split plan. Plan approval alone does not authorize local commits, pushes or PR creation unless the user explicitly said it does.

## Phase 3 — Establish a recovery point

Before rearranging approved work, inventory and preserve it without altering the original checkout.

### Tracked committed state

Record:

```bash
git rev-parse HEAD
git log --oneline "<base>..HEAD"
```

Existing commits already provide recoverable objects. Do not rewrite them to make the split.

### Tracked uncommitted state

With authorization to create a local recovery ref, capture tracked staged and unstaged changes without changing the working tree:

```bash
snapshot=$(git stash create "pre-split snapshot")
if [ -n "$snapshot" ]; then
  git update-ref "refs/backup/pre-split-$(date +%s)" "$snapshot"
fi
```

Record the created ref and verify it resolves. This does **not** protect untracked files.

### Untracked state

List untracked files explicitly. Before moving or deleting any of them, create a user-approved local backup that preserves relative paths, or leave the original checkout untouched and copy only approved files into isolated worktrees.

Do not publish, commit or upload the backup. Do not include secrets or ignored files unless the user specifically identifies them for the work.

If a complete recovery point cannot be verified, stop before rearranging changes.

## Phase 4 — Build each slice in isolation

Prefer the shared `using-git-worktrees` skill so each approved PR branch is built in a separate worktree while the original branch and dirty checkout remain intact.

For each slice:

1. Create its branch/worktree from the approved base.
2. Bring in only the approved commits, files or hunks.
3. Resolve dependencies without pulling unrelated work into the slice.
4. Run the slice's authoritative checks.
5. Review both the worktree diff and staged diff before any commit.

When an existing commit maps cleanly to one slice, cherry-picking it into the isolated branch may be appropriate. When commits mix concerns, do not rewrite the original branch; reconstruct the approved slice in its worktree using precise patches or edits.

For files containing multiple slices, stage only the intended hunks. If reliable hunk staging is unavailable, reconstruct the file in the isolated worktree or generate and inspect an exact patch rather than staging unrelated lines.

### Pre-commit verification

Before every authorized commit:

```bash
git status --short
git diff --check
git diff --cached --check
git diff --cached --stat
git diff --cached
```

Confirm:

- Only the planned slice is staged.
- The staged result is internally buildable/testable where possible.
- No user work, local configuration or unrelated formatting slipped in.
- Commit text contains no private/local details, session trailers, generated-by footers or agent attribution.

Commit only after explicit authorization. Approval for one slice does not silently authorize later slices.

## Phase 5 — Verify the PR set locally

For every branch, record:

- Checks/tests run and their results.
- Diff against its intended base.
- Whether it is independently mergeable or which earlier PR it requires.
- Any work intentionally left only on the original branch.

For stacked branches, verify each adjacent diff as well as the final aggregate. A stacked PR should show only its incremental change against its immediate parent branch.

Do not weaken CI, skip failing tests, or add unrelated fixes merely to make the split appear green. Report pre-existing or unrelated failures separately.

## Phase 6 — Push through the privacy/egress gate

A push sends commits and metadata to a remote host. Before pushing, ensure the user has explicitly authorized:

- The exact branches/commits being sent.
- The destination remote/host.
- Why the push is needed.

Inspect the outgoing range and commit metadata first:

```bash
git log --oneline --decorate "<remote-base>..HEAD"
git log "<remote-base>..HEAD" --format='%h%n%B%n---'
git diff --stat "<remote-base>...HEAD"
```

Apply the shared privacy leak pass to committed files, messages and trailers. Then push only the authorized branch. Never force-push unless the user explicitly requests it after seeing the consequences.

## Phase 7 — Create pull requests with `gh`

PR publication is a separate outbound action unless already authorized. Before creating each PR, show or confirm:

- Repository and remote host.
- Head and base branches.
- Exact title and body.
- Stack/dependency links when applicable.

Use neutral public prose. Do not mention ignored/redacted files, home paths, private infrastructure, other projects, internal account details, or agent/runtime metadata.

Prefer a reviewed local body file over complex shell quoting, then use `gh pr create` with explicit repository/base/head/title/body arguments. Capture the returned PR URL. Use `gh pr view --json` to verify the published title, body, base, head and state rather than scraping formatted output.

For stacked PRs:

- Set each PR's base to its immediate parent branch.
- State the dependency briefly in the PR body without local implementation details.
- After a parent merges, retarget/rebase later PRs only with explicit authorization.

## Phase 8 — Report and preserve recovery options

Return a concise table:

| PR | URL | Base ← Head | Purpose | Checks | Dependency |
|---|---|---|---|---|---|

Also report:

- Work remaining on the original branch/worktree.
- Recovery ref or local backup location in private chat only.
- Any branch not pushed or PR not created.
- Known failures or follow-up work.

Do not delete the original branch, backup ref, untracked backup or worktrees automatically. Cleanup and branch deletion are separate user decisions after the user verifies the split.

## Stop conditions

Stop and ask rather than guessing when:

- The default/base branch is ambiguous.
- Uncommitted work cannot be backed up safely.
- A file cannot be separated without changing behavior.
- A proposed independent PR actually depends on another slice.
- Tests fail and the cause is unclear.
- The remote destination or publication authorization is missing.
- A branch/path already exists or is checked out elsewhere.
- Executing the split would require destructive Git operations.
