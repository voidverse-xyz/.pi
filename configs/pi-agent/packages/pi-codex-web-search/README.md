# pi-codex-web-search

Adds an LLM-callable `web_search` tool to Pi. Each call starts an ephemeral local
`codex app-server` session, uses Codex's native server-side web search, and returns
a concise answer with direct source citations.

## Requirements

- `codex` installed on `PATH` (or set `CODEX_BIN` to the executable path)
- Codex 0.145.0 or newer
- Codex authenticated with a ChatGPT-backed login (`codex login`)
- No active Codex MCP servers, hooks, plugins, apps, skills, or inherited
  instruction sources in the selected Codex home

No separate OpenAI API key is required. The Pi extension never opens, parses,
copies, or returns Codex credential files; the spawned Codex process owns its
authentication and token refresh.

By default the process uses an isolated profile at `$HOME/.codex/web-search` so
normal Codex MCP, hook, plugin, app, skill, and instruction configuration cannot
leak into searches. The extension intentionally ignores a general `CODEX_HOME`
because that profile may contain unsafe inherited configuration;
`PI_CODEX_WEB_SEARCH_HOME` is the only supported override. Authenticate the
selected profile once with:

```bash
CODEX_HOME="$HOME/.codex/web-search" codex login
```

Use the same path in `PI_CODEX_WEB_SEARCH_HOME` when overriding the default.

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

- a fresh empty temporary working directory;
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

This package is enabled through the repository's root `settings.json`. Run
`/reload` or restart Pi after changing it.

## Verification

```bash
node --experimental-strip-types --test \
  configs/pi-agent/packages/pi-codex-web-search/test/*.test.ts
```
