# pi-commit

A native Pi TUI for reviewing uncommitted changes in groups and creating path-scoped commits.

## Command

```text
/commit
/commit --dry-run
```

When a group opens, the active model lazily generates a one- or two-sentence description of what its commit changes and why. The result appears below the header and is cached while that unchanged group is revisited. Header, content, and action sections have responsive vertical spacing when the terminal has room.

The review presents each group with these actions:

- **Accept** — stage and commit only that group's paths.
- **Ask** — ask a temporary read-only Pi subprocess about the group.
- **Edit** — close the review and send a scoped edit request to the main agent.
- **Skip** — leave the group unchanged.
- **Stop** — stop the review.

At the end, two or more commits can optionally be squashed when they are still the contiguous branch tip and their paths have no newer changes. A failed squash commit restores the original HEAD.

`--dry-run` runs the review without changing Git state.

## Review keys

| Key | Action |
|---|---|
| `Tab` | Move between content and actions |
| `↑` / `↓` | Move or scroll |
| `Enter` | Open a file or choose an action |
| `d` | Open the combined group diff |
| `v` | Toggle unified/split diff |
| `t` | Toggle diff/full-file content |
| `f` / `q` | Return from detail to files |
| `q` | Stop from the file or actions view (`Esc` remains a fallback) |

The chat question field accepts ordinary text, so `q` remains typeable there and `Esc` closes that text-entry surface.

## Configuration

Configuration is loaded in this order:

1. `<project>/.pi/commit.json`, only when the project is trusted
2. `~/.pi/agent/commit.json`
3. Built-in defaults

```json
{
  "groups": [
    { "name": "Tests", "patterns": ["tests/**", "**/*.test.ts"] },
    { "name": "Docs", "patterns": ["docs/**", "**/*.md"] }
  ],
  "exclude": ["generated/**"],
  "noVerify": false,
  "commitTemplate": "{summary}"
}
```

Unmatched files are grouped by containing directory. Built-in defaults do not exclude files, and Git hooks run unless `noVerify` is explicitly enabled.

Template variables are `{summary}`, `{group}`, `{files}`, and `{count}`.

## Safety

- Git arguments are passed without a shell.
- Changed paths use NUL-delimited Git output.
- Commits are scoped to the reviewed paths, preserving unrelated staged files.
- The pre-operation index is restored if staging, hooks, or commit fail.
- Exclusions are reported and never committed.
- Diff, generated-description prompts, child-agent history, output, and runtime are bounded.
- Closing or accepting a group aborts description generation that is still running.
