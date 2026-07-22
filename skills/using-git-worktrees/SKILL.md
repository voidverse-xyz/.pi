---
name: using-git-worktrees
description: Safely create and use isolated Git worktrees for feature work, implementation plans, risky refactors, or parallel changes. Detect existing isolation first, prefer platform-native worktree support, confirm branch and location before creating anything, respect containerized project setup, verify a clean baseline, and clean up without losing work. Use whenever the user asks for a worktree, an isolated branch/workspace, or wants substantial work kept separate from the current checkout.
---

# Using Git worktrees

Use a linked Git worktree when work should be isolated from the current checkout without cloning the repository again.

The safety model is:

1. Detect existing isolation before creating anything.
2. Prefer worktree support provided by the current agent harness or IDE.
3. Confirm the branch, base and destination when the user has not already specified them.
4. Keep setup and tests consistent with the project—containerized when applicable.
5. Never discard, move, commit, push or delete user work implicitly.

## 1. Read project instructions and inspect Git state

Read the repository's agent/contributor instructions before choosing a location, branch name, setup command or test command.

Run read-only discovery first:

```bash
git rev-parse --is-inside-work-tree
git rev-parse --show-toplevel
git status --short --branch
git worktree list --porcelain
```

To distinguish a linked worktree from the repository's primary checkout:

```bash
git_dir=$(cd "$(git rev-parse --git-dir)" && pwd -P)
common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
superproject=$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)
```

- If `git_dir` and `common_dir` differ and this is not merely a submodule relationship, treat the current checkout as already isolated. Do not create a nested worktree unless the user explicitly wants another one.
- If the current checkout is detached, report that fact. Do not silently create or attach a branch.
- If this is not a Git repository, stop and explain that Git worktrees are unavailable.

A new worktree starts from committed Git state. It does **not** automatically include uncommitted changes from the current checkout. If the requested work depends on those changes, explain the limitation and ask how to proceed. Do not stash, commit, reset, patch-transfer or otherwise move dirty work without explicit approval.

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
git rev-parse --show-toplevel
git worktree list --porcelain
```

Confirm that the working directory, branch and registered worktree path are the intended ones before editing files.

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

## 8. Work and report normally

Once inside the worktree:

- Keep all task edits scoped to it.
- Continue honoring repository instructions for tests, commits and outbound actions.
- Do not commit or push merely because the worktree exists; those still require the user's request.
- Include the worktree path and branch in status/final reporting when it helps the user find the work.

## 9. Clean up without losing work

Do not remove a worktree automatically when the task ends. The user may want to inspect or continue using it.

Before any requested cleanup:

```bash
git -C "$path" status --short --branch
git worktree list --porcelain
```

If the worktree has uncommitted or untracked work, stop and show what would be lost. Do not use `git worktree remove --force` unless the user explicitly authorizes discarding or has approved a verified backup.

For a clean worktree, after confirmation:

```bash
git worktree remove "$path"
git worktree list --porcelain
```

Branch deletion is a separate destructive decision. Do not delete the branch merely because the worktree was removed. Use `git worktree prune` only for genuinely stale administrative entries after reviewing `git worktree list --porcelain`.

## Failure handling

| Situation | Response |
|---|---|
| Already in a linked worktree | Use it; do not create another by default. |
| Current checkout is dirty | Explain that dirty changes will not appear in the new worktree; ask before transferring anything. |
| Destination exists | Refuse to overwrite it; choose another path with the user. |
| Branch is checked out elsewhere | Report its registered path; do not force. |
| Native tool denies or fails | Report the error; do not bypass policy with manual Git unless appropriate and authorized. |
| Setup requires unavailable tooling | Use documented fallback or ask; do not pollute the host. |
| Baseline tests fail | Record the failure and ask how to proceed. |
| Cleanup finds work | Preserve it and stop cleanup. |

## Non-negotiable safeguards

- Never create a nested worktree accidentally.
- Never overwrite an existing destination.
- Never move dirty work without approval.
- Never modify or commit `.gitignore` implicitly.
- Never install host dependencies when the containerized procedure applies.
- Never commit, push, force-remove a worktree, or delete its branch without authorization.
