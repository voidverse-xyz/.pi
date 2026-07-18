# pi-todo

Claude Code-style todo list for Pi (ref IMG_5781).

The agent plans and tracks multi-step work by calling the `todo_write` tool with the
**complete** list each time (it replaces the previous list). The live checklist renders
in a widget directly above the editor whose first line is a dynamic working header,
with the tree hanging off it via a `└` connector:

```
✻ Fixing sandbox/typedefs… (21m 29s · ↓ 62.3k tokens)
└ ✓ Fix store layer          <- completed: green check, dim strikethrough
  □ Fix sandbox/typedefs     <- in progress: accent, bold (shows activeForm)
  □ Fix mail                 <- pending: dim box
```

The header lives **inside the widget** (its first line), not on pi's working/spinner
row — other `aboveEditor` widgets (e.g. pi-status-line's shared row) would wedge
between that row and the tree. It is deliberately **not** a working-indicator clone:
the label is custom text the LLM sets via `todo_write`'s optional `header` param
("Building pure core modules"), falling back to the in-progress todo's `activeForm`,
then `Working`. It is dressed with a static `✻` (no animation — pi's loader row owns
the spinner), elapsed time, and the output tokens streamed this run (exact provider
usage when reported, chars/4 estimate otherwise; hidden until the first tokens
arrive). The widget re-renders once a second while working for the clock and token
count. pi's built-in working loader row is left untouched and keeps rendering above
everything. The header disappears when the agent settles; the tree stays.

## Surfaces

- **`todo_write` tool** — LLM-callable. Items are `{ content, status, activeForm? }`
  with statuses `pending | in_progress | completed`; at most one `in_progress`,
  plus an optional top-level `header` phrase for the status line. System-prompt
  guidelines steer the agent to plan 3+-step tasks up front, keep one task in
  progress, mark completions immediately, and keep the header phrase fresh.
- **Working header** — the widget's first line while the agent runs:
  `✻ <header>… (<elapsed> · ↓ <tokens> tokens)` with the LLM-set `header`
  (fallback: `activeForm`, then `Working`). Shown even when the todo list is
  empty; the built-in working loader row is not touched. The header phrase is
  restored on resume together with the list.
- **Widget** — `aboveEditor`, hidden when the list is empty and the agent is
  idle. `alt+d` cycles the tree
  through expanded → collapsed → hidden (Claude Code uses `ctrl+t`, but pi core
  owns that for thinking blocks). Collapsed is a one-line summary:

  ```
  └ □ Fixing sandbox/typedefs · 1/3 done
  ```
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
