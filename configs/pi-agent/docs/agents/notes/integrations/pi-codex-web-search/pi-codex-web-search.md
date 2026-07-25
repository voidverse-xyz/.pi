# Pi Codex web search

## Objective

Provide one LLM-callable Pi tool, `web_search`, that reuses the user's existing
ChatGPT-backed Codex login. Do not add a slash command, copy credentials, require
an OpenAI API key, or expose the active Pi repository to the nested Codex turn.

## Verified protocol

The implementation targets Codex app-server v2 as shipped in `rust-v0.145.0`:

- clients send `initialize`, then the `initialized` notification;
- `account/read` reports the active ChatGPT-backed account without returning a
  token;
- `thread/start` accepts an ephemeral thread, instruction overrides, config
  overrides, and experimental environment selection;
- an empty `environments` array disables execution environments;
- `turn/start` accepts another empty environment selection, read-only sandbox
  policy, `approvalPolicy: "never"`, and an output JSON schema;
- `item/completed` provides authoritative `webSearch` and `agentMessage` items;
- `turn/completed` terminates the request.

Primary references:

- [App-server lifecycle](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/README.md#l76-l145)
- [`ThreadStartParams`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L56-L142)
- [`TurnStartParams`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L71-L123)
- [App-server item lifecycle](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/README.md#l1447-l1493)
- [Codex native web-search extension](https://github.com/openai/codex/tree/rust-v0.145.0/codex-rs/ext/web-search)

## Process and data flow

Every tool call starts a separate `codex app-server --stdio` process:

1. Create an empty temporary working directory.
2. Initialize app-server with experimental v2 fields enabled.
3. Require server version 0.145.0 or newer from the initialization user agent.
4. Verify a ChatGPT-backed Codex login through `account/read`; an old-protocol
   `getAuthStatus` fallback requests status with `includeToken: false`.
5. Read token-free effective config through `config/read` and reject inherited
   MCP, hook, plugin, app, skill, or instruction configuration.
6. Start an ephemeral thread rooted in the empty directory and reject every
   reported instruction source before beginning a turn.
7. Start one structured-output turn containing only the explicit tool query.
8. Collect the final answer and provenance-tagged source metadata.
9. Terminate the process and remove the temporary directory on success, failure,
   timeout, or cancellation.

One process per call avoids cross-query history, simplifies cancellation, and
allows concurrent Pi searches without response multiplexing.

## Isolation and failure policy

The extension never automatically attaches Pi messages, repository paths,
repository files, or the Pi system prompt. The query remains LLM-authored, so no
code can prove the caller did not paste private content into that field; the tool
contract explicitly forbids local file content, secrets, credentials, private
paths, and unrelated conversation context. Defense in depth includes:

- an empty temporary `cwd`;
- `project_doc_max_bytes: 0`;
- `environments: []` on both the thread and turn;
- no selected capability roots or dynamic tools;
- a minimal subprocess environment, with optional dedicated
  `PI_CODEX_WEB_SEARCH_HOME` support;
- pre-turn rejection of inherited MCP, hook, plugin, app, skill, and instruction
  configuration and post-thread rejection of every instruction source;
- read-only sandboxing with local network disabled;
- `approvalPolicy: "never"` and automatic rejection of any server approval
  request;
- shell, unified execution, code mode, both multi-agent implementations,
  image generation, app, plugin, and tool-search features disabled through
  per-thread overrides;
- base and developer instructions that permit only native web search and treat
  page instructions as untrusted data;
- an allowlist limited to passive items, native `webSearch`, and the final agent
  message; every unknown or executable item terminates the subprocess before a
  subsequent model step;
- exact thread-id and turn-id matching on every accepted turn/item notification;
- fatal handling for every unexpected server-initiated request.

Native search still sends the explicit query and retrieved web context to
OpenAI. That outbound behavior is required and is documented in the package
README. No credential value is requested, logged, or returned to Pi.

## Tool contract

Input:

```json
{ "query": "A focused research question, up to 4,000 characters" }
```

Output is a concise Markdown answer with direct links. Success requires an
observed completed native web-search item and at least one normalized public
HTTP(S) source URL. URLs from structured web-search results are tagged
`retrieved`; URLs found only in Codex's final answer are tagged `reported` and
are never presented as authoritative retrieval results. Searches time out after 120
seconds, honor Pi turn cancellation, wait for subprocess exit before returning,
and use Pi's standard 50 KB / 2,000-line output cap.

## Compatibility and verification

The extension requires Codex 0.145.0 or newer, a verifiable clean effective
config, no inherited instruction sources, and app-server v2 `environments`. It
fails rather than falling back to a local execution environment or ordinary
configured tool surface when those checks cannot be proven.

Automated coverage uses a fake stdio app-server to verify:

- the initialization, account, isolated thread, and isolated turn sequence;
- structured and plain-text answer normalization;
- source deduplication and retrieved/reported provenance;
- version and login failure;
- inherited config and instruction-source refusal;
- allowlist-based rejection of known and future non-search items;
- early-notification/start-response races and exact thread/turn filtering;
- unexpected server-request rejection;
- malformed and oversized JSON-RPC records;
- blank structured answers, no-search answers, and missing-source answers;
- pre-start and active cancellation;
- timeout cleanup and SIGTERM-resistant subprocess escalation;
- missing executable diagnostics;
- ChatGPT-only authentication modes;
- query validation.

A real search cannot be exercised in environments where the Codex executable or
ChatGPT login is unavailable; extension loading and registration remain locally
verifiable without either.
