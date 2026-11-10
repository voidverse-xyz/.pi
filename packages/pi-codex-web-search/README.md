# pi-codex-web-search

Adds an LLM-callable `web_search` tool to Pi. Each call starts an ephemeral local
`codex app-server` session, uses Codex's native server-side web search, and returns
a concise answer with direct source citations.

## Requirements

- `codex` installed on `PATH` (or set `CODEX_BIN` to the executable path)
- Codex 0.145.0 or newer
- Codex authenticated with a ChatGPT-backed login (`codex login`)

No separate OpenAI API key or second Codex login is required. Each call creates a
clean temporary Codex home and bridges only the existing authentication file
through a hard link or symbolic link. The extension never parses, logs, or
returns credential values, and token refreshes remain attached to the normal
Codex login instead of diverging into a stale search-only profile.

The login source defaults to `$HOME/.codex`. On Windows, it defaults to
`%USERPROFILE%\.codex` and uses `HOME` only as a fallback. An explicit
`CODEX_HOME` is honored, and `PI_CODEX_WEB_SEARCH_HOME` takes precedence when
the login lives elsewhere.
Configuration from that source home is not copied or loaded. On Windows, the
temporary runtime is placed in the selected Codex home so the authentication
file can be hard-linked on the same volume without requiring elevated symbolic
link permissions.

## Isolation and privacy

The extension automatically supplies only the tool's `query` string; it never
attaches the Pi conversation, project path, files, or system prompt. The query is
LLM-authored, so the extension cannot prove that its caller did not paste private
content into that field. Tool guidance explicitly forbids local file contents,
secrets, credentials, private paths, and unrelated conversation context.

Before starting a turn, the extension reads only Codex's token-free effective
configuration through app-server and fails closed if it finds MCP, hook, plugin,
app, skill, or instruction configuration. It also rejects any instruction source
reported by `thread/start`. Config values and account details are never returned
to Pi or the model.

Each search uses:

- a fresh empty temporary working directory and clean temporary Codex home;
- only a hard-linked or symlinked authentication file from the selected Codex home;
- isolated HOME, XDG, temporary, and Windows application-data directories;
- an ephemeral Codex thread;
- `environments: []` to remove local shell/file execution environments;
- read-only sandboxing and a `never` approval policy;
- no selected capability roots or dynamic tools;
- a minimal subprocess environment rather than the full Pi environment;
- disabled shell, code, multi-agent, image-generation, app, plugin, and
  tool-search feature families;
- instructions that allow only native web search;
- exact thread/turn correlation and an allowlist of passive item types plus
  native web search and agent messages;
- fatal handling for every unknown/executable item or server-initiated request.

The query and Codex's research context leave the machine for OpenAI's Codex
service. Web results are external, untrusted context.

## Behavior

`web_search` accepts one focused query (maximum 4,000 characters). A result is
accepted only after Codex completes at least one native web-search item and
returns at least one public HTTP(S) source URL. Codex synthesizes the answer with
Markdown citations. Source metadata records whether a URL came from a structured
retrieval result (`retrieved`) or only from Codex's final response (`reported`).
Uncited retrievals are labeled as not necessarily cited; model-reported URLs are
never relabeled as authoritative retrieval results.

Calls time out after two minutes and honor Pi's turn cancellation signal. The
extension confirms the Codex subprocess has exited before removing the temporary
directory or returning. Parallel Pi tool calls use separate Codex subprocesses.
Tool text uses Pi's standard 50 KB / 2,000-line output cap; complete source
metadata remains in tool details if the answer is truncated.

In Pi's interactive TUI, the tool has a durable custom renderer in the message
transcript. It shows the query, live Codex progress, retrieved source hostnames
and direct URLs, and an explicit completed or failed outcome. The compact view
shows up to three sources; expanding the tool output shows all sources with
provenance and available snippets. This is the existing tool-call transcript
row, not a toast, editor widget, or duplicate model-context message.

## Activation

This package is enabled through the repository's `agent/settings.json`. Run
`/reload` or restart Pi after changing it.

## Verification

```bash
node --experimental-strip-types --test \
  packages/pi-codex-web-search/test/*.test.ts
```
