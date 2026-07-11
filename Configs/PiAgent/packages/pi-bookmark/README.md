# pi-bookmark

Bookmark session entries with labels (Pi's `setLabel`), and manage them from a picker.

## Commands

- **`/bookmark [label]`** — label the last assistant message on the active branch
  (default label: `bookmark-<timestamp>`). Labels also show up in Pi's `/tree` view.
- **`/unbookmark`** — remove the bookmark most recently created or renamed.
- **`/bookmarks`** — open the bookmark manager: a list of every labeled entry in the
  current session showing the label plus a one-line excerpt of the entry.

## Manager keys

| Key | Action |
|-----|--------|
| `↑`/`↓` | move |
| `Enter` | jump to the entry (moves the session leaf via `navigateTree`) |
| `r` | rename the bookmark (input prompt) |
| `d` / `x` | delete the bookmark |
| `Esc` | close |

Rename and delete reopen the list so you can do several in one pass; jump closes it.

## Storage

Bookmarks are Pi label entries in the session file: `setLabel` appends a `LabelEntry`,
and the manager enumerates `sessionManager.getEntries()` resolving each entry's current
label with `getLabel` — the same source `/bookmark` writes to. No extra state files.

## Install

This is a Pi package. Enable it by adding its absolute path to
`~/.pi/agent/settings.json` → `packages[]`, then `/reload`:

```
<shared-config>/PiAgent/packages/pi-bookmark
```
