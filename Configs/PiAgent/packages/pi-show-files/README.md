# pi-show-files

`show_files` — an **LLM-callable tool** (like `ask_user`) that presents a curated,
annotated set of files to the user in a full-screen native TUI. The agent calls it
when the user asks *"which files implement X?"*, *"where are the docs for Y?"*, or
wants a guided tour of part of the codebase.

## What the agent supplies

- A presentation `title` and optional `summary`.
- `files[]`, in most-important-first order, each with:
  - `path` — relative to the session cwd (absolute accepted); directories work too.
  - `title` — short label for the list (defaults to the file name).
  - `description` — why this file matters; rendered above the preview.
  - `group` — optional section heading (consecutive files sharing a group render under it).
  - `regions[]` — 1-based line ranges to highlight, each with an optional `note`.
    The preview opens on the first region; `n`/`p` jump between them; the note of
    the region under the cursor shows in the pane label.

Missing paths are not dropped: they're shown dimmed with a "(missing)" marker and
reported back so the agent can correct itself. If *every* path is missing the tool
errors immediately instead of showing an empty panel.

## What the user can do

- Browse the grouped list (left) and preview with highlights (right); opened files
  get a `·` marker.
- `a` — add the file/dir (or an `s`-selected line range) to the chat editor as an
  `@`-mention, without sending (same pattern as pi-browse).
- `m` — type a free-text note to the agent in an embedded editor.
- `q`/Esc — close.

## Two-way result

The tool result tells the agent what actually happened: which files the user
opened, which mentions they added to chat, and their note — so the agent can
follow up on what the user cared about instead of re-explaining everything.
"User closed without opening any file previews" is also honest, useful feedback.

## Command

`/show-files` reopens the session's last presentation. Since a command has no
tool result to carry a note back, a note typed there is staged into the chat
editor instead of being dropped.

## Headless subagents

No TUI to present on → graceful error telling the agent to describe the files in
prose. (Could forward to the parent via the `ipc` extension later, like
`ask_user` does, if that ever proves worth it.)
