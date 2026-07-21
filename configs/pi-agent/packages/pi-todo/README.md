# pi-todo

Claude Code-style todo list for Pi (ref IMG_5781).

The agent plans and tracks only genuinely complex work that naturally has at least
three substantive steps by calling the `todo_write` tool with the **complete** list each
time. Normal updates retain every existing item, including completed history, so a
task cannot disappear instead of visibly becoming complete. One- and two-step tasks,
quick fixes, simple lookups, and a single change plus verification are handled directly
without a todo list. The live checklist renders in an `aboveEditor` widget with a
simple, static title line, the tree hanging off it via a `└` connector, and a blank
padding line below the block:

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
and full control over truncation — require a component. Every rendered line is
ANSI-aware truncated to the component width so long items cannot overflow narrow
terminals, and the inserted `...` matches the truncated todo's state color (dim
completed, accent in-progress, normal text pending).

## Surfaces

- **`todo_write` tool** — LLM-callable, and the ONLY way to change the list. Items are
  `{ content, status, activeForm? }` with statuses `pending | in_progress | completed`;
  at most one is `in_progress`, and normalized `content` is a unique stable identity.
  Calls also accept `operation?: update | replace | clear` and `reason?`:
  - `update` (default) is non-destructive: it must retain every existing item while
    statuses, ordering, `activeForm`, and newly discovered work may change. Finished
    tasks are marked `completed` and stay visible; direct omission is rejected.
  - `replace` requires a non-empty list and reason, and is reserved for a direct
    user-requested replan rather than normal progress.
  - `clear` requires an empty list. It is safe after every item is completed; clearing
    unfinished work requires a reason and is reserved for a direct user request or
    abandoned checklist.

  System-prompt guidance also keeps the completed final list visible with the final
  report instead of immediately clearing it.
- **Task/topic pivots** — before each model call, an ephemeral lower-trust context
  message exposes every current checklist identity so the model can distinguish a
  continuation from a clear move to different work, including after compaction. The
  snapshot is refreshed after tool results and disappears immediately after a clear.
  A continuation preserves the list. A new complex task replaces it with a reason;
  simpler new work clears it, with a reason when unfinished. Cleanup is explicitly
  allowed even when the new request is too small to deserve its own checklist. This
  remains a semantic model decision rather than clearing deterministically on every
  prompt, which would incorrectly erase lists during follow-ups.
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
- **Resume and branches** — on `session_start` and `session_tree`, the list is rebuilt
  from the most recent successful `todo_write` result on the active branch. Rejected
  calls and abandoned branches cannot become live state, while `/reload`, resume,
  fork/clone, and tree navigation retain the correct snapshot without extra files.

## Layout

- `extensions/todo/index.ts` — tool, transition enforcement, widget, shortcut, restore.
- `extensions/todo/render.ts` — pure rendering, transition validation, branch extraction.
- `extensions/todo/render.test.ts` — pure unit tests.
- `extensions/todo/extension.test.mjs` — loaded-extension lifecycle tests.

```
node --test \
  configs/pi-agent/packages/pi-todo/extensions/todo/render.test.ts \
  configs/pi-agent/packages/pi-todo/extensions/todo/extension.test.mjs
```

The lifecycle tests use Pi's importable Node distribution when available (set
`PI_SDK_DIR` when it is installed in a nonstandard location). Binary-only Pi
installations still run a black-box RPC load test and skip only the loader-level
lifecycle cases instead of failing the suite.

This repository enables the package through
`"./configs/pi-agent/packages/pi-todo"` in root `settings.json`. Run `/reload`
after changing package activation.
