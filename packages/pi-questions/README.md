# pi-questions

Registers the LLM-callable `ask_user` tool for structured interactive questions.

Supported inputs:

- free text with optional advisory regular-expression validation
- single choice
- multiple choice
- file or directory selection

File inputs accept existing paths and paths that do not exist yet, such as a
new output file or directory. `fileKind` is checked when an existing path can
be inspected.

Validation is advisory: mismatched text and file inputs show warnings but never
disable submission. Blank inputs also never disable submission; `optional` only
controls whether an unanswered input is reported as skipped. Inputs support stable
IDs, defaults, optional answers, descriptions, and custom “Something else” choices.
Selecting “Something else” always opens its text editor; returning to it reopens the
previous text for editing, even after another option was selected. Choice options may
also be marked `recommended`; this adds a persistent “(recommended)” label without
selecting the option. Defaults remain separate because
they preselect answers. One call may contain up to ten inputs and fifty options per
choice input; individual text answers are limited to 16 KiB.

## Controls

Use `Tab` or `←` / `→` to switch inputs, `↑` / `↓` to move, and `Enter` or
`Space` to choose. On non-text question and picker surfaces, `q` cancels or goes
back (`Esc` remains a fallback). While editing an answer, path, custom choice, or
note, `q` remains ordinary text and `Esc` returns to the question.

The tool intentionally requires Pi's interactive TUI. Legacy IPC forwarding was
removed because it targeted the archived subprocess subagent system. A headless agent
receives a proper tool error and must continue with stated assumptions.
