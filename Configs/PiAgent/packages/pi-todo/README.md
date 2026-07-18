# pi-todo

Claude Code-style todo list for Pi (ref IMG_5781).

The agent plans and tracks only genuinely complex work that naturally has at least
three substantive steps by calling the `todo_write` tool with the **complete** list each
time (it replaces the previous list). One- and two-step tasks, quick fixes, simple
lookups, and a single change plus verification are handled directly without a todo
list. The live checklist renders
in an `aboveEditor` widget with a simple, static title line, the tree hanging off it
via a `└` connector, and a blank padding line below the block:

```
󰝖 Todos · 1/3
└ ✓ Fix store layer          <- completed: green check, dim strikethrough
  □ Fix sandbox/typedefs     <- in progress: accent, bold (shows activeForm)
  □ Fix mail                 <- pending: dim box

```

The title is a **list header, not a working indicator**: no spinner, no elapsed time,
no token count, no dynamic label — Void Agent's loader row owns all of that. It is a
muted `󰝖 Todos` plus a dim progress count, and it renders whenever the list is
non-empty, **working or idle**, so the checklist always reads as what it is.

The widget is a live factory component (not a string-array widget): pi wraps
string-array lines in pi-tui `Text`, which drops blank lines, so the padding row —
and full control over truncation — require a component.

## Surfaces

- **`todo_write` tool** — LLM-callable, and the ONLY way to change the list (an empty
  list clears it). Items are `{ content, status, activeForm? }` with statuses
  `pending | in_progress | completed`; at most one `in_progress`. System-prompt
  guidelines restrict the tool to genuinely complex work with 3+ substantive steps,
  explicitly forbid one- or two-step lists and filler steps, keep one task in progress,
  mark completions immediately, prune completed/obsolete todos once they no longer
  matter to the remaining work, and clear the list when everything is done
  (the tool result nudges this contextually — e.g. "all completed → clear now").
- **`alt+o`** — the only user control: cycles expanded → collapsed → hidden
  (Claude Code uses `ctrl+t`, but pi core owns that for thinking blocks). There is
  deliberately no slash command. Collapsed keeps the title plus a one-line summary
  with the expand hint:

  ```
  󰝖 Todos · 1/3
  └ □ Fixing sandbox/typedefs · 1/3 done · alt+o expand
  ```

  Long lists never hit pi core's generic 10-line widget cut: past 8 items the
  expanded view windows around the active item with dim `… +n earlier` /
  `… +n more · alt+o` marker rows.
- **Resume** — on `session_start` the list is rebuilt from the most recent
  `todo_write` call in the replayed session messages, so it survives `/reload`,
  resume, and fork with no extra persistence.

## Layout

- `extensions/todo/index.ts` — tool, widget component, shortcut, resume.
- `extensions/todo/render.ts` — pure rendering/validation/replay-extraction.
- `extensions/todo/render.test.ts` — unit tests:

```
node --test packages/pi-todo/extensions/todo/render.test.ts
```

Enable by adding the package path to `packages` in `~/.pi/agent/settings.json`,
then `/reload`.
