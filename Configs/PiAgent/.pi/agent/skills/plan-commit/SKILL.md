---
name: plan-commit
description: Review uncommitted changes layer by layer, show compact red/green diffs, commit on acceptance, optional squash. Use when the user runs /skill:plan-commit or asks to review by layer or commit in layers.
disable-model-invocation: true
---

# Plan Commit

Layered review and commit workflow for multi-file changes.

## Invoke

```
/skill:plan-commit
```

## On invocation

1. Read [references/layered-review-and-commit.md](references/layered-review-and-commit.md) in full.
2. Read [references/git-commits.md](references/git-commits.md) before any commit.
3. Run Phase 1 — scan and classify review groups.
4. Present **one group at a time** using the **compact diff template** (fits chat without scrolling).
5. Wait for **accept**, **ask [question]**, **skip**, **edit**, or **stop** before committing.
6. On **ask**, answer about the current group only, then re-show the same group footer.
7. Repeat for each group, then offer squash.

## Hard rules

- **Never commit unless the user explicitly asks** (or says **accept** during `/skill:plan-commit`).
- Never bulk-commit; stage only the accepted group's paths.
- Use `git diff` output in ` ```diff ` blocks so removals render red (`-`) and additions green (`+`).
- **Subject-only commit messages** — no `Co-authored-by:`, URLs, or body text.
- Use `git commit --no-verify -m "…"` (see [references/git-commits.md](references/git-commits.md)).
- **Local dev exclusions:** never classify or prompt for paths listed in [Local dev exclusions](references/layered-review-and-commit.md#local-dev-exclusions) when the only changes are HTTPS→HTTP / commented cert generation.

## Pi tools

- Use `bash` for git commands (`git status`, `git diff`, `git add`, `git commit`).
- Use `read` to inspect files when answering **ask** questions.
- Use `edit` when the user requests **edit** on the current group.
