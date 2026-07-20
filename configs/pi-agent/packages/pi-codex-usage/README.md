# pi-codex-usage

Shows Codex subscription usage from the local `codex app-server`.

- Publishes the primary five-hour window through `setStatus()` for `pi-status-line`.
- `/codex-usage` shows the primary and weekly windows, plan, and credits.
- The footer segment appears only when `openai-codex` is active and Codex uses a
  ChatGPT subscription login.
- The app-server starts lazily and is not launched for other providers.
- No above-editor widget is created.

The status refreshes after turns, model changes, and every five minutes. Missing CLI,
auth, and app-server failures stay silent in the footer; `/codex-usage` reports them.
