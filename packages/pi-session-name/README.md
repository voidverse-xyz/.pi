# pi-session-name

Adds friendly session names for Pi's session selector.

- Automatically derives a name from the first qualifying user prompt.
- `/session-rename <name>` sets an explicit name.
- `/session-rename` displays the current name.
- `/session-rename --clear` clears it; the next qualifying prompt may auto-name it.

Auto-naming is local and heuristic—no model call. It strips common Markdown noise,
uses the first non-empty line, collapses whitespace, and limits the result to 48
characters. Existing names are never overwritten.
