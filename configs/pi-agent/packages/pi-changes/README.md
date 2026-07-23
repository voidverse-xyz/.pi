# pi-changes

Two native full-screen browsers for reviewing file changes.

## `/changes`

Shows files changed by the main agent's `edit` and `write` tools during the current session. This mode is Git-independent and supports:

- Per-file unified and split diffs
- Syntax-highlighted current contents
- Questions to the main agent or an isolated snapshot-only reviewer
- Safe single-file and bulk undo
- Patch export

First-touch pre-images are persisted in the session so review and undo survive reload and resume. Undo preserves permission bits, detects external drift, and refuses unsafe binary, oversized, symlink, or ambiguous restoration.

`/browse-edits` remains an alias for `/changes`.

## `/git-changes`

Shows repository-wide uncommitted Git changes, including:

- Staged changes
- Unstaged changes
- Files with both staged and unstaged changes
- Untracked files
- Deleted and conflicted files

It uses the same file, diff, and question views as `/changes`, but intentionally provides **no undo, discard, or patch-export action**. It never changes the index or working tree.

Git paths are handled literally, undecodable byte paths fail explicitly, rename detection and external diff/text-conversion/fsmonitor helpers are disabled, and optional index locking is disabled. Binary or oversized files are not loaded into memory. Diffs are capped at 2 MiB and 10,000 display lines per file, plus 32 MiB per snapshot; current-file text is independently capped at 10,000 display lines per file and 32 MiB across at most 10,000 changed files. Terminal control bytes are rendered as visible escapes.

The isolated reviewer receives only bounded diff/current-content snapshots. Its child Pi process loads no tools, extensions, skills, prompt templates, context files, or project-local configuration; it has a two-minute deadline and bounded protocol/answer output.

## Controls

| Key | Action |
|---|---|
| `↑` / `↓` | Move or scroll |
| `Enter` | Open diff |
| `v` | Toggle unified/split diff |
| `o` | Show current file |
| `a` | Ask main agent or isolated reviewer |
| `u` / `U` | Undo selected/all (`/changes` only) |
| `e` / `E` | Export selected/all patches (`/changes` only) |
| `f` | Back from a diff; switch the full-file view back to the diff |
| `q` | Close the file list or go back from a nested view (`Esc` remains a fallback) |
