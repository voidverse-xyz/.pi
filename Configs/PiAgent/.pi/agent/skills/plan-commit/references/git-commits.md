# Git commits

## Do not commit unless asked

- **Never** run `git commit`, `git push`, or rewrite history unless the user **explicitly** requests it.
- During `/skill:plan-commit`, commit **only** after the user says **accept** for that group.
- If unclear whether to commit, ask first.

## When committing (user asked)

### Subject only

- Use a **single subject line** — short, imperative, lowercase (e.g. `add manual schema`).
- Do **not** add a commit body unless the user explicitly asks for one.

### Never add to commit messages

- `Co-authored-by:` trailers (including `Co-authored-by: Cursor <cursoragent@cursor.com>`)
- Tool or agent attribution lines
- URLs or links
- `Signed-off-by:` or similar trailers unless the user explicitly requests them

### Command

```powershell
git commit --no-verify -m "subject line here" -- path1 path2
```

Use `--no-verify` so IDE hooks do not re-inject co-author trailers.

Never force-push unless the user explicitly asks.

## Related workflow

Layered review: `/skill:plan-commit` — see [layered-review-and-commit.md](layered-review-and-commit.md).
