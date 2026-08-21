---
name: using-git-worktrees
description: Safely create and use isolated Git worktrees, then review and land their changes without disturbing the parent checkout. Detect existing isolation, confirm branch and location, preserve dirty work, respect project setup, keep changes unstaged for review, obtain commit approval, rebase and fast-forward when required, and clean up only with approval. Use whenever the user asks for a worktree or isolated workspace, wants substantial work kept separate, or repository instructions require tracked edits in a worktree.
---

# Using Git worktrees

Use a linked Git worktree when work should be isolated from the current checkout without cloning the repository again.

The safety model is:

1. Detect existing isolation before creating anything.
2. Follow repository instructions for worktree placement, review and landing.
3. Prefer worktree support provided by the current agent harness or IDE.
4. Confirm the branch, base and destination when the user has not already specified them.
5. Keep setup and tests consistent with the project—containerized when applicable.
6. Require explicit approval before transferring dirty changes, staging or committing work, cleaning up a worktree or deleting its branch.

## 1. Read project instructions and inspect Git state

Read the repository's agent/contributor instructions before choosing a location, branch name, setup command or test command.

Run read-only discovery first:

```bash
git rev-parse --is-inside-work-tree
git rev-parse --show-toplevel
git status --short --branch
git worktree list --porcelain
```

Before creating a worktree that will later land on the current branch, record the surviving parent checkout and branch:

```bash
parent_path=$(git rev-parse --show-toplevel)
parent_branch=$(git branch --show-current)
```

If the current checkout is not the intended landing checkout, explicitly identify and confirm the parent path and branch instead. A tag, commit or arbitrary start point is not automatically a landing branch.

To distinguish a linked worktree from the repository's primary checkout:

```bash
git_dir=$(cd "$(git rev-parse --git-dir)" && pwd -P)
common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
superproject=$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)
```

- If `git_dir` and `common_dir` differ and this is not merely a submodule relationship, treat the current checkout as already isolated. Check its branch, status and task purpose before using it. Ask before mixing in the new task when it is dirty or serves unrelated work, and do not create a nested worktree unless the user explicitly wants another one.
- If the current checkout is detached, report that fact. Do not silently create or attach a branch.
- If this is not a Git repository, stop and explain that Git worktrees are unavailable.

A new worktree starts from committed Git state. It does **not** automatically include uncommitted changes from the current checkout. If the requested work depends on those changes, explain the limitation and ask how to proceed. Do not stash, commit, reset, patch-transfer or otherwise transfer dirty work without explicit approval.

When the user approves reproducing dirty state for verification, copy only the named, non-sensitive files needed for test parity. Record them as temporary test scaffolding and remove those copies before review or commit. Never copy credentials, ignored environment files or unrelated untracked data. If the task must edit a file already changed in the parent checkout, stop and ask how to separate the work.

## 2. Decide whether to create one

Creation is already authorized when the user explicitly asks for a worktree or isolated workspace and supplies enough detail to proceed. Otherwise, confirm before creating a branch or directory.

Clarify only missing decisions:

- Branch name.
- Start point: current branch, default branch, a tag, or a named commit.
- Destination location when project instructions do not define one.
- Whether an existing local branch should be checked out instead of creating a new branch.

Validate a proposed branch name:

```bash
git check-ref-format --branch "$branch"
```

Do not invent a base branch when choosing incorrectly could change the resulting work. Inspect repository defaults and ask when ambiguous.

## 3. Prefer native worktree support

If the harness or IDE exposes a worktree command/tool, use it instead of calling `git worktree add` directly. Native support may own directory placement, session switching and cleanup; bypassing it can create state the harness cannot manage.

Use manual Git commands only when no native worktree mechanism is available.

## 4. Choose a safe destination

Follow this order:

1. An explicit location in project or user instructions.
2. An existing project convention, such as `.worktrees/` or `worktrees/`.
3. A user-approved sibling directory outside the repository.

For a project-local destination, verify the container directory is ignored:

```bash
git check-ignore -q .worktrees
git check-ignore -q worktrees
```

If it is not ignored:

- Prefer an external sibling location that cannot pollute repository status; or
- Ask before editing `.gitignore`.

Never commit a `.gitignore` change unless the user explicitly asks for a commit. Never place a linked worktree inside a tracked, non-ignored directory.

Before creation, verify that the destination does not contain unrelated data and is not already registered:

```bash
test ! -e "$path"
git worktree list --porcelain
```

Do not delete or overwrite an existing path to make room.

## 5. Create the worktree

After the branch, base and destination are authorized:

### New branch

```bash
git worktree add -b "$branch" "$path" "$start_point"
```

### Existing local branch

```bash
git worktree add "$path" "$branch"
```

If Git says the branch is already checked out elsewhere, do not force it. Report the existing worktree path and let the user choose whether to use that worktree or select another branch.

After creation:

```bash
cd "$path"
git status --short --branch
worktree_path=$(git rev-parse --show-toplevel)
worktree_branch=$(git branch --show-current)
git worktree list --porcelain
```

Confirm that the working directory, branch and registered worktree path are the intended ones before editing files. Preserve `parent_path`, `parent_branch`, `worktree_path` and `worktree_branch` for landing and cleanup rather than reconstructing them later.

When a separate editor window will help the user follow the work, open the worktree after creation. For VS Code with its CLI available:

```bash
code --new-window "$path"
```

Use the user's requested editor when specified. Opening an editor does not replace changing the agent's own working directory to the worktree.

## 6. Set up the project safely

Follow the repository's documented setup procedure instead of guessing from one manifest.

When Docker or Docker Compose is available and the shared `containerized-development` skill applies, perform dependency setup, builds and tests in containers rather than installing project toolchains or dependencies on the host.

If containerization does not apply:

- Infer the package manager from project documentation and lockfiles.
- Ask before running an install that may access the network or materially modify caches/lockfiles.
- Never copy secrets, untracked environment files or credentials from another checkout automatically. Tell the user when local configuration is required.
- Do not modify manifests merely to make setup convenient unless that is part of the requested work.

## 7. Establish a baseline

Before implementation, verify the new worktree is clean:

```bash
git status --short --branch
```

Run the project's documented baseline checks when practical. Prefer the smallest authoritative check set needed to distinguish pre-existing failures from regressions.

If baseline checks fail:

1. Record the exact failing command and concise failure summary.
2. Determine whether the failure is clearly environmental or already present.
3. Ask whether to investigate, proceed with the known failure, or stop.

Do not silently treat a failing baseline as success.

Report readiness in a compact form:

```text
Worktree: <path>
Branch: <branch> from <start-point>
Setup: <container/service or local method>
Baseline: <passing, failing, or not run—with reason>
```

## 8. Work, review and land safely

Keep all task edits scoped to the worktree and continue honoring repository instructions for tests, commits and outbound actions. Keep changes unstaged while they are being reviewed. Show them with:

```bash
git status --short
git diff
```

Read untracked files directly or use `git diff --no-index`; do not stage or use intent-to-add merely to expose a diff. Before review, remove any copied test scaffolding and confirm that only task changes remain.

Summarize the changes and verification, then obtain explicit commit approval. Approval to create a worktree or edit files is not approval to stage, commit or push. After commit approval:

```bash
git log --oneline -10
git add <approved-paths>
git commit -m "<message>"
```

Stage only approved task files. Follow the repository's commit style and issue-trailer rules, and never add agent attribution or generated-by metadata. Never push unless the user separately requests it.

When repository instructions call for landing the worktree branch on its recorded parent, first bring in parent changes from inside the worktree:

```bash
git -C "$worktree_path" rebase "$parent_branch"
```

Stop and report conflicts instead of guessing at another change's intent. After a successful rebase, rerun the relevant checks. Then fast-forward the recorded parent from its surviving checkout:

```bash
git -C "$parent_path" merge --ff-only "$worktree_branch"
```

If the parent moved, return to the worktree, rebase again and re-verify. Do not merge into a different branch, create a merge commit or force the operation. Follow repository approval boundaries; when permission to merge is ambiguous, ask first.

Include the worktree path and branch in status and final reporting when it helps the user find the work.

## 9. Clean up without losing work

Do not remove a worktree automatically when the task ends. The user may want to inspect or continue using it.

Run cleanup from the recorded parent checkout or another confirmed surviving checkout, never from inside the worktree being removed. Before any requested cleanup:

```bash
git -C "$worktree_path" status --short --branch
git -C "$parent_path" worktree list --porcelain
```

If the worktree has uncommitted or untracked work, stop and show what would be lost. A verified backup does not itself authorize deletion. Use `git worktree remove --force` only when the user separately and explicitly authorizes discarding the identified work.

For a clean worktree, after confirmation:

```bash
git -C "$parent_path" worktree remove "$worktree_path"
git -C "$parent_path" worktree list --porcelain
```

Branch deletion is a separate destructive decision. Do not delete the branch merely because the worktree was removed. After explicit approval, use non-forcing deletion so Git protects unmerged work:

```bash
git -C "$parent_path" branch -d "$worktree_branch"
```

Use `git worktree prune` only for genuinely stale administrative entries after reviewing `git -C "$parent_path" worktree list --porcelain`.

## Failure handling

| Situation | Response |
|---|---|
| Already in a linked worktree | Validate its branch, status and purpose; use it only when appropriate, and do not create another by default. |
| Current checkout is dirty | Explain that dirty changes will not appear in the new worktree; ask before transferring anything. |
| Destination exists | Refuse to overwrite it; choose another path with the user. |
| Branch is checked out elsewhere | Report its registered path; do not force. |
| Native tool denies or fails | Report the error; do not bypass policy with manual Git unless appropriate and authorized. |
| Setup requires unavailable tooling | Use documented fallback or ask; do not pollute the host. |
| Baseline tests fail | Record the failure and ask how to proceed. |
| Rebase or merge conflicts | Stop in the isolated worktree and report the conflicting files; do not guess at intent. |
| Cleanup finds work | Preserve it and stop cleanup. |

## Non-negotiable safeguards

- Never create a nested worktree accidentally.
- Never overwrite an existing destination.
- Never move dirty work without approval.
- Never modify or commit `.gitignore` implicitly.
- Never install host dependencies when the containerized procedure applies.
- Never stage or commit before approval.
- Never push without a separate explicit request.
- Never merge into a branch other than the recorded parent.
- Never force-remove a worktree or delete its branch without authorization.
- Surface conflicts in the isolated worktree, not the parent checkout.
