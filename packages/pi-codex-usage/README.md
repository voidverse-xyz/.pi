# pi-codex-usage

Shows Codex subscription usage from the local `codex app-server`.

- Publishes the shortest returned window through `setStatus()` for
  `pi-status-line`: five hours when Codex returns it, otherwise a longer window
  such as seven days.
- `/codex-usage` shows every returned window, plus the plan and credits.
- The footer segment appears only when `openai-codex` is active and Codex uses a
  ChatGPT subscription login.
- The app-server starts lazily and is not launched for other providers.
- No above-editor widget is created.

The status refreshes after turns, model changes, and every five minutes. It supports
both five-hour-plus-weekly responses and periods when Codex returns only the weekly
window. Missing CLI, auth, and app-server failures stay silent in the footer;
`/codex-usage` reports them.
