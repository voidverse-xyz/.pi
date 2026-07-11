# pi-plan-commit

`/git-commit` — a native Pi TUI for layered git review and staged commits.

## What it does

Collects all uncommitted changes (staged, unstaged, untracked), groups them by
configurable rules, then walks the groups one by one in a full-screen review
panel. For each group you can:

- **Accept** — stage the group's files and commit them with a heuristic message.
- **Ask** — open a persistent chat panel; a question is answered by an isolated
  subagent (streams into the panel) or the main agent (answers in the main chat).
- **Edit** — send an edit instruction to the main agent, wait for it to finish,
  then re-review the group against the fresh working tree.
- **Skip** — leave the group uncommitted and move on.
- **Stop** — end the review.

After the walk a summary lists the session's commits; two or more commits get an
optional squash offer (soft reset + one commit scoped to the session's paths).

## Dry run

```
/git-commit --dry-run
```

Walks the identical grouped review flow, but **Accept** only reports what would
be committed (group, files, message) — nothing is staged or committed and no git
state changes. The review header shows a `DRY RUN` marker and the final summary
is labeled `DRY RUN — … No git state was changed.` with the list of would-be
commits. Note that **Edit** still asks the agent to modify working-tree files
(that is a file change, not a git state change).

## Configuration

Discovery, first file found wins:

1. `<project>/.pi/plan-commit.json`
2. `~/.pi/agent/plan-commit.json`
3. built-in defaults

Merge semantic: a key present in the chosen file **replaces** the built-in
default for that key wholesale (a `groups` array replaces *all* default groups;
there is no extend/append). Omitted keys keep their defaults. Invalid keys are
dropped with a warning notification and fall back to their defaults; a file with
invalid JSON falls back to the full defaults with a warning.

```json
{
	"groups": [
		{ "name": "API handlers", "patterns": ["src/api/**"] },
		{ "name": "UI", "patterns": ["src/components/**", "src/app/**"] }
	],
	"exclude": ["**/*.local.*", "scripts/dev-*"],
	"noVerify": true,
	"commitTemplate": "{summary}"
}
```

- **`groups`** — ordered rules. A changed path belongs to the *first* rule with
  a matching pattern; rule order is review order. Paths matching no rule fall
  into per-directory fallback groups reviewed after the configured ones.
- **`exclude`** — globs that are unconditionally kept out of the review: matching
  paths never appear in any group and are listed on the summary screen as
  "Left unstaged (excluded by config)".
- **`noVerify`** — when `true` (the default) commits pass `--no-verify`, skipping
  git hooks; `false` runs hooks normally. Applies to group commits and the squash
  commit.
- **`commitTemplate`** — renders each group's heuristic commit message. Exactly
  three placeholders are supported; anything else is literal text:

  | Placeholder | Renders to |
  |---|---|
  | `{group}` | the group's name/title |
  | `{files}` | the group's paths, comma-separated |
  | `{summary}` | heuristic verb phrase: `update <basename sans extension>` for a single-file group, `update <group name lowercased>` otherwise |

  The default template is `"{summary}"`, which keeps the current heuristic
  message style. A template that renders to an empty string falls back to
  `{summary}` so commits never get an empty message.

### Glob syntax

No dependency — a minimal matcher (`glob.ts`) supporting `**` (any number of
path segments when on segment boundaries, otherwise any characters), `*` (within
one segment), and `?` (one character within a segment). Matching is against
forward-slash repo-relative paths, whole-path anchored, case-insensitive.

### Built-in defaults

The previously hardcoded project-specific classifier rules and local-dev
exclusions, expressed in the config shape (see `DEFAULT_CONFIG` in
`extensions/plan-commit/config.ts`):

- groups: Schema + DB wiring, Controllers, Routes, Service facades,
  Hooks & context, UI, i18n translations, Docs.
- exclude: `backend/server.js`, `backend/routes/routes.js`,
  `backend/notify/socket/socket.js`.

Three behavior changes from the hardcoded era, all intentional:

- Grouping is static per rule (one "Controllers" group) rather than split per
  domain ("auth controller", "user controller") — add narrower rules to your
  config if you want finer groups.
- `exclude` is purely path-based. The old classifier only excluded the local-dev
  files when their diff contained *nothing but* local-dev lines (https/cert
  tweaks); now an excluded glob always keeps the file out of review. Remove the
  entry from `exclude` in your own config to review those files again.
- Fallback (unmatched) per-directory groups are reviewed after *all* configured
  groups, including Docs. The old classifier slotted them before Docs; move a
  pattern into your own `groups` if a path should review earlier.

## Install

Add the package path to `~/.pi/agent/settings.json` (`packages`), or copy
`extensions/plan-commit/` into `~/.pi/agent/extensions/`.
