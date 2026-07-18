# pi-todo

Claude Code-style todo list for Pi (ref IMG_5781).

The agent plans and tracks multi-step work by calling the `todo_write` tool with the
**complete** list each time (it replaces the previous list). The live checklist renders
in a plain `aboveEditor` widget with a simple, static title line, the tree hanging off
it via a `└` connector:

```
󰝖 Todos · 1/3
└ ✓ Fix store layer          <- completed: green check, dim strikethrough
  □ Fix sandbox/typedefs     <- in progress: accent, bold (shows activeForm)
  □ Fix mail                 <- pending: dim box
```

The title is a **list header, not a working indicator**: no spinner, no elapsed time,
no token count, no dynamic label — pi-codex-ui's loader row owns all of that. It is a
muted `󰝖 Todos` plus a dim progress count, and it renders whenever the list is
non-empty, **working or idle**, so the checklist always reads as what it is.

## Surfaces

- **`todo_write` tool** — LLM-callable. Items are `{ content, status, activeForm? }`
  with statuses `pending | in_progress | completed`; at most one `in_progress`.
  System-prompt guidelines steer the agent to plan 3+-step tasks up front, keep one
  task in progress, and mark completions immediately.
- **Widget** — a plain `aboveEditor` widget (renders with the other widget rows under
  the working indicator), hidden only when the list is empty or the user hid it.
  `alt+d` cycles expanded → collapsed → hidden (Claude Code uses `ctrl+t`, but pi
  core owns that for thinking blocks). A trailing blank line pads the block from
  whatever renders below it. Collapsed keeps the title plus a one-line summary
  with the expand hint:

  ```
  󰝖 Todos · 1/3
  └ □ Fixing sandbox/typedefs · 1/3 done · alt+d expand
  ```

  Long lists never hit pi core's generic 10-line widget cut: past 8 items the
  expanded view windows around the active item with dim `… +n earlier` /
  `… +n more · /todos for all` marker rows.
- **`/todos`** — prints the list as a notification; `/todos clear` wipes it.
- **Resume** — on `session_start` the list is rebuilt from the most recent
  `todo_write` call in the replayed session messages, so it survives `/reload`,
  resume, and fork with no extra persistence.

## Layout

- `extensions/todo/index.ts` — tool, widget wiring, shortcut, command, resume.
- `extensions/todo/render.ts` — pure rendering/validation/replay-extraction.
- `extensions/todo/render.test.ts` — unit tests:

```
node --test packages/pi-todo/extensions/todo/render.test.ts
```

Enable by adding the package path to `packages` in `~/.pi/agent/settings.json`,
then `/reload`.
