# pi-changes

Tracks files changed by the main agent's `edit` and `write` tools and provides a
Git-independent review interface.

## Commands

- `/changes` — open the review panel.
- `/browse-edits` — alias for `/changes`.

The panel can browse per-file diffs and current contents, ask the main agent or an
isolated read-only reviewer about a file, undo one or all safely restorable changes,
and export unified patches.

First-touch pre-images are persisted in the session so review and undo survive reload
and resume. Undo uses exact baselines when available, preserves original permission
bits, refuses unsafe symlink/binary/oversized restoration, detects external drift, and
requires confirmation before deletion or bulk restoration.

Only `edit` and `write` tool mutations are tracked. Files changed through shell
commands or external processes are outside its scope.
