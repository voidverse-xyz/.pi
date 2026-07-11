# command-safety

Gates every `bash` tool call the agent makes, classifying each command into a
severity **category** and requiring confirmation (some with a countdown) before
it runs. User-typed `!` commands are never intercepted — only agent tool calls.

> Editing guide for humans and future agents. For the runtime behavior summary,
> also read the header comment at the top of `index.ts`.

## Files

| File | Role | Edit it when… |
|------|------|---------------|
| `categories.ts` | **The data.** Which commands map to which category, and how each category is confirmed. | Adding/adjusting commands or category behavior. **This is the file you want 90% of the time.** |
| `index.ts` | The wiring. `tool_call` hook, mode gating (`off`/`on`/`max`), the `/safety` command, mode persistence, status-line glyph. | Adding a new category, or changing which modes gate which categories. |
| `delayed-confirm.ts` | The confirmation dialog UI (countdown lock, key handling). | Changing how the prompt looks/behaves. Rarely. |
| `audit.ts` | The decision audit log (JSONL append + reader for `/command-safety-log`). | Changing what gets logged or the entry shape. |
| `README.md` | This file. | Keep in sync when structure changes. |

## How classification works

`classifyCommand(command)` in `categories.ts` returns one of:

- a **category** (`destructive` | `network` | `exec`) — first matching rule in
  `CATEGORY_ORDER` wins, so the array is ordered **most-severe first**;
- `"other"` — not a known read-only builtin (gated in `max` mode only);
- `null` — provably read-only (`ls`, `cat`, `git status`, …) → never prompts.

Whether a category actually prompts depends on the current **mode** (see
`MODE_CATEGORIES` in `index.ts`):

| Mode | Gates | Glyph |
|------|-------|-------|
| `max` (default) | everything except read-only builtins | green shield |
| `on` | destructive only | yellow shield |
| `off` | nothing | red shield |

Mode is set with `/safety off|on|max`, persists to
`~/.pi/agent/command-safety.json`, and is reloaded at every startup — that file
**is** the startup default. (It is not in pi's `/settings`; extensions can't add
rows there.) `DEFAULT_MODE` in `index.ts` is the fallback when the file is absent.

## Adding a command to an existing category

Edit `CATEGORY_ORDER` in `categories.ts`. Add a `RegExp` to the `patterns`
array of the target category:

```ts
{
  category: "destructive",
  patterns: [
    new RegExp(String.raw`(?:^|[;|&])\s*(?:\S+/)?rm\b`),
    new RegExp(String.raw`\bkubectl\s+delete\b`, "i"),   // ← added
  ],
},
```

Pattern conventions used throughout the file:

- `new RegExp(String.raw`…`)` — `String.raw` avoids double-escaping backslashes.
- `\b` word boundaries so `rm` doesn't match `charm`/`form`.
- `${SEG}` (a helper = `[^|;&]*`) keeps a flag tied to the same sub-command in an
  `a && b` chain, e.g. `` `\bgit\s+push\b${SEG}--force` ``.
- Add `, "i"` for case-insensitive matching.

To make a command **never** prompt, add its name to `SAFE_COMMANDS` (or a git
subcommand to `GIT_READONLY`) instead.

## Changing how a category is confirmed

Edit its entry in `CATEGORY_META` (`categories.ts`):

```ts
destructive: {
  label: "Destructive",   // dialog title → "Destructive command"
  color: "error",         // CategoryColor: error | warning | accent | success
  confirmations: 2,       // number of prompts in a row
  delayMs: THREE_SECONDS, // countdown lock per prompt; 0 = live immediately
  blurb: "…",
},
```

`color` is a **semantic theme key**, resolved through the active theme via
`theme.fg()` — not a raw color. So the same category re-colors when the theme
changes. Current mapping: destructive=`error`, network=`accent`, exec/other=
`warning`. In the repo's `black-white` theme, `error`→red and `accent`→blue are
defined in `themes/black-white.json` (vars `red`/`blue`); a monochrome theme
without those would render these gray.

## Adding a whole new category

All in `categories.ts` unless noted:

1. Add the name to the `Category` union type.
2. Add a `CATEGORY_META` entry (label, color, confirmations, delayMs, blurb).
3. Add a `CATEGORY_ORDER` block at the correct severity position (order matters).
4. **In `index.ts`:** add the category to the appropriate `MODE_CATEGORIES` sets,
   or no mode will gate it.

## Audit log

Every decision is appended as one JSON line to
`~/.pi/agent/command-safety-audit.jsonl`:

```json
{"ts":"2026-07-06T12:34:56.789Z","command":"rm -rf build","category":"destructive","mode":"max","decision":"denied","source":"user","forwarded":false}
```

- `decision`: `auto-allowed` (read-only builtin, or the mode doesn't gate the
  category — e.g. `mode=off`), `approved`, or `denied`.
- `source`: `user` when a human confirmed/declined; `auto` when no human was
  involved (read-only pass-through, mode pass-through, or a headless block with
  no parent to ask).
- `forwarded`: `true` when the confirmation came from a headless subagent and
  was answered on the parent's TUI via the optional `ipc` extension.

`/command-safety-log` prints the last 20 entries and the log path. Writes are
best-effort: any failure is silently swallowed so auditing can never block a
command. The file is append-only and **grows unbounded** — there is no rotation
yet; truncate or delete it manually if it gets large.

## Testing & reloading

Sanity-check a regex without launching pi:

```bash
node -e 'console.log(/(?:^|[;|&])\s*(?:\S+\/)?rm\b/.test("sudo rm -rf /"))'
```

After editing, **restart pi**. A `/reload` may only re-run `index.ts` and not
re-import the changed `categories.ts` module.

## Non-interactive modes

In `print`/`json` modes there is no human to confirm, so any gated command is
**blocked** rather than prompted (see the `!ctx.hasUI` branch in `index.ts`).
